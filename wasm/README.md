# micro in the browser (Go wasm)

This directory contains everything needed to run the micro editor in a web
browser. micro is compiled to WebAssembly (`GOOS=js GOARCH=wasm`), tcell's
screen is backed by a terminal emulator (xterm.js), and file I/O runs against
a virtual filesystem in the browser that is persisted to IndexedDB.

## Building

From the repository root:

    make build-wasm

This produces `wasm/main.wasm` (the compiled micro editor).

The `wasm/` directory contains the (vendored) JavaScript assets:

| File                | Origin                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `main.wasm`         | Build artifact (produced by `make build-wasm`)                          |
| `wasm_exec.js`      | From the Go toolchain: `$(go env GOROOT)/lib/wasm/wasm_exec.js`        |
| `xterm.js`          | xterm.js 5.3.0 UMD build (https://www.npmjs.com/package/xterm)          |
| `xterm.css`         | xterm.js 5.3.0 stylesheet                                              |
| `addon-fit.js`      | `@xterm/addon-fit` 0.10.0 UMD build                                    |

## Running

Serve the `wasm/` directory over HTTP (the wasm module is fetched, so a file://
URL will not work) and open the page:

    make serve-wasm

    # or manually
    python3 -m http.server 8000 -d wasm

Then open <http://localhost:8000/>.

## What works and what does not

Works:

- Editing, search/replace, multiple cursors, undo/redo, syntax highlighting,
  command bar, key bindings, plugins (embedded at build time).
- Saving files: buffers are written into the browser's virtual filesystem,
  which persists across page reloads via IndexedDB.
- "Open file": a plain `<input type="file">` imports a file from your computer
  into the virtual filesystem and opens it in micro.
- "Save to computer": a small chooser lists the files in the current directory
  and asks which one to save the current buffer into; the buffer is saved there
  and the file is downloaded to your computer (a `Blob` + `<a download>`).
  Neither flow uses the experimental File System Access API, so it works in
  Firefox and Chrome alike.
- Terminal resizing (via the fit addon).

Does not work:

- Reading from stdin (there is no stdin in the browser). micro always opens an
  empty buffer when started without file arguments.
- The shell (`sh`), `micro -plugin install/remove` (no network in the wasm
  sandbox), and any external program execution.
- Clipboard access beyond what the terminal emulator provides.

## How it fits together

- `cmd/micro/browser_setup.go` — wasm-only `init()`: sets up the browser
  environment (`HOME`, `TERM`, `MICRO_TRUECOLOR`) before `main()` runs.
- `tcell/tscreen_wasm.go` (inside the vendored `tcell/` module) — tcell's
  screen implementation for js/wasm. It forwards escape sequences to a
  `tcellWrite` function and receives input via a `tcellRead` function.
- `cmd/micro/wasm.go` — registers a `microCommand(cmd)` JS function so the
  page can run micro commands (used by the toolbar buttons).
- `wasm/micro.js` — installs the `fs`/`process`/`path` shims Go expects, the
  tcell bridge, and boots the wasm module.

## Implementation notes

- Go's `syscall` package on js/wasm expects a Node.js-style `fs` object on
  `globalThis.fs` with synchronous callbacks. `micro.js` provides that. All
  paths are normalized against a virtual home directory (`/home/user`).
- micro writes `settings.json`, `bindings.json`, etc. under
  `/home/user/.config/micro`; these persist in IndexedDB as well.
- The cursor is drawn by micro itself: on js/wasm the `fakecursor` setting
  defaults to true, so the native terminal cursor is hidden (`?25l`) and micro
  paints a reverse-video cell as its cursor. This avoids the xterm.js cursor
  rendering issue entirely.
- The "Reset filesystem" toolbar button clears the virtual filesystem, persists
  the empty tree to IndexedDB, and reloads the page.
