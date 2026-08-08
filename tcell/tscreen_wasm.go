//go:build js && wasm
// +build js,wasm

// Copyright 2026 The Micro Editor Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package tcell

import (
	"errors"
	"io"
	"sync"
	"syscall/js"
)

// This file provides the platform specific bits of tScreen for the
// GOOS=js / GOARCH=wasm target. The screen renders into a terminal
// emulator (xterm.js) running in the browser: tScreen computes the usual
// ANSI/terminfo escape sequences and the browserTty forwards them to a
// JS `tcellWrite` function, while input typed into the terminal is pushed
// back into tScreen through a JS `tcellRead` function. Resize notifications
// arrive through a JS `tcellResize` function. See the wasm/ directory of
// the micro editor for the corresponding JavaScript host.
//
// The JavaScript host must install the following globals before the Go
// module starts (i.e. before go.run):
//
//	tcellWrite(data: Uint8Array)   — receives the escape sequence stream
//	tcellWindowSize() -> {cols, rows, pixelWidth, pixelHeight}
//	tcellBell()                    — optional, audible alert
//	tcellRead(data)                — installed by this file, call it with
//	                                 the raw bytes the terminal produces
//	tcellResize()                  — installed by this file, call it when
//	                                 the terminal window is resized
func init() {
	wasmScreen = &wasmHost{}
}

// wasmHost keeps track of the currently active tScreen so that the
// JavaScript callbacks installed by termioInit can reach it.
var wasmScreen *wasmHost

type wasmHost struct {
	mu  sync.Mutex
	t   *tScreen
	tty *browserTty
}

// browserTty bridges the io.Reader/io.Writer interface that tScreen expects
// with the JavaScript terminal host running in the browser.
type browserTty struct {
	mu      sync.Mutex
	cond    *sync.Cond
	started bool
	closed  bool
	input   []byte

	writeFunc  js.Value
	sizeFunc   js.Value
	bellFunc   js.Value
	closeFuncs []js.Func
}

func newBrowserTty() *browserTty {
	t := &browserTty{}
	t.cond = sync.NewCond(&t.mu)
	return t
}

// Start locates the JavaScript functions provided by the host and installs
// the callbacks used to deliver input and resize events to Go.
func (t *browserTty) Start() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.started {
		return nil
	}

	global := js.Global()
	t.writeFunc = global.Get("tcellWrite")
	t.sizeFunc = global.Get("tcellWindowSize")
	t.bellFunc = global.Get("tcellBell")
	if t.writeFunc.Type() != js.TypeFunction || t.sizeFunc.Type() != js.TypeFunction {
		return errors.New("tcell wasm terminal host is not installed (tcellWrite/tcellWindowSize missing)")
	}

	onData := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) == 0 {
			return nil
		}
		if args[0].InstanceOf(global.Get("Uint8Array")) {
			data := make([]byte, args[0].Get("byteLength").Int())
			js.CopyBytesToGo(data, args[0])
			t.enqueue(data)
		} else {
			t.enqueue([]byte(args[0].String()))
		}
		return nil
	})
	onResize := js.FuncOf(func(this js.Value, args []js.Value) any {
		wasmScreen.mu.Lock()
		t := wasmScreen.t
		wasmScreen.mu.Unlock()
		if t != nil {
			select {
			case t.sigwinch <- nil:
			default:
			}
		}
		return nil
	})
	t.closeFuncs = []js.Func{onData, onResize}
	global.Set("tcellRead", onData)
	global.Set("tcellResize", onResize)

	t.started = true
	t.closed = false
	return nil
}

// Stop removes the callbacks installed by Start.
func (t *browserTty) Stop() error {
	t.mu.Lock()
	t.started = false
	funcs := t.closeFuncs
	t.closeFuncs = nil
	t.cond.Broadcast()
	t.mu.Unlock()

	js.Global().Set("tcellRead", js.Undefined())
	js.Global().Set("tcellResize", js.Undefined())
	for _, fn := range funcs {
		fn.Release()
	}
	return nil
}

// Read blocks until input is available from the terminal, or until the tty
// is closed (in which case io.EOF is returned to shut down the input loop).
func (t *browserTty) Read(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	for len(t.input) == 0 && !t.closed && t.started {
		t.cond.Wait()
	}
	if t.closed {
		return 0, io.EOF
	}
	if len(t.input) == 0 {
		return 0, io.EOF
	}
	n := copy(b, t.input)
	t.input = t.input[n:]
	return n, nil
}

// Write forwards a chunk of escape sequences to the JavaScript host.
func (t *browserTty) Write(b []byte) (int, error) {
	t.mu.Lock()
	writeFunc := t.writeFunc
	started := t.started
	t.mu.Unlock()
	if !started || writeFunc.Type() != js.TypeFunction {
		return 0, io.ErrClosedPipe
	}

	data := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(data, b)
	writeFunc.Invoke(data)
	return len(b), nil
}

func (t *browserTty) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.started = false
	t.cond.Broadcast()
	t.mu.Unlock()

	return t.Stop()
}

func (t *browserTty) enqueue(data []byte) {
	t.mu.Lock()
	if t.started && !t.closed {
		t.input = append(t.input, data...)
		t.cond.Broadcast()
	}
	t.mu.Unlock()
}

// termioInit is called by tScreen.Init and replaces the termios setup used
// on unix platforms with the browser bridge.
func (t *tScreen) termioInit() error {
	tty := newBrowserTty()
	if err := tty.Start(); err != nil {
		return err
	}

	t.in = tty
	t.out = tty

	wasmScreen.mu.Lock()
	wasmScreen.t = t
	wasmScreen.tty = tty
	wasmScreen.mu.Unlock()

	return nil
}

func (t *tScreen) termioFini() {
	wasmScreen.mu.Lock()
	tty := wasmScreen.tty
	wasmScreen.t = nil
	wasmScreen.tty = nil
	wasmScreen.mu.Unlock()

	if tty != nil {
		tty.Close()
	}
}

func (t *tScreen) getWinSize() (int, int, error) {
	wasmScreen.mu.Lock()
	tty := wasmScreen.tty
	wasmScreen.mu.Unlock()

	var width, height int
	if tty == nil {
		width, height = 80, 24
	} else {
		tty.mu.Lock()
		sizeFunc := tty.sizeFunc
		tty.mu.Unlock()
		if sizeFunc.Type() != js.TypeFunction {
			width, height = 80, 24
		} else {
			size := sizeFunc.Invoke()
			width = size.Get("cols").Int()
			height = size.Get("rows").Int()
		}
	}
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	return width, height, nil
}

// Beep sounds the terminal bell. We route it through the JavaScript host so
// that the browser can play an actual sound.
func (t *tScreen) Beep() error {
	wasmScreen.mu.Lock()
	tty := wasmScreen.tty
	wasmScreen.mu.Unlock()

	if tty != nil {
		tty.mu.Lock()
		bellFunc := tty.bellFunc
		tty.mu.Unlock()
		if bellFunc.Type() == js.TypeFunction {
			bellFunc.Invoke()
			return nil
		}
	}
	return nil
}
