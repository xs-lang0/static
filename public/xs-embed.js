// xs-embed.js - XS Embed SDK
// Drop-in components for running XS code on any webpage.
//
// Components:
//   <xs-editor>   - interactive editor with run button, fully CSS-customizable
//   <xs-code>     - auto-running code block with output
//   <script type="text/xs"> - auto-executes, appends output after the tag
//
// Auto-enhance:
//   <script src="xs-embed.js" data-auto></script>
//   Adds "Run" buttons to all <code class="language-xs"> blocks.
//
// Requires xs.js (loaded automatically from the same origin).

(function () {
  "use strict";

  var STATIC_BASE = "https://static.xslang.org";
  var scriptTag = document.currentScript;
  if (scriptTag && scriptTag.src) {
    var idx = scriptTag.src.lastIndexOf("/");
    if (idx !== -1) STATIC_BASE = scriptTag.src.slice(0, idx);
  }

  var xsReady = null;
  var xsInstance = null;

  // Lazy-load xs-highlight.js so <xs-editor> can syntax-colour on input.
  // Fire-and-forget; paint() falls back to plain HTML escaping until it lands.
  (function () {
    if (typeof window === "undefined") return;
    if (typeof window.xsHighlight !== "undefined") return;
    var s = document.createElement("script");
    s.src = STATIC_BASE + "/xs-highlight.js";
    s.async = true;
    s.onload = function () {
      // repaint any editors that mounted before the script arrived
      var editors = document.querySelectorAll("xs-editor");
      editors.forEach(function (e) { if (e._repaint) e._repaint(); });
    };
    document.head.appendChild(s);
  })();

  function ensureXS() {
    if (xsReady) return xsReady;
    xsReady = new Promise(function (resolve, reject) {
      if (typeof loadXS === "function") {
        loadXS({ wasmUrl: STATIC_BASE + "/xs.wasm" }).then(function (xs) {
          xsInstance = xs;
          resolve(xs);
        }).catch(reject);
        return;
      }
      var s = document.createElement("script");
      s.src = STATIC_BASE + "/xs.js";
      s.onload = function () {
        loadXS({ wasmUrl: STATIC_BASE + "/xs.wasm" }).then(function (xs) {
          xsInstance = xs;
          resolve(xs);
        }).catch(reject);
      };
      s.onerror = function () { reject(new Error("failed to load xs.js")); };
      document.head.appendChild(s);
    });
    return xsReady;
  }

  function runCode(code, cb) {
    ensureXS().then(function (xs) {
      var lines = [];
      var runXS;
      var p = loadXS({
        wasmUrl: STATIC_BASE + "/xs.wasm",
        stdout: function (line) { lines.push(line); },
        stderr: function (line) { lines.push(line); },
      });
      p.then(function (inst) {
        inst.run(code).then(function () {
          cb(null, lines.join("\n"));
        }).catch(function (e) {
          cb(null, lines.length ? lines.join("\n") : String(e));
        });
      }).catch(function (e) {
        cb(e, null);
      });
    }).catch(function (e) {
      cb(e, null);
    });
  }

  // ---- <xs-editor> ----

  var editorCSS = [
    ":host { display: block; font-family: var(--xs-font, monospace); }",
    ".xs-editor-wrap {",
    "  border: var(--xs-border, 1px solid #333);",
    "  border-radius: var(--xs-radius, 6px);",
    "  overflow: hidden;",
    "  background: var(--xs-bg, #1e1e2e);",
    "  color: var(--xs-color, #cdd6f4);",
    "}",
    ".xs-editor-toolbar {",
    "  display: flex; align-items: center; justify-content: space-between;",
    "  padding: 6px 10px;",
    "  background: var(--xs-toolbar-bg, #181825);",
    "  border-bottom: var(--xs-border, 1px solid #333);",
    "}",
    ".xs-editor-title {",
    "  font-size: 12px; font-weight: 600;",
    "  color: var(--xs-title-color, #a6adc8);",
    "}",
    ".xs-editor-run {",
    "  padding: 4px 14px; border: none; border-radius: 4px; cursor: pointer;",
    "  font-size: 12px; font-weight: 600; font-family: inherit;",
    "  background: var(--xs-btn-bg, #a6e3a1);",
    "  color: var(--xs-btn-color, #1e1e2e);",
    "  transition: opacity 0.15s;",
    "}",
    ".xs-editor-run:hover { opacity: 0.85; }",
    ".xs-editor-run:disabled { opacity: 0.5; cursor: wait; }",
    ".xs-editor-stack {",
    "  position: relative;",
    "  background: var(--xs-bg, #1e1e2e);",
    "}",
    ".xs-editor-input, .xs-editor-hl {",
    "  display: block; box-sizing: border-box; width: 100%;",
    "  padding: 12px; margin: 0; border: none;",
    "  font-family: var(--xs-font, monospace);",
    "  font-size: var(--xs-font-size, 14px);",
    "  line-height: 1.5;",
    "  tab-size: 2; white-space: pre; word-break: normal;",
    "}",
    ".xs-editor-hl {",
    "  position: absolute; inset: 0;",
    "  pointer-events: none; overflow: auto;",
    "  color: var(--xs-color, #cdd6f4);",
    "}",
    ".xs-editor-input {",
    "  position: relative;",
    "  outline: none; resize: vertical;",
    "  color: transparent;",
    "  background: transparent;",
    "  caret-color: var(--xs-caret, #cdd6f4);",
    "  min-height: 100%;",
    "}",
    ".xs-editor-keyword  { color: var(--xs-kw-color, #cba6f7); font-weight: 600; }",
    ".xs-editor-string   { color: var(--xs-str-color, #a6e3a1); }",
    ".xs-editor-number   { color: var(--xs-num-color, #fab387); }",
    ".xs-editor-comment  { color: var(--xs-comment-color, #6c7086); font-style: italic; }",
    ".xs-editor-type     { color: var(--xs-type-color, #f9e2af); }",
    ".xs-editor-builtin  { color: var(--xs-builtin-color, #89dceb); }",
    ".xs-editor-constant { color: var(--xs-const-color, #f38ba8); }",
    ".xs-editor-operator { color: var(--xs-op-color, #89b4fa); }",
    ".xs-editor-output-wrap {",
    "  border-top: var(--xs-border, 1px solid #333);",
    "  background: var(--xs-output-bg, #11111b);",
    "}",
    ".xs-editor-output-label {",
    "  padding: 4px 10px; font-size: 11px; font-weight: 600;",
    "  color: var(--xs-label-color, #585b70);",
    "}",
    ".xs-editor-output {",
    "  padding: 8px 12px; margin: 0;",
    "  font-family: var(--xs-font, monospace);",
    "  font-size: var(--xs-font-size, 14px);",
    "  line-height: 1.5;",
    "  color: var(--xs-output-color, #a6adc8);",
    "  white-space: pre-wrap; word-break: break-all;",
    "  min-height: 20px;",
    "  max-height: var(--xs-output-max-height, 300px);",
    "  overflow-y: auto;",
    "}",
    ".xs-editor-output.has-error { color: var(--xs-error-color, #f38ba8); }",
  ].join("\n");

  class XSEditor extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      var self = this;
      var title = this.getAttribute("title") || "";
      var code = this.textContent.trim();
      var rows = Math.max((code.split("\n").length + 1), 4);
      var runOnLoad = this.hasAttribute("run-on-load");
      var readonly = this.hasAttribute("readonly");

      var style = document.createElement("style");
      style.textContent = editorCSS;

      var wrap = document.createElement("div");
      wrap.className = "xs-editor-wrap";
      wrap.setAttribute("part", "wrap");

      // toolbar
      var toolbar = document.createElement("div");
      toolbar.className = "xs-editor-toolbar";
      toolbar.setAttribute("part", "toolbar");

      var titleEl = document.createElement("span");
      titleEl.className = "xs-editor-title";
      titleEl.setAttribute("part", "title");
      titleEl.textContent = title || "XS";

      var runBtn = document.createElement("button");
      runBtn.className = "xs-editor-run";
      runBtn.setAttribute("part", "run-button");
      runBtn.textContent = "Run";

      toolbar.appendChild(titleEl);
      toolbar.appendChild(runBtn);

      // editor: highlight overlay under a transparent textarea
      var stack = document.createElement("div");
      stack.className = "xs-editor-stack";
      stack.setAttribute("part", "stack");

      var hl = document.createElement("pre");
      hl.className = "xs-editor-hl";
      hl.setAttribute("aria-hidden", "true");
      hl.setAttribute("part", "highlight");
      var hlCode = document.createElement("code");
      hl.appendChild(hlCode);

      var textarea = document.createElement("textarea");
      textarea.className = "xs-editor-input";
      textarea.setAttribute("part", "input");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "off");
      textarea.rows = rows;
      textarea.value = code;
      if (readonly) textarea.readOnly = true;

      // Map the highlighter's .xs-{cls} spans into scoped .xs-editor-{cls}
      // so our shadow DOM styles can reach them.
      function paint() {
        var raw = (typeof xsHighlight !== "undefined")
          ? xsHighlight.highlight(textarea.value)
          : escapeHtml(textarea.value);
        hlCode.innerHTML = raw.replace(/class="xs-/g, 'class="xs-editor-') +
          (textarea.value.endsWith("\n") ? " " : "");
      }
      function escapeHtml(s) {
        return s.replace(/[&<>]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
        });
      }
      textarea.addEventListener("input", paint);
      textarea.addEventListener("scroll", function () {
        hl.scrollTop  = textarea.scrollTop;
        hl.scrollLeft = textarea.scrollLeft;
      });
      paint();

      // tab key support
      textarea.addEventListener("keydown", function (e) {
        if (e.key === "Tab") {
          e.preventDefault();
          var start = textarea.selectionStart;
          var end = textarea.selectionEnd;
          textarea.value = textarea.value.substring(0, start) + "  " + textarea.value.substring(end);
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          runBtn.click();
        }
      });

      // output
      var outputWrap = document.createElement("div");
      outputWrap.className = "xs-editor-output-wrap";
      outputWrap.setAttribute("part", "output-wrap");
      outputWrap.style.display = "none";

      var outputLabel = document.createElement("div");
      outputLabel.className = "xs-editor-output-label";
      outputLabel.setAttribute("part", "output-label");
      outputLabel.textContent = "Output";

      var output = document.createElement("pre");
      output.className = "xs-editor-output";
      output.setAttribute("part", "output");

      outputWrap.appendChild(outputLabel);
      outputWrap.appendChild(output);

      stack.appendChild(hl);
      stack.appendChild(textarea);

      wrap.appendChild(toolbar);
      wrap.appendChild(stack);
      wrap.appendChild(outputWrap);

      this._shadow.appendChild(style);
      this._shadow.appendChild(wrap);

      // run handler
      runBtn.addEventListener("click", function () {
        runBtn.disabled = true;
        runBtn.textContent = "Running...";
        output.className = "xs-editor-output";
        outputWrap.style.display = "block";
        output.textContent = "";

        runCode(textarea.value, function (err, result) {
          runBtn.disabled = false;
          runBtn.textContent = "Run";
          if (err) {
            output.className = "xs-editor-output has-error";
            output.textContent = String(err);
          } else {
            output.textContent = result;
          }
          self.dispatchEvent(new CustomEvent("xs-run", {
            detail: { code: textarea.value, output: result || String(err), error: !!err }
          }));
        });
      });

      // public API
      this.run = function () { runBtn.click(); };
      this.getCode = function () { return textarea.value; };
      this.setCode = function (c) { textarea.value = c; paint(); };
      this.getOutput = function () { return output.textContent; };
      this._repaint = paint;

      if (runOnLoad) {
        requestAnimationFrame(function () { runBtn.click(); });
      }
    }
  }

  // ---- <xs-code> ----

  var codeCSS = [
    ":host { display: block; font-family: var(--xs-font, monospace); margin: 8px 0; }",
    ".xs-code-wrap {",
    "  border: var(--xs-border, 1px solid #333);",
    "  border-radius: var(--xs-radius, 6px);",
    "  overflow: hidden;",
    "  background: var(--xs-bg, #1e1e2e);",
    "}",
    ".xs-code-source {",
    "  padding: 12px; margin: 0;",
    "  font-family: var(--xs-font, monospace);",
    "  font-size: var(--xs-font-size, 14px);",
    "  line-height: 1.5;",
    "  color: var(--xs-color, #cdd6f4);",
    "  white-space: pre-wrap;",
    "  background: var(--xs-bg, #1e1e2e);",
    "}",
    ".xs-code-output {",
    "  padding: 8px 12px; margin: 0;",
    "  border-top: var(--xs-border, 1px solid #333);",
    "  font-family: var(--xs-font, monospace);",
    "  font-size: var(--xs-font-size, 14px);",
    "  line-height: 1.5;",
    "  color: var(--xs-output-color, #a6adc8);",
    "  background: var(--xs-output-bg, #11111b);",
    "  white-space: pre-wrap;",
    "  min-height: 20px;",
    "}",
    ".xs-code-output.has-error { color: var(--xs-error-color, #f38ba8); }",
    ".xs-code-loading { color: var(--xs-label-color, #585b70); font-style: italic; }",
  ].join("\n");

  class XSCode extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      var self = this;
      var code = this.textContent.trim();

      var style = document.createElement("style");
      style.textContent = codeCSS;

      var wrap = document.createElement("div");
      wrap.className = "xs-code-wrap";
      wrap.setAttribute("part", "wrap");

      var source = document.createElement("pre");
      source.className = "xs-code-source";
      source.setAttribute("part", "source");
      source.textContent = code;

      var output = document.createElement("pre");
      output.className = "xs-code-output xs-code-loading";
      output.setAttribute("part", "output");
      output.textContent = "running...";

      wrap.appendChild(source);
      wrap.appendChild(output);

      this._shadow.appendChild(style);
      this._shadow.appendChild(wrap);

      runCode(code, function (err, result) {
        output.className = "xs-code-output" + (err ? " has-error" : "");
        output.textContent = err ? String(err) : result;
        self.dispatchEvent(new CustomEvent("xs-run", {
          detail: { code: code, output: result || String(err), error: !!err }
        }));
      });
    }
  }

  // ---- <script type="text/xs"> handler ----

  function handleScriptTags() {
    var scripts = document.querySelectorAll('script[type="text/xs"]');
    scripts.forEach(function (tag) {
      if (tag.hasAttribute("data-xs-handled")) return;
      tag.setAttribute("data-xs-handled", "1");

      var code = tag.textContent.trim();
      if (!code) return;

      var pre = document.createElement("pre");
      pre.style.cssText = [
        "font-family: monospace; font-size: 14px; line-height: 1.5;",
        "padding: 8px 12px; margin: 4px 0;",
        "background: #11111b; color: #a6adc8;",
        "border-radius: 4px; white-space: pre-wrap;",
      ].join(" ");
      pre.textContent = "running...";
      tag.parentNode.insertBefore(pre, tag.nextSibling);

      runCode(code, function (err, result) {
        if (err) {
          pre.style.color = "#f38ba8";
          pre.textContent = String(err);
        } else {
          pre.textContent = result;
        }
      });
    });
  }

  // ---- data-auto: enhance <code class="language-xs"> blocks ----

  var enhanceCSS = [
    ".xs-auto-wrap { position: relative; }",
    ".xs-auto-run {",
    "  position: absolute; top: 6px; right: 6px;",
    "  padding: 3px 10px; border: none; border-radius: 3px; cursor: pointer;",
    "  font-size: 11px; font-weight: 600; font-family: monospace;",
    "  background: #a6e3a1; color: #1e1e2e;",
    "  opacity: 0; transition: opacity 0.15s;",
    "}",
    ".xs-auto-wrap:hover .xs-auto-run { opacity: 1; }",
    ".xs-auto-run:disabled { opacity: 0.5; cursor: wait; }",
    ".xs-auto-output {",
    "  padding: 8px 12px; margin: 0;",
    "  font-family: monospace; font-size: 14px; line-height: 1.5;",
    "  background: #11111b; color: #a6adc8;",
    "  border-top: 1px solid #333;",
    "  white-space: pre-wrap;",
    "}",
    ".xs-auto-output.has-error { color: #f38ba8; }",
  ].join("\n");

  function enhanceCodeBlocks() {
    var injected = false;
    var blocks = document.querySelectorAll("code.language-xs");
    blocks.forEach(function (codeEl) {
      var pre = codeEl.closest("pre");
      if (!pre || pre.hasAttribute("data-xs-enhanced")) return;
      pre.setAttribute("data-xs-enhanced", "1");

      if (!injected) {
        var s = document.createElement("style");
        s.textContent = enhanceCSS;
        document.head.appendChild(s);
        injected = true;
      }

      // wrap the pre
      var wrap = document.createElement("div");
      wrap.className = "xs-auto-wrap";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      var btn = document.createElement("button");
      btn.className = "xs-auto-run";
      btn.textContent = "Run";
      wrap.appendChild(btn);

      var outputEl = null;

      btn.addEventListener("click", function () {
        var code = codeEl.textContent.trim();
        btn.disabled = true;
        btn.textContent = "...";

        if (!outputEl) {
          outputEl = document.createElement("pre");
          outputEl.className = "xs-auto-output";
          wrap.appendChild(outputEl);
        }
        outputEl.className = "xs-auto-output";
        outputEl.textContent = "";

        runCode(code, function (err, result) {
          btn.disabled = false;
          btn.textContent = "Run";
          if (err) {
            outputEl.className = "xs-auto-output has-error";
            outputEl.textContent = String(err);
          } else {
            outputEl.textContent = result;
          }
        });
      });
    });
  }

  // ---- register and init ----

  customElements.define("xs-editor", XSEditor);
  customElements.define("xs-code", XSCode);

  function init() {
    handleScriptTags();
    if (scriptTag && scriptTag.hasAttribute("data-auto")) {
      enhanceCodeBlocks();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // observe for dynamically added elements
  var observer = new MutationObserver(function (mutations) {
    var dominated = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length) { dominated = true; break; }
    }
    if (dominated) {
      handleScriptTags();
      if (scriptTag && scriptTag.hasAttribute("data-auto")) {
        enhanceCodeBlocks();
      }
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
