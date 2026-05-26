// xs-highlight.js - regex-based XS syntax highlighter for browser editors.
// Not a real parser. Good enough for <xs-editor>, <pre><code>, etc.

(function () {
  "use strict";

  const KEYWORDS = new Set([
    "fn", "let", "var", "const",
    "struct", "enum", "trait", "impl", "class", "type", "macro", "tag",
    "import", "export", "from", "use", "module", "as", "plugin",
    "if", "else", "elif", "while", "for", "in", "loop", "match", "when",
    "return", "break", "continue", "yield",
    "try", "catch", "finally", "throw", "defer",
    "async", "await", "spawn", "nursery", "actor",
    "effect", "perform", "handle", "resume",
    "pub", "mut", "static", "inline", "unsafe", "where",
    "and", "or", "not", "is",
  ]);

  const CONSTANTS = new Set(["true", "false", "null", "self", "super"]);

  const TYPES = new Set([
    "int", "i8", "i16", "i32", "i64",
    "u8", "u16", "u32", "u64",
    "float", "f32", "f64",
    "str", "string", "bool", "char", "byte", "re",
    "any", "dyn", "void", "unit", "never",
  ]);

  const BUILTINS = new Set([
    "print", "println", "eprint", "eprintln", "input",
    "len", "type", "typeof", "range",
    "assert", "assert_eq", "panic", "dbg", "pprint", "repr", "exit",
    "todo", "unreachable", "copy", "clone",
    "signal", "derived", "channel",
    "spawn",
  ]);

  // Build one big regex that tokenizes XS. Order matters: more specific first.
  // Each alternative carries its class in a named group.
  const TOKEN_RE = new RegExp([
    // line comment
    "(?<comment>--[^\\n]*)",
    // block comment
    "(?<block>\\{-[\\s\\S]*?-\\})",
    // triple string (greedy, matches """...""")
    '(?<triple>"""[\\s\\S]*?""")',
    // double-quoted string with escapes
    '(?<string>"(?:\\\\.|[^"\\\\])*")',
    // raw string r"..."
    '(?<raw>r"[^"]*")',
    // char literal 'x' or '\n'
    "(?<char>'(?:\\\\.|[^'\\\\])')",
    // universal literals: 500ms, #ff6600, 2025-01-20, 10MB, 45deg
    "(?<univ>#[0-9a-fA-F]{3,8}\\b|\\d+(?:\\.\\d+)?(?:ns|us|ms|s|min|h|d|w|mo|y|B|KB|MB|GB|TB|KiB|MiB|GiB|TiB|deg|rad|turn|grad)\\b|\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2})?)?)",
    // numbers
    "(?<number>0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?)",
    // identifier (decided later by keyword lookup)
    "(?<ident>[a-zA-Z_][a-zA-Z0-9_]*)",
    // operators
    "(?<op>\\|>|==|!=|<=|>=|<<|>>|&&|\\|\\||\\*\\*|\\?\\?|->|=>|\\.\\.=?|[+\\-*/%&|^~!<>=])",
  ].join("|"), "g");

  const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };
  function escapeHTML(s) { return s.replace(/[&<>"]/g, c => ESCAPE_MAP[c]); }

  function classify(tok, groups) {
    if (groups.comment) return "comment";
    if (groups.block)   return "comment";
    if (groups.triple)  return "string";
    if (groups.string)  return "string";
    if (groups.raw)     return "string";
    if (groups.char)    return "string";
    if (groups.univ)    return "number";
    if (groups.number)  return "number";
    if (groups.op)      return "operator";
    if (groups.ident) {
      const id = groups.ident;
      if (KEYWORDS.has(id))  return "keyword";
      if (CONSTANTS.has(id)) return "constant";
      if (TYPES.has(id))     return "type";
      if (BUILTINS.has(id))  return "builtin";
      if (/^[A-Z]/.test(id)) return "type";
      return null;
    }
    return null;
  }

  function highlight(source) {
    let out = "";
    let last = 0;
    for (const m of source.matchAll(TOKEN_RE)) {
      if (m.index > last) out += escapeHTML(source.slice(last, m.index));
      const cls = classify(m[0], m.groups);
      const html = escapeHTML(m[0]);
      out += cls ? `<span class="xs-${cls}">${html}</span>` : html;
      last = m.index + m[0].length;
    }
    if (last < source.length) out += escapeHTML(source.slice(last));
    return out;
  }

  // Default stylesheet (CSS variables for easy theming)
  const DEFAULT_CSS = `
    .xs-keyword  { color: var(--xs-kw-color, #cba6f7); font-weight: 600; }
    .xs-string   { color: var(--xs-str-color, #a6e3a1); }
    .xs-number   { color: var(--xs-num-color, #fab387); }
    .xs-comment  { color: var(--xs-comment-color, #6c7086); font-style: italic; }
    .xs-type     { color: var(--xs-type-color, #f9e2af); }
    .xs-builtin  { color: var(--xs-builtin-color, #89dceb); }
    .xs-constant { color: var(--xs-const-color, #f38ba8); }
    .xs-operator { color: var(--xs-op-color, #89b4fa); }
  `;

  function injectCSS() {
    if (typeof document === "undefined") return;
    if (document.getElementById("xs-highlight-css")) return;
    const s = document.createElement("style");
    s.id = "xs-highlight-css";
    s.textContent = DEFAULT_CSS;
    document.head.appendChild(s);
  }

  // ---- Optional: tree-sitter backend ----
  //
  // xsHighlight.useTreeSitter({ baseUrl }) swaps the regex tokenizer for a
  // tree-sitter one. The parser file is ~350kb and the runtime ~200kb, so
  // this only runs when the consumer opts in (bigger programs, better
  // nesting-aware colours, future editor tooling).
  //
  // After the promise resolves, xsHighlight.highlight(src) returns an
  // AST-walked rendering; if anything goes wrong loading, we leave the
  // regex version in place.

  let regexHighlight = highlight;
  let tsReady = null;

  function walkTS(tree, source) {
    const cursor = tree.walk();
    const out = [];
    let pos = 0;

    function classifyNode(nodeType) {
      // map tree-sitter node types to our xs-* classes
      switch (nodeType) {
        case "line_comment":
        case "block_comment":
          return "comment";
        case "string_literal":
        case "char_literal":
          return "string";
        case "number_literal":
        case "universal_literal":
          return "number";
        case "boolean_literal":
        case "null_literal":
          return "constant";
        case "primitive_type":
        case "type_identifier":
          return "type";
        case "self_expression":
          return "constant";
        default: return null;
      }
    }

    // Keywords the grammar matches as anonymous terminal nodes.
    const KEYWORD_TEXT = new Set([
      "fn", "fn*", "let", "var", "const",
      "struct", "enum", "trait", "impl", "class", "type", "effect", "tag",
      "import", "export", "from", "use", "module", "as", "plugin",
      "if", "elif", "else", "match", "when", "while", "for", "in", "loop",
      "return", "break", "continue", "yield",
      "try", "catch", "finally", "throw", "defer",
      "async", "await", "spawn", "nursery", "actor",
      "perform", "handle", "resume",
      "pub", "mut", "static", "inline", "unsafe", "where",
      "and", "or", "not", "is",
    ]);

    function visit() {
      const node = cursor.currentNode;
      const start = node.startIndex;
      const end = node.endIndex;
      const cls = classifyNode(node.type);

      // Anonymous keyword tokens (grammar's 'if', 'fn', ...) show up as
      // nodes with isNamed=false whose text is in KEYWORD_TEXT.
      let kwCls = null;
      if (!node.isNamed && KEYWORD_TEXT.has(node.type)) kwCls = "keyword";

      if (cls || kwCls) {
        if (start > pos) out.push({ text: source.slice(pos, start), cls: null });
        out.push({ text: source.slice(start, end), cls: cls || kwCls });
        pos = end;
        return; // don't descend
      }

      if (cursor.gotoFirstChild()) {
        do { visit(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    }
    visit();
    if (pos < source.length) out.push({ text: source.slice(pos), cls: null });

    let html = "";
    for (const t of out) {
      const esc = escapeHTML(t.text);
      html += t.cls ? `<span class="xs-${t.cls}">${esc}</span>` : esc;
    }
    return html;
  }

  function useTreeSitter(opts) {
    opts = opts || {};
    const baseUrl = opts.baseUrl || "";
    if (tsReady) return tsReady;

    tsReady = (async () => {
      // Pull in web-tree-sitter as an ES module
      const mod = await import(baseUrl + "/web-tree-sitter.js");
      const Parser = mod.Parser || mod.default || mod;
      await Parser.init({
        locateFile: (name) => baseUrl + "/" + name,
      });
      const Lang = mod.Language || Parser.Language;
      const lang = await Lang.load(baseUrl + "/tree-sitter-xs.wasm");
      const parser = new Parser();
      parser.setLanguage(lang);

      // swap out highlight()
      xsHighlight.highlight = (source) => {
        try {
          const tree = parser.parse(source);
          if (!tree) return regexHighlight(source);
          const html = walkTS(tree, source);
          tree.delete();
          return html;
        } catch (e) {
          return regexHighlight(source);
        }
      };
      return true;
    })().catch((err) => {
      console.warn("tree-sitter load failed, using regex highlighter", err);
      tsReady = null;
      return false;
    });

    return tsReady;
  }

  const xsHighlight = {
    highlight,
    injectCSS,
    useTreeSitter,
    KEYWORDS, TYPES, BUILTINS, CONSTANTS,
  };
  if (typeof window !== "undefined") window.xsHighlight = xsHighlight;
  if (typeof globalThis !== "undefined") globalThis.xsHighlight = xsHighlight;
  if (typeof module !== "undefined" && module.exports) module.exports = xsHighlight;
})();
