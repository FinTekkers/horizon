## Web-page visual (HO-862)

This project has web-page visuals on. When a picture helps the owner more than
prose — a screen mock, a flow or architecture diagram, a comparison table — you
may add one optional key to your JSON reply, next to `artifact_md`:

  "page_html": "<one complete, self-contained HTML document>"

Leave the key out when a page would not help. The owner opens the page from the
item page; a later round replaces it at the same link.

Rules. A page that breaks any of them fails your reply, naming the cause:
- One document: `<!doctype html><html>…<body>…</body></html>`, under 200,000 bytes.
- Inline `<style>` and `<script>` only. No external URL of any kind: no CDN, font,
  image, `@import`, `url(…)` other than `data:`, or `src=`/`href=` to a file.
- Readable source, as a reviewer would write it: no minified code, no line over
  2,000 characters, no base64 or other encoded blob. Draw with inline SVG or CSS.
- No network: no `fetch`, `XMLHttpRequest`, WebSocket or navigation. The page runs
  sandboxed with no cookies or `localStorage`; touching them is an error.
- No console errors and no uncaught exceptions.
- No secrets, tokens or credential values, and no real names or email addresses.
  Use placeholder data; emails only at `example.com`.
- Escape it as a JSON string: `"` as `\"`, newlines as `\n`. Never put the page
  text in `artifact_md` or `summary`.
