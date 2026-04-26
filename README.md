# static

CDN bucket for the XS browser SDK. Hosts `xs.wasm` and `xs.js` at
`static.xslang.org`. The wasm asset is auto-synced from the latest
[xs](https://github.com/xs-lang0/xs) release via the daily workflow
in `.github/workflows/sync.yml`.

```html
<script src="https://static.xslang.org/xs.js"></script>
<script>
  const xs = await loadXS()
  await xs.run('println("hello from the browser")')
</script>
```
