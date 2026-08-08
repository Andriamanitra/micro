//go:build !js || !wasm

package main

import (
	"os/signal"
	"syscall"

	"github.com/micro-editor/micro/v2/internal/util"
)

// initSignals registers the signals that shut micro down. On js/wasm these
// constants are not all available and the browser runtime does not deliver
// signals anyway, so a no-op variant lives in signals_wasm.go.
func initSignals() {
	signal.Notify(util.Sigterm, syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGABRT)
	signal.Notify(sighup, syscall.SIGHUP)
}
