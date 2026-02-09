// xs.js - XS Browser SDK
// Usage:
//   <script src="https://static.xslang.org/xs.js"></script>
//   <script>
//     const xs = await loadXS()
//     const out = await xs.run(`println("hello world")`)
//   </script>
//
// Options (all optional):
//   wasmUrl       override xs.wasm location
//   fs            { files: { path: string|Uint8Array } } preload
//                 OR a custom VFS implementing open/read/write/seek/close
//   persist       string, enable IndexedDB-backed VFS under this db name
//   worker        true, run the wasm in a Web Worker (non-blocking main thread,
//                 required for async stdin)
//   stdout(line)  callback per line of stdout
//   stderr(line)  callback per line of stderr
//   stdin         sync () => string | async () => Promise<string>
//                 (async only works in worker mode with SAB/Atomics)
//   env           { KEY: "value" } passed through WASI environ
//   imports       extra wasm imports (merged into `env` and top-level)

(function() {
  "use strict";

  // ---- Virtual Filesystem ----

  class VFS {
    constructor(preload) {
      this.files = new Map();
      this.fds = new Map();
      this.nextFd = 4;
      if (preload) {
        for (const [path, content] of Object.entries(preload)) {
          this.writeFile(path, content);
        }
      }
    }

    writeFile(path, content) {
      path = this._norm(path);
      if (typeof content === "string") content = new TextEncoder().encode(content);
      this.files.set(path, new Uint8Array(content));
      this._onWrite && this._onWrite(path);
    }

    readFile(path) {
      path = this._norm(path);
      const data = this.files.get(path);
      return data ? new TextDecoder().decode(data) : null;
    }

    listFiles() { return Array.from(this.files.keys()); }
    deleteFile(path) {
      path = this._norm(path);
      const ok = this.files.delete(path);
      if (ok) this._onDelete && this._onDelete(path);
      return ok;
    }

    open(path, flags) {
      path = this._norm(path);
      let data = this.files.get(path);
      if (!data) {
        if (flags & 1) { data = new Uint8Array(0); this.files.set(path, data); }
        else return -1;
      }
      const fd = this.nextFd++;
      this.fds.set(fd, { path, data, pos: 0, dirty: false });
      return fd;
    }

    read(fd, buf, len) {
      const e = this.fds.get(fd);
      if (!e) return 0;
      const n = Math.min(len, e.data.length - e.pos);
      if (n <= 0) return 0;
      buf.set(e.data.subarray(e.pos, e.pos + n));
      e.pos += n;
      return n;
    }

    write(fd, data) {
      const e = this.fds.get(fd);
      if (!e) return 0;
      const needed = e.pos + data.length;
      if (needed > e.data.length) {
        const grown = new Uint8Array(needed);
        grown.set(e.data);
        e.data = grown;
        this.files.set(e.path, e.data);
      }
      e.data.set(data, e.pos);
      e.pos += data.length;
      e.dirty = true;
      return data.length;
    }

    seek(fd, offset, whence) {
      const e = this.fds.get(fd);
      if (!e) return -1;
      if (whence === 0) e.pos = offset;
      else if (whence === 1) e.pos += offset;
      else if (whence === 2) e.pos = e.data.length + offset;
      if (e.pos < 0) e.pos = 0;
      return e.pos;
    }

    close(fd) {
      const e = this.fds.get(fd);
      if (e && e.dirty && this._onWrite) this._onWrite(e.path);
      return this.fds.delete(fd);
    }
    filesize(fd) { const e = this.fds.get(fd); return e ? e.data.length : 0; }
    _norm(p) { while (p.startsWith("/")) p = p.slice(1); return p; }
  }

  // ---- IndexedDB-backed VFS ----

  function openIDB(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("files"))
          req.result.createObjectStore("files");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbAll(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readonly");
      const store = tx.objectStore("files");
      const out = {};
      const req = store.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out[c.key] = c.value;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function idbDel(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  class PersistentVFS extends VFS {
    constructor(dbName, preload) {
      super();
      this.dbName = dbName;
      this._db = null;
      this._pending = new Map();
      this._flushTimer = null;
      this._readyPromise = this._init(preload);
    }

    async _init(preload) {
      this._db = await openIDB(this.dbName);
      const stored = await idbAll(this._db);
      for (const [path, data] of Object.entries(stored)) {
        this.files.set(path, new Uint8Array(data));
      }
      if (preload) {
        for (const [path, content] of Object.entries(preload)) {
          if (!this.files.has(this._norm(path))) this.writeFile(path, content);
        }
      }
      this._onWrite = (p) => this._schedule(p, "put");
      this._onDelete = (p) => this._schedule(p, "del");
    }

    ready() { return this._readyPromise; }

    _schedule(path, op) {
      this._pending.set(path, op);
      if (this._flushTimer) return;
      this._flushTimer = setTimeout(() => this._flush(), 50);
    }

    async _flush() {
      this._flushTimer = null;
      const ops = Array.from(this._pending.entries());
      this._pending.clear();
      for (const [path, op] of ops) {
        try {
          if (op === "put") await idbPut(this._db, path, this.files.get(path));
          else             await idbDel(this._db, path);
        } catch (e) { /* best-effort */ }
      }
    }
  }

  // ---- Exit signal ----

  class XSExit { constructor(code) { this.code = code; } }

  // ---- WASI layer ----

  function buildWasi(vfs, config, stdinCtx) {
    const onStdout = config.stdout || (() => {});
    const onStderr = config.stderr || (() => {});
    const onStdin  = config.stdin  || null;
    const envVars  = config.env    || {};

    let memory = null;
    let stdoutBuf = "";
    let stderrBuf = "";
    let stdinRem  = "";  // sync mode leftover bytes
    let currentArgs = ["xs"];

    function mem() { return new Uint8Array(memory.buffer); }
    function view() { return new DataView(memory.buffer); }

    function flushLine(buf, cb) {
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        cb(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      return buf;
    }

    function envEntries() {
      return Object.entries(envVars).map(([k, v]) => k + "=" + v);
    }

    const wasi = {
      args_sizes_get(argcPtr, bufSizePtr) {
        const v = view();
        v.setUint32(argcPtr, currentArgs.length, true);
        let sz = 0;
        for (const a of currentArgs) sz += new TextEncoder().encode(a).length + 1;
        v.setUint32(bufSizePtr, sz, true);
        return 0;
      },
      args_get(argvPtr, argvBufPtr) {
        const v = view(); const m = mem();
        let off = argvBufPtr;
        for (let i = 0; i < currentArgs.length; i++) {
          v.setUint32(argvPtr + i * 4, off, true);
          const enc = new TextEncoder().encode(currentArgs[i]);
          m.set(enc, off);
          m[off + enc.length] = 0;
          off += enc.length + 1;
        }
        return 0;
      },
      environ_sizes_get(countPtr, sizePtr) {
        const entries = envEntries();
        const v = view();
        v.setUint32(countPtr, entries.length, true);
        let sz = 0;
        for (const e of entries) sz += new TextEncoder().encode(e).length + 1;
        v.setUint32(sizePtr, sz, true);
        return 0;
      },
      environ_get(envPtr, envBufPtr) {
        const entries = envEntries();
        const v = view(); const m = mem();
        let off = envBufPtr;
        for (let i = 0; i < entries.length; i++) {
          v.setUint32(envPtr + i * 4, off, true);
          const enc = new TextEncoder().encode(entries[i]);
          m.set(enc, off);
          m[off + enc.length] = 0;
          off += enc.length + 1;
        }
        return 0;
      },
      fd_write(fd, iovPtr, iovLen, nwrittenPtr) {
        const v = view(); const m = mem();
        let total = 0;
        for (let i = 0; i < iovLen; i++) {
          const ptr = v.getUint32(iovPtr + i * 8, true);
          const len = v.getUint32(iovPtr + i * 8 + 4, true);
          const bytes = m.slice(ptr, ptr + len);
          if (fd === 1) {
            stdoutBuf += new TextDecoder().decode(bytes);
            stdoutBuf = flushLine(stdoutBuf, onStdout);
          } else if (fd === 2) {
            stderrBuf += new TextDecoder().decode(bytes);
            stderrBuf = flushLine(stderrBuf, onStderr);
          } else {
            vfs.write(fd, bytes);
          }
          total += len;
        }
        v.setUint32(nwrittenPtr, total, true);
        return 0;
      },
      fd_read(fd, iovPtr, iovLen, nreadPtr) {
        const v = view(); const m = mem();
        let total = 0;
        if (fd === 0) {
          // stdin: flush any pending output first so prompts show up
          if (stdoutBuf) { onStdout(stdoutBuf); stdoutBuf = ""; }
          if (stderrBuf) { onStderr(stderrBuf); stderrBuf = ""; }

          let input = stdinRem;
          if (!input) {
            if (stdinCtx && stdinCtx.blockingRead) {
              input = stdinCtx.blockingRead();
            } else if (onStdin) {
              const r = onStdin();
              if (r && typeof r.then === "function") {
                // async stdin in main-thread mode: can't block, so skip.
                // Worker mode plumbs this through stdinCtx.blockingRead instead.
                input = "";
              } else {
                input = r || "";
              }
            }
            if (input && !input.endsWith("\n")) input += "\n";
          }

          if (input) {
            const enc = new TextEncoder().encode(input);
            const ptr = v.getUint32(iovPtr, true);
            const len = v.getUint32(iovPtr + 4, true);
            const n = Math.min(enc.length, len);
            m.set(enc.subarray(0, n), ptr);
            total = n;
            stdinRem = n < enc.length
              ? new TextDecoder().decode(enc.subarray(n))
              : "";
          }
          v.setUint32(nreadPtr, total, true);
          return 0;
        }
        for (let i = 0; i < iovLen; i++) {
          const ptr = v.getUint32(iovPtr + i * 8, true);
          const len = v.getUint32(iovPtr + i * 8 + 4, true);
          const buf = m.subarray(ptr, ptr + len);
          const n = vfs.read(fd, buf, len);
          total += n;
          if (n < len) break;
        }
        v.setUint32(nreadPtr, total, true);
        return 0;
      },
      fd_seek(fd, offsetBigInt, whence, newOffsetPtr) {
        if (fd <= 2) return 0;
        const pos = vfs.seek(fd, Number(offsetBigInt), whence);
        if (pos < 0) return 8;
        view().setBigUint64(newOffsetPtr, BigInt(pos), true);
        return 0;
      },
      fd_close(fd) {
        if (fd <= 3) return 0;
        return vfs.close(fd) ? 0 : 8;
      },
      fd_fdstat_get(fd, ptr) {
        const v = view();
        v.setUint8(ptr, fd <= 2 ? 2 : 4);
        v.setUint16(ptr + 2, 0, true);
        v.setBigUint64(ptr + 8, 0n, true);
        v.setBigUint64(ptr + 16, 0n, true);
        return 0;
      },
      fd_prestat_get(fd, ptr) {
        if (fd === 3) {
          const v = view();
          v.setUint32(ptr, 0, true);
          v.setUint32(ptr + 4, 1, true);
          return 0;
        }
        return 8;
      },
      fd_prestat_dir_name(fd, pathPtr) {
        if (fd === 3) { mem()[pathPtr] = 47; return 0; }
        return 8;
      },
      path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, fdOut) {
        const path = new TextDecoder().decode(mem().slice(pathPtr, pathPtr + pathLen));
        const fd = vfs.open(path, oflags);
        if (fd < 0) return 44;
        view().setUint32(fdOut, fd, true);
        return 0;
      },
      fd_filestat_get(fd, ptr) {
        const v = view();
        for (let i = 0; i < 64; i++) v.setUint8(ptr + i, 0);
        if (fd <= 2) {
          v.setUint8(ptr + 16, 2);
        } else {
          v.setUint8(ptr + 16, 4);
          v.setBigUint64(ptr + 32, BigInt(vfs.filesize(fd)), true);
        }
        return 0;
      },
      clock_time_get(clockId, precision, timePtr) {
        view().setBigUint64(timePtr, BigInt(Math.round(performance.now() * 1e6)), true);
        return 0;
      },
      proc_exit(code) {
        if (stdoutBuf) { onStdout(stdoutBuf); stdoutBuf = ""; }
        if (stderrBuf) { onStderr(stderrBuf); stderrBuf = ""; }
        throw new XSExit(code);
      },
      random_get(ptr, len) {
        crypto.getRandomValues(mem().subarray(ptr, ptr + len));
        return 0;
      },
      path_filestat_get() { return 52; },
      path_unlink_file() { return 52; },
      path_rename() { return 52; },
      path_create_directory() { return 52; },
      path_remove_directory() { return 52; },
      fd_readdir() { return 52; },
      poll_oneoff() { return 52; },
      sched_yield() { return 0; },
    };

    if (config.wasi) {
      for (const [k, fn] of Object.entries(config.wasi)) {
        if (typeof fn === "function") wasi[k] = fn;
      }
    }

    return {
      wasi,
      setMemory(m) { memory = m; },
      setArgs(a) { currentArgs = a; },
      flush() {
        if (stdoutBuf) { onStdout(stdoutBuf); stdoutBuf = ""; }
        if (stderrBuf) { onStderr(stderrBuf); stderrBuf = ""; }
      },
      resetBuffers() { stdoutBuf = ""; stderrBuf = ""; stdinRem = ""; },
    };
  }

  // ---- Module cache (compile once, instantiate many) ----

  const DEFAULT_WASM_URL = "https://static.xslang.org/xs.wasm";
  const moduleCache = new Map();

  async function getModule(url) {
    if (moduleCache.has(url)) return moduleCache.get(url);
    let mod;
    try {
      mod = await WebAssembly.compileStreaming(fetch(url));
    } catch (e) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("failed to fetch " + url + ": " + resp.status);
      mod = await WebAssembly.compile(await resp.arrayBuffer());
    }
    moduleCache.set(url, mod);
    return mod;
  }

  // ---- Sleep impl ----

  let _sleepBuf = null;
  try { _sleepBuf = new Int32Array(new SharedArrayBuffer(4)); } catch (e) {}
  function _sleepMs(ms) {
    if (ms <= 0) return;
    if (_sleepBuf) Atomics.wait(_sleepBuf, 0, 0, ms);
    else { const end = performance.now() + ms; while (performance.now() < end) {} }
  }

  // ---- Main-thread loader ----

  async function loadXSMain(config) {
    const wasmUrl = config.wasmUrl || DEFAULT_WASM_URL;

    // VFS
    let vfs;
    if (config.fs && typeof config.fs.open === "function") {
      vfs = config.fs;
      if (!vfs.writeFile) vfs.writeFile = function() {};
      if (!vfs.readFile) vfs.readFile = function() { return null; };
      if (!vfs.listFiles) vfs.listFiles = function() { return []; };
      if (!vfs.deleteFile) vfs.deleteFile = function() { return false; };
    } else if (config.persist) {
      vfs = new PersistentVFS(config.persist,
        (config.fs && config.fs.files) ? config.fs.files : null);
      await vfs.ready();
    } else {
      const preload = (config.fs && config.fs.files) ? config.fs.files : null;
      vfs = new VFS(preload);
    }

    const wasiCtx = buildWasi(vfs, config);
    const module = await getModule(wasmUrl);

    let instance, memory;

    function buildImports(wasiObj) {
      const imports = {
        wasi_snapshot_preview1: wasiObj,
        env: { __xs_sleep_ms: _sleepMs },
      };
      if (config.imports) {
        for (const k in config.imports) {
          if (k === "env") {
            for (const ek in config.imports[k]) imports.env[ek] = config.imports[k][ek];
          } else {
            imports[k] = config.imports[k];
          }
        }
      }
      return imports;
    }

    function instantiate(wasiObj) {
      instance = new WebAssembly.Instance(module, buildImports(wasiObj || wasiCtx.wasi));
      memory = instance.exports.memory;
      wasiCtx.setMemory(memory);
    }

    instantiate();

    const persistent = !!config.persistent;

    const xs = {
      async run(code) {
        const lines = [];
        const captureConfig = { ...config };
        captureConfig.stdout = (line) => {
          lines.push(line);
          if (config.stdout) config.stdout(line);
        };
        captureConfig.stderr = (line) => {
          lines.push(line);
          if (config.stderr) config.stderr(line);
        };

        const runVfs = (persistent || config.persist) ? vfs : new VFS();
        runVfs.writeFile("__run__.xs", code);

        const runWasi = buildWasi(runVfs, captureConfig);
        runWasi.setArgs(["xs", "/__run__.xs"]);

        const inst = new WebAssembly.Instance(module, buildImports(runWasi.wasi));
        runWasi.setMemory(inst.exports.memory);
        runWasi.resetBuffers();

        try { inst.exports._start(); }
        catch (e) { if (!(e instanceof XSExit)) throw e; }
        finally { runWasi.flush(); }

        if (!(persistent || config.persist)) runVfs.deleteFile("__run__.xs");
        return lines.join("\n");
      },

      async exec(args) {
        if (!persistent) instantiate();
        wasiCtx.setArgs(args || ["xs"]);
        wasiCtx.resetBuffers();
        try { instance.exports._start(); return 0; }
        catch (e) { if (e instanceof XSExit) return e.code; throw e; }
        finally { wasiCtx.flush(); }
      },

      writeFile(path, content) { vfs.writeFile(path, content); },
      readFile(path) { return vfs.readFile(path); },
      listFiles() { return vfs.listFiles(); },
      deleteFile(path) { return vfs.deleteFile(path); },

      async fetch(url, path, opts) {
        opts = opts || {};
        const resp = await fetch(url, opts);
        if (!resp.ok) throw new Error("fetch " + url + ": " + resp.status);
        const buf = new Uint8Array(await resp.arrayBuffer());
        vfs.writeFile(path, buf);
        return { status: resp.status, size: buf.length, headers: resp.headers };
      },

      async fetchAll(entries) {
        const items = Array.isArray(entries) ? entries
          : Object.keys(entries).map(p => ({ path: p, url: entries[p] }));
        return Promise.all(items.map(e => xs.fetch(e.url, e.path, e.opts)));
      },

      async reset(clearFs) {
        if (clearFs !== false && vfs instanceof VFS && !config.persist) {
          vfs.files.clear();
          vfs.fds.clear();
          vfs.nextFd = 4;
          const preload = (config.fs && config.fs.files) ? config.fs.files : null;
          if (preload) for (const p in preload) vfs.writeFile(p, preload[p]);
        }
        instantiate();
      },

      get memory() { return memory; },
      get instance() { return instance; },
    };

    return xs;
  }

  // ---- Worker-mode loader ----
  //
  // Runs the wasm inside a Web Worker so long-running XS code doesn't freeze
  // the main thread, and wires a SharedArrayBuffer between the worker and
  // the main thread so `stdin` can be async.
  //
  // Requires cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer.
  // Without SAB, worker mode still works but async stdin returns "" (sync
  // stdin callbacks still behave).

  const WORKER_SRC = `
"use strict";

let mod = null;
let vfs = null;
const files = new Map();
const fds  = new Map();
let nextFd = 4;

function norm(p) { while (p.startsWith("/")) p = p.slice(1); return p; }

function buildVFS() {
  return {
    writeFile(path, content) {
      path = norm(path);
      if (typeof content === "string") content = new TextEncoder().encode(content);
      files.set(path, new Uint8Array(content));
    },
    readFile(path) {
      const d = files.get(norm(path));
      return d ? new TextDecoder().decode(d) : null;
    },
    deleteFile(path) { return files.delete(norm(path)); },
    open(path, flags) {
      path = norm(path);
      let d = files.get(path);
      if (!d) {
        if (flags & 1) { d = new Uint8Array(0); files.set(path, d); }
        else return -1;
      }
      const fd = nextFd++;
      fds.set(fd, { path, data: d, pos: 0 });
      return fd;
    },
    read(fd, buf, len) {
      const e = fds.get(fd); if (!e) return 0;
      const n = Math.min(len, e.data.length - e.pos);
      if (n <= 0) return 0;
      buf.set(e.data.subarray(e.pos, e.pos + n));
      e.pos += n;
      return n;
    },
    write(fd, data) {
      const e = fds.get(fd); if (!e) return 0;
      const needed = e.pos + data.length;
      if (needed > e.data.length) {
        const g = new Uint8Array(needed);
        g.set(e.data);
        e.data = g;
        files.set(e.path, e.data);
      }
      e.data.set(data, e.pos);
      e.pos += data.length;
      return data.length;
    },
    seek(fd, off, whence) {
      const e = fds.get(fd); if (!e) return -1;
      if (whence === 0) e.pos = off;
      else if (whence === 1) e.pos += off;
      else if (whence === 2) e.pos = e.data.length + off;
      if (e.pos < 0) e.pos = 0;
      return e.pos;
    },
    close(fd) { return fds.delete(fd); },
    filesize(fd) { const e = fds.get(fd); return e ? e.data.length : 0; },
  };
}

// SharedArrayBuffer-based stdin channel. Layout:
//   [0]: int32 flag (0 = empty, >0 = ready with N bytes, -1 = closed)
//   [4..]: utf-8 bytes
let stdinSAB = null, stdinFlag = null, stdinBytes = null;

function initSAB() {
  try {
    stdinSAB = new SharedArrayBuffer(4 + 65536);
    stdinFlag = new Int32Array(stdinSAB, 0, 1);
    stdinBytes = new Uint8Array(stdinSAB, 4);
    return true;
  } catch (e) {
    stdinSAB = null; return false;
  }
}

function blockingStdin() {
  if (!stdinSAB) return "";
  self.postMessage({ cmd: "stdin-req" });
  Atomics.wait(stdinFlag, 0, 0);
  const n = Atomics.load(stdinFlag, 0);
  Atomics.store(stdinFlag, 0, 0);
  if (n <= 0) return "";
  const text = new TextDecoder().decode(stdinBytes.subarray(0, n));
  return text;
}

class XSExit { constructor(code) { this.code = code; } }

function runWasi(argv, config) {
  let memory = null;
  let stdoutBuf = "", stderrBuf = "", stdinRem = "";

  const m = () => new Uint8Array(memory.buffer);
  const v = () => new DataView(memory.buffer);

  const onStdout = (line) => self.postMessage({ cmd: "stdout", line });
  const onStderr = (line) => self.postMessage({ cmd: "stderr", line });
  function flushLine(buf, cb) {
    let i;
    while ((i = buf.indexOf("\\n")) !== -1) {
      cb(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    return buf;
  }

  const wasi = {
    args_sizes_get(cp, sp) {
      v().setUint32(cp, argv.length, true);
      let sz = 0;
      for (const a of argv) sz += new TextEncoder().encode(a).length + 1;
      v().setUint32(sp, sz, true);
      return 0;
    },
    args_get(argvPtr, bufPtr) {
      let off = bufPtr;
      for (let i = 0; i < argv.length; i++) {
        v().setUint32(argvPtr + i * 4, off, true);
        const enc = new TextEncoder().encode(argv[i]);
        m().set(enc, off);
        m()[off + enc.length] = 0;
        off += enc.length + 1;
      }
      return 0;
    },
    environ_sizes_get(cp, sp) { v().setUint32(cp, 0, true); v().setUint32(sp, 0, true); return 0; },
    environ_get() { return 0; },
    fd_write(fd, iovPtr, iovLen, nwrittenPtr) {
      let total = 0;
      for (let i = 0; i < iovLen; i++) {
        const ptr = v().getUint32(iovPtr + i * 8, true);
        const len = v().getUint32(iovPtr + i * 8 + 4, true);
        const bytes = m().slice(ptr, ptr + len);
        if (fd === 1) { stdoutBuf += new TextDecoder().decode(bytes); stdoutBuf = flushLine(stdoutBuf, onStdout); }
        else if (fd === 2) { stderrBuf += new TextDecoder().decode(bytes); stderrBuf = flushLine(stderrBuf, onStderr); }
        else vfs.write(fd, bytes);
        total += len;
      }
      v().setUint32(nwrittenPtr, total, true);
      return 0;
    },
    fd_read(fd, iovPtr, iovLen, nreadPtr) {
      let total = 0;
      if (fd === 0) {
        if (stdoutBuf) { onStdout(stdoutBuf); stdoutBuf = ""; }
        if (stderrBuf) { onStderr(stderrBuf); stderrBuf = ""; }
        let input = stdinRem || blockingStdin();
        if (input && !input.endsWith("\\n")) input += "\\n";
        if (input) {
          const enc = new TextEncoder().encode(input);
          const ptr = v().getUint32(iovPtr, true);
          const len = v().getUint32(iovPtr + 4, true);
          const n = Math.min(enc.length, len);
          m().set(enc.subarray(0, n), ptr);
          total = n;
          stdinRem = n < enc.length ? new TextDecoder().decode(enc.subarray(n)) : "";
        }
        v().setUint32(nreadPtr, total, true);
        return 0;
      }
      for (let i = 0; i < iovLen; i++) {
        const ptr = v().getUint32(iovPtr + i * 8, true);
        const len = v().getUint32(iovPtr + i * 8 + 4, true);
        const buf = m().subarray(ptr, ptr + len);
        const n = vfs.read(fd, buf, len);
        total += n;
        if (n < len) break;
      }
      v().setUint32(nreadPtr, total, true);
      return 0;
    },
    fd_seek(fd, off, whence, outPtr) {
      if (fd <= 2) return 0;
      const p = vfs.seek(fd, Number(off), whence);
      if (p < 0) return 8;
      v().setBigUint64(outPtr, BigInt(p), true);
      return 0;
    },
    fd_close(fd) { if (fd <= 3) return 0; return vfs.close(fd) ? 0 : 8; },
    fd_fdstat_get(fd, ptr) {
      v().setUint8(ptr, fd <= 2 ? 2 : 4);
      v().setUint16(ptr + 2, 0, true);
      v().setBigUint64(ptr + 8, 0n, true);
      v().setBigUint64(ptr + 16, 0n, true);
      return 0;
    },
    fd_prestat_get(fd, ptr) {
      if (fd === 3) { v().setUint32(ptr, 0, true); v().setUint32(ptr + 4, 1, true); return 0; }
      return 8;
    },
    fd_prestat_dir_name(fd, p) { if (fd === 3) { m()[p] = 47; return 0; } return 8; },
    path_open(_, __, pp, pl, of, ___, ____, _____, fdOut) {
      const p = new TextDecoder().decode(m().slice(pp, pp + pl));
      const fd = vfs.open(p, of);
      if (fd < 0) return 44;
      v().setUint32(fdOut, fd, true);
      return 0;
    },
    fd_filestat_get(fd, ptr) {
      for (let i = 0; i < 64; i++) v().setUint8(ptr + i, 0);
      if (fd <= 2) v().setUint8(ptr + 16, 2);
      else { v().setUint8(ptr + 16, 4); v().setBigUint64(ptr + 32, BigInt(vfs.filesize(fd)), true); }
      return 0;
    },
    clock_time_get(_, __, tp) { v().setBigUint64(tp, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    proc_exit(code) {
      if (stdoutBuf) { onStdout(stdoutBuf); stdoutBuf = ""; }
      if (stderrBuf) { onStderr(stderrBuf); stderrBuf = ""; }
      throw new XSExit(code);
    },
    random_get(ptr, len) { crypto.getRandomValues(m().subarray(ptr, ptr + len)); return 0; },
    path_filestat_get() { return 52; },
    path_unlink_file() { return 52; },
    path_rename() { return 52; },
    path_create_directory() { return 52; },
    path_remove_directory() { return 52; },
    fd_readdir() { return 52; },
    poll_oneoff() { return 52; },
    sched_yield() { return 0; },
  };

  const sleepBuf = stdinSAB ? stdinFlag : null;
  function sleepMs(ms) {
    if (ms <= 0) return;
    if (sleepBuf) Atomics.wait(sleepBuf, 0, 0, ms);
    else { const end = performance.now() + ms; while (performance.now() < end) {} }
  }

  const imports = {
    wasi_snapshot_preview1: wasi,
    env: { __xs_sleep_ms: sleepMs },
  };

  const inst = new WebAssembly.Instance(mod, imports);
  memory = inst.exports.memory;
  try { inst.exports._start(); }
  catch (e) { if (!(e instanceof XSExit)) throw e; }
  finally {
    if (stdoutBuf) onStdout(stdoutBuf);
    if (stderrBuf) onStderr(stderrBuf);
  }
}

self.onmessage = async (ev) => {
  const d = ev.data;
  try {
    if (d.cmd === "init") {
      const hasSAB = initSAB();
      mod = await WebAssembly.compileStreaming(fetch(d.wasmUrl));
      vfs = buildVFS();
      self.postMessage({ cmd: "ready", sharedBuffer: stdinSAB, hasSAB });
    } else if (d.cmd === "files") {
      // bulk preload: { path: Uint8Array|string }
      for (const [p, c] of Object.entries(d.files)) vfs.writeFile(p, c);
      self.postMessage({ cmd: "files-ok", id: d.id });
    } else if (d.cmd === "run") {
      const code = d.code;
      vfs.writeFile("__run__.xs", code);
      runWasi(["xs", "/__run__.xs"], d.config || {});
      vfs.deleteFile("__run__.xs");
      self.postMessage({ cmd: "done", id: d.id });
    } else if (d.cmd === "read") {
      self.postMessage({ cmd: "read-resp", id: d.id, data: vfs.readFile(d.path) });
    } else if (d.cmd === "list") {
      self.postMessage({ cmd: "list-resp", id: d.id, data: Array.from(files.keys()) });
    }
  } catch (e) {
    self.postMessage({ cmd: "error", id: d.id, message: String(e && e.stack || e) });
  }
};
`;

  async function loadXSWorker(config) {
    const wasmUrl = config.wasmUrl || DEFAULT_WASM_URL;
    const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
    const worker = new Worker(URL.createObjectURL(blob));

    let sharedBuffer = null;
    let stdinFlag = null;
    let stdinBytes = null;

    // ready handshake
    await new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (ev.data.cmd === "ready") {
          sharedBuffer = ev.data.sharedBuffer;
          if (sharedBuffer) {
            stdinFlag = new Int32Array(sharedBuffer, 0, 1);
            stdinBytes = new Uint8Array(sharedBuffer, 4);
          }
          worker.removeEventListener("message", onMsg);
          resolve();
        } else if (ev.data.cmd === "error") {
          worker.removeEventListener("message", onMsg);
          reject(new Error(ev.data.message));
        }
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({ cmd: "init", wasmUrl });
    });

    let reqId = 0;
    const pending = new Map();

    function onStdinReq() {
      if (!stdinBytes) { Atomics.store(stdinFlag || new Int32Array(1), 0, 0); return; }
      const cb = config.stdin;
      const p = Promise.resolve(cb ? cb() : "");
      p.then((text) => {
        text = String(text || "");
        const enc = new TextEncoder().encode(text);
        const n = Math.min(enc.length, stdinBytes.length);
        stdinBytes.set(enc.subarray(0, n));
        Atomics.store(stdinFlag, 0, n);
        Atomics.notify(stdinFlag, 0, 1);
      }).catch(() => {
        Atomics.store(stdinFlag, 0, -1);
        Atomics.notify(stdinFlag, 0, 1);
      });
    }

    worker.addEventListener("message", (ev) => {
      const d = ev.data;
      if (d.cmd === "stdout") { (config.stdout || (() => {}))(d.line); return; }
      if (d.cmd === "stderr") { (config.stderr || (() => {}))(d.line); return; }
      if (d.cmd === "stdin-req") { onStdinReq(); return; }
      const entry = pending.get(d.id);
      if (!entry) return;
      if (d.cmd === "error") { pending.delete(d.id); entry.reject(new Error(d.message)); }
      else if (d.cmd === "done") { pending.delete(d.id); entry.resolve(d.result || ""); }
      else if (d.cmd === "read-resp" || d.cmd === "list-resp" || d.cmd === "files-ok") {
        pending.delete(d.id); entry.resolve(d.data);
      }
    });

    function callWorker(msg) {
      const id = ++reqId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...msg, id });
      });
    }

    // Optional IndexedDB persistence (main-thread side; files sync to worker VFS)
    let persistVfs = null;
    if (config.persist) {
      persistVfs = new PersistentVFS(config.persist,
        (config.fs && config.fs.files) ? config.fs.files : null);
      await persistVfs.ready();
      const files = {};
      for (const p of persistVfs.listFiles()) files[p] = persistVfs.files.get(p);
      await callWorker({ cmd: "files", files });
    } else if (config.fs && config.fs.files) {
      await callWorker({ cmd: "files", files: config.fs.files });
    }

    const xs = {
      async run(code) {
        const lines = [];
        const stdoutOrig = config.stdout;
        const stderrOrig = config.stderr;
        config.stdout = (line) => { lines.push(line); if (stdoutOrig) stdoutOrig(line); };
        config.stderr = (line) => { lines.push(line); if (stderrOrig) stderrOrig(line); };
        try {
          await callWorker({ cmd: "run", code });
        } finally {
          config.stdout = stdoutOrig;
          config.stderr = stderrOrig;
        }
        return lines.join("\n");
      },

      async writeFile(path, content) {
        if (persistVfs) persistVfs.writeFile(path, content);
        await callWorker({ cmd: "files", files: { [path]: content } });
      },

      async readFile(path) {
        return callWorker({ cmd: "read", path });
      },

      async listFiles() {
        return callWorker({ cmd: "list" });
      },

      async fetch(url, path, opts) {
        opts = opts || {};
        const resp = await fetch(url, opts);
        if (!resp.ok) throw new Error("fetch " + url + ": " + resp.status);
        const buf = new Uint8Array(await resp.arrayBuffer());
        await xs.writeFile(path, buf);
        return { status: resp.status, size: buf.length, headers: resp.headers };
      },

      async fetchAll(entries) {
        const items = Array.isArray(entries) ? entries
          : Object.keys(entries).map(p => ({ path: p, url: entries[p] }));
        return Promise.all(items.map(e => xs.fetch(e.url, e.path, e.opts)));
      },

      terminate() { worker.terminate(); },

      get _worker() { return worker; },
      get hasAsyncStdin() { return !!stdinBytes; },
    };

    return xs;
  }

  // ---- Public entry ----

  async function loadXS(config) {
    config = config || {};
    if (config.worker) return loadXSWorker(config);
    return loadXSMain(config);
  }

  loadXS.VFS = VFS;
  loadXS.PersistentVFS = PersistentVFS;

  if (typeof window !== "undefined") window.loadXS = loadXS;
  if (typeof globalThis !== "undefined") globalThis.loadXS = loadXS;
})();
