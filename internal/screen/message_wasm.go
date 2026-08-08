//go:build js && wasm

package screen

import (
	"fmt"
	"log"
)

// TermMessage sends a message to the user. In the browser there is no stdin
// to wait on, so the message is just written to the log (which the wasm
// runtime forwards to the JS console).
func TermMessage(msg ...any) {
	log.Println(msg...)
}

// TermPrompt prints a prompt and requests the user for a response. There is
// no stdin in the browser, so we always report "no match" (an index of -1).
func TermPrompt(prompt string, options []string, wait bool) int {
	fmt.Println(prompt)
	return -1
}

// TermError sends an error to the user. See TermMessage.
func TermError(filename string, lineNum int, err string) {
	TermMessage(filename, lineNum, err)
}
