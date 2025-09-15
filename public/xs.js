// xs.js - XS Browser SDK
// Usage:
//   <script src="https://xslang.org/xs.js"></script>
//   <script>
//     const xs = await loadXS()
//     const output = await xs.run(`println("hello world")`)
//   </script>

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
    }

    readFile(path) {
      path = this._norm(path);
      const data = this.files.get(path);
      return data ? new TextDecoder().decode(data) : null;
    }

    listFiles() { return Array.from(this.files.keys()); }
    deleteFile(path) { return this.files.delete(this._norm(path)); }

    open(path, flags) {
      path = this._norm(path);
      let data = this.files.get(path);
      if (!data) {
        if (flags & 1) { data = new Uint8Array(0); this.files.set(path, data); }
        else return -1;
      }
      const fd = this.nextFd++;
      this.fds.set(fd, { path, data, pos: 0 });
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

    close(fd) { return this.fds.delete(fd); }
    filesize(fd) { const e = this.fds.get(fd); return e ? e.data.length : 0; }
    _norm(p) { while (p.startsWith("/")) p = p.slice(1); return p; }
  }

  // ---- Exit signal ----

  class XSExit { constructor(code) { this.code = code; } }

  // ---- WASI layer ----

  function buildWasi(vfs, config) {
    const onStdout = config.stdout || (() => {});
    const onStderr = config.stderr || (() => {});
    const onStdin = config.stdin || null;
    const envVars = config.env || {};

    let memory = null;
    let stdoutBuf = "";
    let stderrBuf = "";
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
          if (onStdin) {
            const input = onStdin();
            if (input) {
              const enc = new TextEncoder().encode(input + "\n");
              const ptr = v.getUint32(iovPtr, true);
              const len = v.getUint32(iovPtr + 4, true);
              const n = Math.min(enc.length, len);
              m.set(enc.subarray(0, n), ptr);
              total = n;
            }
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

    // apply user WASI overrides
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
      resetBuffers() { stdoutBuf = ""; stderrBuf = ""; },
    };
  }

  var DEFAULT_WASM_URL = "https://static.xslang.org/xs.wasm";

  // ---- WASM binary cache ----

  var wasmCache = new Map();

  // ---- Public API ----

  async function loadXS(config) {
    config = config || {};

    var persistent = config.persistent || false;
    var wasmUrl = config.wasmUrl || DEFAULT_WASM_URL;

    // set up filesystem
    var vfs;
    if (config.fs && typeof config.fs.open === "function") {
      vfs = config.fs;
      if (!vfs.writeFile) vfs.writeFile = function() {};
      if (!vfs.readFile) vfs.readFile = function() { return null; };
      if (!vfs.listFiles) vfs.listFiles = function() { return []; };
      if (!vfs.deleteFile) vfs.deleteFile = function() { return false; };
    } else {
      var preload = (config.fs && config.fs.files) ? config.fs.files : null;
      vfs = new VFS(preload);
    }

    // build WASI
    var wasiCtx = buildWasi(vfs, config);

    // fetch and compile wasm
    if (!wasmCache.has(wasmUrl)) {
      var resp = await fetch(wasmUrl);
      if (!resp.ok) throw new Error("failed to fetch " + wasmUrl + ": " + resp.status);
      wasmCache.set(wasmUrl, await resp.arrayBuffer());
    }
    var wasmBytes = wasmCache.get(wasmUrl);

    // instantiate
    var instance, memory;

    function buildImports(wasiObj) {
      var imports = { wasi_snapshot_preview1: wasiObj };
      if (config.imports) {
        for (var k in config.imports) {
          imports[k] = config.imports[k];
        }
      }
      return imports;
    }

    async function instantiate(wasiObj) {
      var result = await WebAssembly.instantiate(wasmBytes, buildImports(wasiObj || wasiCtx.wasi));
      instance = result.instance;
      memory = instance.exports.memory;
      wasiCtx.setMemory(memory);
      return result;
    }

    await instantiate();

    // public runtime object
    var xs = {
      // run XS code from a string, returns stdout as string
      async run(code) {
        var lines = [];
        var captureConfig = {};
        for (var k in config) captureConfig[k] = config[k];
        captureConfig.stdout = function(line) {
          lines.push(line);
          if (config.stdout) config.stdout(line);
        };
        captureConfig.stderr = function(line) {
          lines.push(line);
          if (config.stderr) config.stderr(line);
        };

        var runVfs = persistent ? vfs : new VFS();
        runVfs.writeFile("__run__.xs", code);

        var runWasi = buildWasi(runVfs, captureConfig);
        runWasi.setArgs(["xs", "/__run__.xs"]);

        var result = await WebAssembly.instantiate(wasmBytes, buildImports(runWasi.wasi));
        runWasi.setMemory(result.instance.exports.memory);
        runWasi.resetBuffers();

        try {
          result.instance.exports._start();
        } catch (e) {
          if (!(e instanceof XSExit)) throw e;
        } finally {
          runWasi.flush();
        }

        if (!persistent) runVfs.deleteFile("__run__.xs");
        return lines.join("\n");
      },

      // run with full CLI args
      async exec(args) {
        if (!persistent) await instantiate();
        wasiCtx.setArgs(args || ["xs"]);
        wasiCtx.resetBuffers();
        try {
          instance.exports._start();
          return 0;
        } catch (e) {
          if (e instanceof XSExit) return e.code;
          throw e;
        } finally {
          wasiCtx.flush();
        }
      },

      // filesystem access
      writeFile(path, content) { vfs.writeFile(path, content); },
      readFile(path) { return vfs.readFile(path); },
      listFiles() { return vfs.listFiles(); },
      deleteFile(path) { return vfs.deleteFile(path); },

      // reset to fresh state
      async reset(clearFs) {
        if (clearFs !== false && vfs instanceof VFS) {
          vfs.files.clear();
          vfs.fds.clear();
          vfs.nextFd = 4;
          var preload = (config.fs && config.fs.files) ? config.fs.files : null;
          if (preload) {
            for (var p in preload) vfs.writeFile(p, preload[p]);
          }
        }
        await instantiate();
      },

      // direct access
      get memory() { return memory; },
      get instance() { return instance; },
    };

    return xs;
  }

  if (typeof window !== "undefined") window.loadXS = loadXS;
  if (typeof globalThis !== "undefined") globalThis.loadXS = loadXS;
})();
