package shell

import (
	"bytes"
	"os"
	"os/exec"
	"strconv"
	"sync"

	"github.com/creack/pty"
	"github.com/micro-editor/micro/v2/internal/buffer"
	"github.com/micro-editor/micro/v2/internal/screen"
	"go.mitchellh.com/libghostty"
)

type TermType int
type CallbackFunc func(string)

const (
	TTClose   = iota // Should be closed
	TTRunning        // Currently running a command
	TTDone           // Finished running a command
)

var CloseTerms chan bool

func init() {
	CloseTerms = make(chan bool)
}

// A Terminal holds information for the terminal emulator
type Terminal struct {
	mu     sync.Mutex
	term   *libghostty.Terminal
	rs     *libghostty.RenderState
	rowIt  *libghostty.RenderStateRowIterator
	cells  *libghostty.RenderStateRowCells
	pty    *os.File
	closed bool
	cols   int
	rows   int
	title  string
	Status TermType
	// Selection is the selection range in terminal cells.
	Selection [2]buffer.Loc
	wait      bool
	getOutput bool
	output    *bytes.Buffer
	callback  CallbackFunc
}

// HasSelection returns whether this terminal has a valid selection
func (t *Terminal) HasSelection() bool {
	return t.Selection[0] != t.Selection[1]
}

func (t *Terminal) Name() string {
	return t.title
}

// CellFunc is called for every visible cell in the terminal.
// ch is only valid for the duration of the call.
type CellFunc func(x, y int, ch []byte, style *libghostty.Style)

// Render updates the terminal's render state and calls fn for every
// visible cell. It must not be called from within the terminal's
// effect callbacks.
func (t *Terminal) Render(fn CellFunc) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.term == nil || t.rs == nil || t.rowIt == nil || t.cells == nil {
		return
	}
	if err := t.rs.Update(t.term); err != nil {
		return
	}
	if err := t.rs.RowIterator(t.rowIt); err != nil {
		return
	}

	var text []byte
	for t.rowIt.Next() {
		y, err := t.rowIt.ViewportY()
		if err != nil || y < 0 || int(y) >= t.rows {
			continue
		}
		if err := t.rowIt.Cells(t.cells); err != nil {
			continue
		}
		for x := 0; x < t.cols; x++ {
			if err := t.cells.Select(uint16(x)); err != nil {
				continue
			}
			text = text[:0]
			text, err = t.cells.AppendGraphemes(text)
			if err != nil {
				continue
			}
			style, err := t.cells.Style()
			if err != nil {
				continue
			}
			fn(x, int(y), text, style)
		}
	}
	t.rs.Clean()
}

// GetSelection returns the selected text
func (t *Terminal) GetSelection(width int) string {
	start := t.Selection[0]
	end := t.Selection[1]
	if start.GreaterThan(end) {
		start, end = end, start
	}
	var ret []byte
	t.Render(func(x, y int, ch []byte, style *libghostty.Style) {
		l := buffer.Loc{X: x, Y: y}
		if l.GreaterEqual(start) && l.LessThan(end) {
			if len(ch) == 0 {
				ret = append(ret, ' ')
			} else {
				ret = append(ret, ch...)
			}
		}
	})
	return string(ret)
}

// ResizeTerminal resizes the terminal and its pseudo-terminal.
func (t *Terminal) ResizeTerminal(width, height int) {
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	t.cols, t.rows = width, height
	if t.term != nil {
		_ = t.term.Resize(uint16(width), uint16(height), 0, 0)
	}
	if t.pty != nil {
		_ = pty.Setsize(t.pty, &pty.Winsize{Cols: uint16(width), Rows: uint16(height)})
	}
}

// Cursor returns the terminal cursor position and visibility.
func (t *Terminal) Cursor() (x, y int, visible bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.term == nil {
		return 0, 0, false
	}
	cx, err := t.term.CursorX()
	if err != nil {
		return 0, 0, false
	}
	cy, err := t.term.CursorY()
	if err != nil {
		return 0, 0, false
	}
	visible, _ = t.term.CursorVisible()
	return int(cx), int(cy), visible
}

// MouseTracking reports whether the program running in the terminal has
// requested mouse events.
func (t *Terminal) MouseTracking() bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.term == nil {
		return false
	}
	tracking, _ := t.term.MouseTracking()
	return tracking
}

// Start begins a new command in this terminal with a given view
func (t *Terminal) Start(execCmd []string, getOutput bool, wait bool, callback func(out string, userargs []any), userargs []any) error {
	if len(execCmd) <= 0 {
		return nil
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	term, err := libghostty.NewTerminal(
		libghostty.WithSize(80, 24),
		libghostty.WithWritePty(func(_ *libghostty.Terminal, data []byte) {
			if t.pty != nil {
				_, _ = t.pty.Write(data)
			}
		}),
	)
	if err != nil {
		return err
	}
	rs, err := libghostty.NewRenderState()
	if err != nil {
		term.Close()
		return err
	}
	rowIt, err := libghostty.NewRenderStateRowIterator()
	if err != nil {
		rs.Close()
		term.Close()
		return err
	}
	cells, err := libghostty.NewRenderStateRowCells()
	if err != nil {
		rowIt.Close()
		rs.Close()
		term.Close()
		return err
	}

	cmd := exec.Command(execCmd[0], execCmd[1:]...)
	t.output = nil
	if getOutput {
		t.output = bytes.NewBuffer([]byte{})
		cmd.Stdout = t.output
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		cells.Close()
		rowIt.Close()
		rs.Close()
		term.Close()
		return err
	}

	t.term = term
	t.rs = rs
	t.rowIt = rowIt
	t.cells = cells
	t.pty = ptmx
	t.closed = false
	t.cols = 80
	t.rows = 24
	t.getOutput = getOutput
	t.Status = TTRunning
	t.title = execCmd[0] + ":" + strconv.Itoa(cmd.Process.Pid)
	t.wait = wait
	t.callback = func(out string) {
		callback(out, userargs)
	}

	go t.readLoop(ptmx)

	return nil
}

func (t *Terminal) readLoop(ptmx *os.File) {
	buf := make([]byte, 32*1024)
	for {
		n, err := ptmx.Read(buf)
		if n > 0 {
			t.mu.Lock()
			if t.term != nil {
				t.term.VTWrite(buf[:n])
			}
			t.mu.Unlock()
			screen.Redraw()
		}
		if err != nil {
			t.mu.Lock()
			if t.term != nil && !t.closed {
				t.term.VTWrite([]byte("\r\nPress enter to close"))
			}
			t.mu.Unlock()
			screen.Redraw()
			break
		}
	}
	t.Stop()
}

// Stop stops execution of the terminal and sets the Status
// to TTDone
func (t *Terminal) Stop() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	if t.pty != nil {
		_ = t.pty.Close()
		t.pty = nil
	}
	t.mu.Unlock()

	if t.wait {
		t.Status = TTDone
	} else {
		t.Close()
		CloseTerms <- true
	}
}

// Close sets the Status to TTClose indicating that the terminal
// is done and should be closed
func (t *Terminal) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.closeResources()
	t.mu.Unlock()

	t.Status = TTClose

	// call the lua function that the user has given as a callback
	if t.getOutput {
		if t.callback != nil {
			Jobs <- JobFunction{
				Function: func(out string, args []any) {
					t.callback(out)
				},
				Output: t.output.String(),
				Args:   nil,
			}
		}
	}
}

func (t *Terminal) closeResources() {
	if t.pty != nil {
		_ = t.pty.Close()
		t.pty = nil
	}
	if t.cells != nil {
		t.cells.Close()
		t.cells = nil
	}
	if t.rowIt != nil {
		t.rowIt.Close()
		t.rowIt = nil
	}
	if t.rs != nil {
		t.rs.Close()
		t.rs = nil
	}
	if t.term != nil {
		t.term.Close()
		t.term = nil
	}
}

// WriteString writes a given string to this terminal's pty
func (t *Terminal) WriteString(str string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.pty != nil {
		_, _ = t.pty.WriteString(str)
	}
}
