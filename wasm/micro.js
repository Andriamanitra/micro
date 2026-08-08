// micro.js
//
// Boots the micro editor (a Go wasm binary) inside an xterm.js terminal.
//
// Responsibilities:
//   1. Install a Node.js-compatible `fs` shim (globalThis.fs) that Go's
//      js/wasm syscall package talks to. All file I/O happens against a
//      virtual filesystem held in memory and persisted to IndexedDB.
//   2. Provide process/path shims and a virtual home directory.
//   3. Bridge tcell's wasm screen to xterm.js:
//        tcellWrite(data)        <-  Go -> xterm.js
//        tcellWindowSize()       <-  Go asks for terminal size
//        tcellBell()             <-  Go asks for an audible alert
//        tcellRead(data)         ->  xterm.js -> Go (installed by Go)
//        tcellResize()           ->  browser -> Go (installed by Go)
//   4. Load and run main.wasm.

"use strict";

const WASM_FILE = "main.wasm";
const HOME_DIR = "/home/user";

const textDecoder = new TextDecoder("utf-8");

// ---------------------------------------------------------------------------
// Virtual filesystem
// ---------------------------------------------------------------------------

// Node.js fs.open flag values (Linux). Go's syscall.Open translates its own
// flags into these using the `constants` object it reads off globalThis.fs.
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 64;
const O_EXCL = 128;
const O_TRUNC = 512;
const O_APPEND = 1024;
const O_DIRECTORY = 65536;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

// Path -> { type: "dir" } | { type: "file", data: Uint8Array }
// Paths are always absolute and normalized (no trailing slash, no "..").
const nodes = new Map();

let cwd = HOME_DIR;

function normalize(p) {
  p = String(p);
  if (p.startsWith("/")) {
    // absolute already
  } else if (p.startsWith("~")) {
    p = HOME_DIR + p.slice(1);
  } else {
    p = cwd + "/" + p;
  }
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function parentOf(path) {
  if (path === "/") return "/";
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function ensureParents(path) {
  const parent = parentOf(path);
  if (parent === path) return;
  if (!nodes.has(parent)) ensureParents(parent);
  if (!nodes.has(parent)) nodes.set(parent, { type: "dir" });
}

function makeErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function makeStats(node) {
  const isDir = node.type === "dir";
  const size = isDir ? 0 : node.data.length;
  const mtime = node.mtime || 0;
  return {
    dev: 1,
    ino: 1,
    mode: isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644,
    nlink: isDir ? 2 : 1,
    uid: 1000,
    gid: 1000,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atimeMs: mtime,
    mtimeMs: mtime,
    ctimeMs: mtime,
    isDirectory() {
      return isDir;
    },
  };
}

function listDirNames(path) {
  const prefix = path === "/" ? "/" : path + "/";
  const names = new Set();
  for (const p of nodes.keys()) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      const first = rest.split("/")[0];
      if (first) names.add(first);
    }
  }
  return Array.from(names);
}

// --- persistence (IndexedDB) ----------------------------------------------

let idbPromise = null;
function idbOpen() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("micro-wasm", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("fs");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("fs", "readwrite");
    tx.objectStore("fs").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("fs", "readonly");
    const req = tx.objectStore("fs").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function serializeTree() {
  const files = {};
  const dirs = {};
  for (const [path, node] of nodes) {
    if (path === "/") continue;
    if (node.type === "dir") dirs[path] = true;
    else files[path] = node.data;
  }
  return { files, dirs };
}

function restoreTree(obj) {
  nodes.clear();
  nodes.set("/", { type: "dir" });
  for (const d of Object.keys(obj.dirs || {})) {
    nodes.set(d, { type: "dir" });
  }
  for (const f of Object.keys(obj.files || {})) {
    ensureParents(f);
    nodes.set(f, { type: "file", data: new Uint8Array(obj.files[f]) });
  }
  nodes.set("/", { type: "dir" });
}

let persistTimer = null;
function markDirty() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await idbSet("vfs", serializeTree());
    } catch (e) {
      console.warn("micro wasm: failed to persist virtual filesystem", e);
    }
  }, 400);
}

async function loadPersisted() {
  try {
    const obj = await idbGet("vfs");
    if (obj) restoreTree(obj);
  } catch (e) {
    console.warn("micro wasm: failed to load virtual filesystem", e);
  }
}

// Delete every file and directory in the virtual filesystem, persist the empty
// tree, and reload the page so micro boots against a clean filesystem.
async function resetFilesystem() {
  if (
    globalThis.confirm &&
    !globalThis.confirm(
      "Delete every file in the virtual filesystem? This cannot be undone."
    )
  ) {
    return;
  }
  nodes.clear();
  nodes.set("/", { type: "dir" });
  nodes.set(HOME_DIR, { type: "dir" });
  cwd = HOME_DIR;
  try {
    await idbSet("vfs", serializeTree());
  } catch (e) {
    console.warn("micro wasm: failed to persist reset filesystem", e);
  }
  showToast("Filesystem reset");
  setTimeout(() => {
    if (window.location && typeof window.location.reload === "function") {
      window.location.reload();
    }
  }, 300);
}

// --- "Save to computer" (download) -------------------------------------------
// Saving to the user's computer works by writing the buffer into the virtual
// filesystem and then triggering a browser download of that file. Unlike the
// File System Access API this works in every browser.

// List the entries (files and directories) directly inside a directory.
function listDirEntries(dirPath) {
  const prefix = dirPath === "/" ? "/" : dirPath + "/";
  const seen = new Map();
  for (const p of nodes.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split("/")[0];
    if (!first || seen.has(first)) continue;
    const full = dirPath === "/" ? "/" + first : dirPath + "/" + first;
    const node = nodes.get(full);
    seen.set(first, { name: first, isDir: !!(node && node.type === "dir") });
  }
  return Array.from(seen.values());
}

// Download the virtual file at `path` to the user's computer.
function downloadFile(path) {
  const node = nodes.get(path);
  if (!node || node.type === "dir") {
    showToast("File not found: " + path);
    return;
  }
  const name = path.split("/").pop() || "micro.txt";
  const blob = new Blob([node.data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast("Saved \u201c" + name + "\u201d to your computer");
}

// --- the fs shim ------------------------------------------------------------

const fds = new Map(); // fd -> { path, flags, pos, append }
let nextFd = 3;

const fsShim = {
  constants: {
    O_WRONLY,
    O_RDWR,
    O_CREAT,
    O_TRUNC,
    O_APPEND,
    O_EXCL,
    O_DIRECTORY,
  },

  open(path, flags, mode, callback) {
    path = normalize(path);
    const node = nodes.get(path);
    if (!node) {
      if (!(flags & O_CREAT)) return callback(makeErr("ENOENT"));
      ensureParents(path);
      if (flags & O_DIRECTORY) {
        nodes.set(path, { type: "dir" });
      } else {
        nodes.set(path, { type: "file", data: new Uint8Array(0) });
      }
    }
    const n = nodes.get(path);
    if (n.type === "dir") {
      if (flags & (O_WRONLY | O_RDWR)) return callback(makeErr("EISDIR"));
      // O_DIRECTORY is satisfied
    } else {
      if (flags & O_TRUNC) {
        n.data = new Uint8Array(0);
        n.mtime = Date.now();
        markDirty();
      }
    }
    const fd = nextFd++;
    fds.set(fd, {
      path,
      flags,
      pos: 0,
      append: !!(flags & O_APPEND),
    });
    callback(null, fd);
  },

  close(fd, callback) {
    fds.delete(fd);
    callback(null);
  },

  read(fd, buffer, offset, length, position, callback) {
    if (fd === 0) {
      // stdin is never available in the browser
      callback(null, 0);
      return;
    }
    const f = fds.get(fd);
    if (!f) return callback(makeErr("EBADF"));
    const node = nodes.get(f.path);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type === "dir") return callback(makeErr("EISDIR"));
    const pos = position === null ? f.pos : position;
    if (pos >= node.data.length) {
      callback(null, 0);
      return;
    }
    const n = Math.min(length, node.data.length - pos);
    buffer.set(node.data.subarray(pos, pos + n), offset);
    f.pos = pos + n;
    callback(null, n);
  },

  write(fd, buffer, offset, length, position, callback) {
    if (fd === 1 || fd === 2) {
      // stdout/stderr: micro's log messages go to the browser console
      consoleWrite(fd === 2 ? "error" : "log", buffer.subarray(offset, offset + length));
      callback(null, length);
      return;
    }
    const f = fds.get(fd);
    if (!f) return callback(makeErr("EBADF"));
    const node = nodes.get(f.path);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type === "dir") return callback(makeErr("EISDIR"));

    let pos;
    if (f.append) {
      pos = node.data.length;
    } else if (position === null) {
      pos = f.pos;
    } else {
      pos = position;
    }
    const chunk = buffer.subarray(offset, offset + length);
    if (pos + chunk.length > node.data.length) {
      const grown = new Uint8Array(pos + chunk.length);
      if (pos > 0) grown.set(node.data.subarray(0, Math.min(pos, node.data.length)));
      node.data = grown;
    }
    node.data.set(chunk, pos);
    f.pos = pos + chunk.length;
    node.mtime = Date.now();
    markDirty();
    callback(null, chunk.length);
  },

  readdir(path, callback) {
    path = normalize(path);
    const node = nodes.get(path);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type !== "dir") return callback(makeErr("ENOTDIR"));
    callback(null, listDirNames(path));
  },

  stat(path, callback) {
    path = normalize(path);
    const node = nodes.get(path);
    if (!node) return callback(makeErr("ENOENT"));
    callback(null, makeStats(node));
  },

  lstat(path, callback) {
    return fsShim.stat(path, callback);
  },

  fstat(fd, callback) {
    const f = fds.get(fd);
    if (!f) return callback(makeErr("EBADF"));
    const node = nodes.get(f.path);
    if (!node) return callback(makeErr("ENOENT"));
    callback(null, makeStats(node));
  },

  mkdir(path, mode, callback) {
    path = normalize(path);
    if (nodes.has(path)) return callback(makeErr("EEXIST"));
    ensureParents(path);
    nodes.set(path, { type: "dir" });
    markDirty();
    callback(null);
  },

  unlink(path, callback) {
    path = normalize(path);
    const node = nodes.get(path);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type === "dir") return callback(makeErr("EISDIR"));
    nodes.delete(path);
    markDirty();
    callback(null);
  },

  rmdir(path, callback) {
    path = normalize(path);
    const node = nodes.get(path);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type !== "dir") return callback(makeErr("ENOTDIR"));
    if (listDirNames(path).length > 0) return callback(makeErr("ENOTEMPTY"));
    nodes.delete(path);
    markDirty();
    callback(null);
  },

  rename(from, to, callback) {
    from = normalize(from);
    to = normalize(to);
    const node = nodes.get(from);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type === "dir") {
      // move the subtree (paths are absolute keys)
      const moves = [];
      for (const p of nodes.keys()) {
        if (p === from || p.startsWith(from + "/")) moves.push(p);
      }
      for (const p of moves) {
        const q = to + p.slice(from.length);
        nodes.set(q, nodes.get(p));
        nodes.delete(p);
      }
    } else {
      ensureParents(to);
      nodes.set(to, node);
      nodes.delete(from);
    }
    markDirty();
    callback(null);
  },

  truncate(path, length, callback) {
    path = normalize(path);
    const node = nodes.get(path);
    if (!node) return callback(makeErr("ENOENT"));
    if (node.type === "dir") return callback(makeErr("EISDIR"));
    const l = Math.max(0, length);
    if (l < node.data.length) {
      node.data = node.data.subarray(0, l);
    } else if (l > node.data.length) {
      const grown = new Uint8Array(l);
      grown.set(node.data);
      node.data = grown;
    }
    node.mtime = Date.now();
    markDirty();
    callback(null);
  },

  ftruncate(fd, length, callback) {
    const f = fds.get(fd);
    if (!f) return callback(makeErr("EBADF"));
    fsShim.truncate(f.path, length, callback);
  },

  chmod(path, mode, callback) {
    callback(null);
  },
  fchmod(fd, mode, callback) {
    callback(null);
  },
  chown(path, uid, gid, callback) {
    callback(null);
  },
  fchown(fd, uid, gid, callback) {
    callback(null);
  },
  utimes(path, atime, mtime, callback) {
    callback(null);
  },
  link(path, link, callback) {
    callback(makeErr("EPERM"));
  },
  symlink(path, link, callback) {
    callback(makeErr("EPERM"));
  },
  readlink(path, callback) {
    callback(makeErr("EINVAL"));
  },
  fsync(fd, callback) {
    callback(null);
  },
};

let consoleBuf = {};
function consoleWrite(level, bytes) {
  let text;
  try {
    text = textDecoder.decode(bytes);
  } catch (e) {
    text = String(bytes);
  }
  const buf = (consoleBuf[level] = (consoleBuf[level] || "") + text);
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    consoleBuf[level] = buf.slice(idx + 1);
    if (level === "error") console.error(line);
    else console.log(line);
  }
}

// --- process / path shims ----------------------------------------------------

globalThis.process = {
  getuid: () => 1000,
  getgid: () => 1000,
  geteuid: () => 1000,
  getegid: () => 1000,
  getgroups: () => [],
  pid: 1,
  ppid: 1,
  umask: () => 0o022,
  cwd: () => cwd,
  chdir: (d) => {
    cwd = normalize(d);
  },
  env: {},
  argv: [],
  version: "",
  versions: {},
  nextTick: (f) => setTimeout(f, 0),
};

globalThis.path = {
  resolve(...segments) {
    let p = "";
    for (const s of segments) {
      if (!s) continue;
      if (s.startsWith("/")) p = s;
      else p = p ? p + "/" + s : s;
    }
    return normalize(p);
  },
};

globalThis.fs = fsShim;

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

let term = null;
let fitAddon = null;

function initTerminal() {
  const XtermClass =
    (window.Xterm && window.Xterm.Terminal) || window.Terminal || null;
  if (XtermClass) {
    term = new XtermClass({
      cursorBlink: true,
      fontFamily:
        'Menlo, Monaco, Consolas, "Courier New", "DejaVu Sans Mono", monospace',
      fontSize: 14,
      scrollback: 2000,
      allowProposedApi: true,
      theme: {
        background: "#101216",
        foreground: "#d8dee9",
        cursor: "#a3be8c",
        selection: "#4c566a",
      },
    });
  } else {
    throw new Error("xterm.js is not loaded (window.Terminal missing)");
  }

  const FitAddonClass =
    (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon || null;
  if (FitAddonClass) {
    fitAddon = new FitAddonClass();
    term.loadAddon(fitAddon);
  }

  term.open(document.getElementById("terminal"));
  if (fitAddon) fitAddon.fit();
  term.focus();

  // Input: forward everything the terminal produces to Go.
  term.onData((data) => {
    if (globalThis.tcellRead) globalThis.tcellRead(data);
  });

  // Resize: when xterm's buffer resizes, wake tcell so it re-queries.
  term.onResize(() => {
    if (globalThis.tcellResize) globalThis.tcellResize();
  });

  window.addEventListener("resize", () => {
    if (fitAddon) fitAddon.fit();
  });
}

// Go -> terminal output
globalThis.tcellWrite = (data) => {
  if (!term) return;
  let text;
  if (data instanceof Uint8Array) {
    text = textDecoder.decode(data);
  } else {
    text = String(data);
  }
  term.write(text);
};

// Go -> terminal size query
globalThis.tcellWindowSize = () => {
  if (!term) return { cols: 80, rows: 24, pixelWidth: 640, pixelHeight: 480 };
  return {
    cols: term.cols,
    rows: term.rows,
    pixelWidth: 0,
    pixelHeight: 0,
  };
};

// Go -> bell (no sound; kept as a no-op so tcell's Beep() still resolves)
globalThis.tcellBell = () => {};

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("visible"), 3000);
}

// Open a file from the user's computer using a plain <input type="file">.
// Works in every browser (no File System Access API needed). The chosen file
// is imported into the virtual filesystem and opened in micro.
async function openFromPicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (file) {
      const data = new Uint8Array(await file.arrayBuffer());
      const path = normalize(HOME_DIR + "/" + file.name);
      ensureParents(path);
      nodes.set(path, { type: "file", data, mtime: Date.now() });
      markDirty();
      if (globalThis.microCommand) {
        globalThis.microCommand("open " + path);
        showToast("Opened \u201c" + file.name + "\u201d");
      } else {
        showToast("micro not ready yet; file is in the virtual filesystem");
      }
    }
    input.remove();
  };
  input.click();
}

// Ask the user which file (from the current directory) to save the current
// buffer into, then save it to the virtual filesystem and download it. Uses a
// small in-page chooser instead of the experimental File System Access API.
async function saveToPicker() {
  const modal = document.getElementById("save-modal");
  if (!modal) {
    showToast("Save dialog not available");
    return;
  }
  const cwdPath = normalize(process.cwd());
  const entries = listDirEntries(cwdPath).filter((e) => !e.isDir);
  const select = document.getElementById("save-select");
  const nameInput = document.getElementById("save-name");
  const cwdLabel = document.getElementById("save-cwd");

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(new file...)";
  select.appendChild(placeholder);
  for (const e of entries) {
    const opt = document.createElement("option");
    opt.value = e.name;
    opt.textContent = e.name;
    select.appendChild(opt);
  }

  cwdLabel.textContent = cwdPath;
  nameInput.value = "";
  nameInput.disabled = false;

  select.onchange = () => {
    if (select.value) nameInput.value = select.value;
  };

  const close = () => {
    modal.classList.add("hidden");
    select.onchange = null;
    confirmBtn.onclick = null;
  };
  const confirmBtn = document.getElementById("save-confirm");
  const cancelBtn = document.getElementById("save-cancel");
  cancelBtn.onclick = close;

  confirmBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast("Enter a file name first");
      return;
    }
    close();
    const path = normalize(cwdPath + "/" + name);
    if (!globalThis.microCommand) {
      showToast("micro not ready yet");
      return;
    }
    globalThis.microCommand("save " + path);
    // The command runs on micro's event loop, so wait for the file to appear
    // in the virtual filesystem before downloading it.
    const deadline = Date.now() + 3000;
    const waitForFile = (resolve) => {
      const node = nodes.get(path);
      if (node && node.type === "file") {
        downloadFile(path);
        resolve();
      } else if (Date.now() > deadline) {
        showToast("Save timed out");
        resolve();
      } else {
        setTimeout(() => waitForFile(resolve), 50);
      }
    };
    await new Promise(waitForFile);
  };

  modal.classList.remove("hidden");
  nameInput.focus();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  await loadPersisted();
  initTerminal();

  const openBtn = document.getElementById("open-btn");
  if (openBtn && typeof openBtn.addEventListener === "function") {
    openBtn.addEventListener("click", openFromPicker);
  }
  const saveBtn = document.getElementById("save-btn");
  if (saveBtn && typeof saveBtn.addEventListener === "function") {
    saveBtn.addEventListener("click", saveToPicker);
  }
  const resetBtn = document.getElementById("reset-btn");
  if (resetBtn && typeof resetBtn.addEventListener === "function") {
    resetBtn.addEventListener("click", resetFilesystem);
  }

  const goArgs = [];

  const go = new globalThis.Go();
  go.argv = ["micro", ...goArgs];
  go.env = {
    HOME: HOME_DIR,
    XDG_CONFIG_HOME: HOME_DIR + "/.config",
    TERM: "xterm-256color",
    USER: "micro",
    LANG: "en_US.UTF-8",
  };

  let mod;
  try {
    mod = await WebAssembly.instantiateStreaming(fetch(WASM_FILE), go.importObject);
  } catch (e) {
    // instantiateStreaming needs the correct MIME type; fall back to buffering
    const buf = await (await fetch(WASM_FILE)).arrayBuffer();
    mod = await WebAssembly.instantiate(buf, go.importObject);
  }

  go.run(mod.instance);
}

boot().catch((err) => {
  console.error(err);
  showToast("Failed to start micro: " + (err && err.message ? err.message : err));
});

// Test hooks: in a browser <script> there is no module system, so this is a
// no-op there. The node-based test harness uses it to drive the UI functions.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalize,
    nodes,
    listDirEntries,
    downloadFile,
    openFromPicker,
    saveToPicker,
    resetFilesystem,
  };
}
