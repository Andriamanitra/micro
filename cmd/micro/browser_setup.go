//go:build js && wasm

package main

import "os"

// init sets up the process environment for the browser. There is no real
// filesystem or terminal in the browser, so micro is given a virtual home
// directory and a terminal type that the wasm JS host (see wasm/) provides:
//
//   - HOME points at a virtual home inside the browser filesystem shim so
//     that the config directory logic (~/.config/micro) works as usual.
//   - TERM selects the xterm-256color terminfo entry which the wasm screen
//     renders with.
//   - MICRO_TRUECOLOR enables 24-bit color output which xterm.js supports.
func init() {
	os.Setenv("HOME", "/home/user")
	os.Setenv("TERM", "xterm-256color")
	os.Setenv("MICRO_TRUECOLOR", "1")
}
