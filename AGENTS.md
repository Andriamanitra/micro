# AGENTS.md

micro is a terminal text editor: Go module `github.com/micro-editor/micro/v2` (note the `/v2` suffix — all internal imports use it).

## Build & test

- **Always build with `make build`, never plain `go build ./cmd/micro`.** `make build` runs `generate` first, then links version/hash info via ldflags and disables debug mode. A plain `go build` produces a binary with debug logging ON and version `0.0.0-unknown` (breaks the plugin manager).
- `make build-quick` — skip the generate step; `make build-dbg` — debug build; `make install` — installs to `$GOBIN`.
- `make test` runs `go test ./internal/...` then `go test ./cmd/...`. It does **not** cover `./pkg/...` or the root `./runtime` package (which contains `runtime_test.go`); run `go test ./...` to include them.
- Run a single test: `go test ./internal/buffer -run TestName`.
- CI (`test.yaml`) runs `make build` + `make test` on Go 1.19.x and 1.23.x across Linux/macOS/Windows. Keep `go 1.19` in `go.mod` compatible.

## Codegen

- `runtime/runtime.go` embeds the runtime assets (`//go:embed colorschemes help plugins syntax`) and has a `//go:generate` that runs `syntax/make_headers.go`.
- That tool converts each `runtime/syntax/*.yaml` into a sibling `*.hdr` file containing the filetype-detection regexes. The `.hdr` files are **gitignored (`*.hdr`) and never committed** — a fresh clone has none.
- **After editing or adding a syntax `.yaml` you must run `make generate`** (regenerates `.hdr`). The `.yaml` feeds highlighting rules; the `.hdr` feeds filetype detection, and both are needed at runtime. If you skip `make generate`, your syntax change won't take effect (and the build will silently miss detection).
- `internal/buffer/buffer_generated_test.go` is generated from VSCode model tests by `make testgen` (downloads files from GitHub, requires `tsc`/node). It says so in its header — **do not edit by hand**; change the generator (`tools/testgen.go`) instead.

## Architecture

- `cmd/micro` — entrypoint / main package; CLI flags, buffer loading, event loop.
- `internal/` — editor core: `action` (keybindings/commands), `buffer`, `config`, `display`, `screen`, `shell`, `views`, `clipboard`, `util`, `lua` (plugin Lua bindings).
- `pkg/highlight` — syntax highlighting engine; parses the `runtime/syntax/*.yaml` files.
- `runtime/` — embedded assets (colorschemes, help, plugins, syntax); embedded at build time, but users can override via `~/.config/micro`, so config-loading logic must handle both (see `internal/config/rtfiles.go`).

## Conventions & gotchas

- Uses **forked deps** — never swap in upstream versions: `github.com/micro-editor/tcell/v2`, `github.com/micro-editor/json5`, plus `replace` directives in `go.mod` for `go-shellquote` and `gopher-luar`.
- Builds are static (`CGO_ENABLED` defaults to 0 in the Makefile); macOS forces `CGO_ENABLED=1` with an Info.plist linker step. tcell limits platforms (no Plan9/Cygwin).
- `internal/util` holds `Version`, `CommitHash`, `Debug` as vars set via `-ldflags -X`.
- Version is computed from git tags (`tools/build-version.go`), so `make build` requires an intact git history; CI checks out with `fetch-depth: 0` and tags.
- Benchmarks: `make bench` (needs `benchstat`), `make bench-baseline`/`bench-compare` for comparisons.
