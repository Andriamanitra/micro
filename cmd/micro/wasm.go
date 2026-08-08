//go:build js && wasm

package main

import (
	"syscall/js"

	"github.com/micro-editor/micro/v2/internal/action"
)

// microCmdFunc must be kept alive for the whole lifetime of the program,
// otherwise the Go runtime will release it.
var microCmdFunc js.Func

func init() {
	microCmdFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].Type() != js.TypeString {
			return nil
		}
		cmd := args[0].String()
		// timerChan is consumed by DoEvent on the main goroutine, which
		// guarantees that the command runs on the event loop.
		timerChan <- func() {
			if pane := action.MainTab().CurPane(); pane != nil {
				pane.HandleCommand(cmd)
			}
		}
		return nil
	})
	js.Global().Set("microCommand", microCmdFunc)
}
