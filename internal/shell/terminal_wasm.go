//go:build js && wasm
// +build js,wasm

// Terminal emulation is not supported in the browser. This stub keeps the
// shell package (and the code that embeds shell.Terminal in panes/windows)
// compiling for js/wasm; the terminal pane is disabled via TermEmuSupported.
package shell

import (
	"errors"

	"github.com/micro-editor/micro/v2/internal/buffer"
	"github.com/micro-editor/terminal"
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

// browserVT mirrors the bits of terminal.VT that the terminal pane uses so
// that termpane/termwindow code compiles on js/wasm. It is never created.
type browserVT struct{}

func (v *browserVT) Resize(width, height int) {}

// A Terminal holds information for the terminal emulator
type Terminal struct {
	State     terminal.State
	Term      *browserVT
	title     string
	Status    TermType
	Selection [2]buffer.Loc
}

// HasSelection returns whether this terminal has a valid selection
func (t *Terminal) HasSelection() bool {
	return t.Selection[0] != t.Selection[1]
}

func (t *Terminal) Name() string {
	return t.title
}

// GetSelection returns the selected text
func (t *Terminal) GetSelection(width int) string {
	return ""
}

// Start begins a new command in this terminal with a given view
func (t *Terminal) Start(execCmd []string, getOutput bool, wait bool, callback func(out string, userargs []any), userargs []any) error {
	return errors.New("Terminal emulator is not supported in the browser")
}

// Stop stops execution of the terminal and sets the Status
// to TTDone
func (t *Terminal) Stop() {}

// Close sets the Status to TTClose indicating that the terminal
// is done and should be closed
func (t *Terminal) Close() {}

// WriteString writes a given string to this terminal's pty
func (t *Terminal) WriteString(str string) {}
