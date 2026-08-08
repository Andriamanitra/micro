//go:build plan9 || nacl || windows || (js && wasm)

package action

func (*BufPane) Suspend() bool {
	InfoBar.Error("Suspend is only supported on BSD/Linux")
	return false
}
