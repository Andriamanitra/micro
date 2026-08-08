//go:build js && wasm

package main

// initSignals is a no-op on js/wasm: the browser never delivers Unix signals,
// and the syscall.SIG* constants are only partially defined there.
func initSignals() {}
