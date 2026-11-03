# Tenant sites

Static websites for demo tenants (HZ-706). Each site folder is published as-is,
so it carries its own `package.json` and `npm test`.

## parvati-site/

The base site for Parvati Real Estate, a fictional Manhattan brokerage. Plain
HTML and CSS with no build step and no JavaScript, rebuilt from the approved
design of 2 Nov 2026 (`Main` → `index.html`, then `buy.html`, `sell.html`,
`about.html` and `contact.html`).

- Every page repeats the same header (`<nav class="pv-navrow">`) and the same
  `<footer>`. Only the `aria-current="page"` link changes. The contact band
  above the footer is left out on Contact, as in the design. `test/base-site.test.mjs`
  fails if the copies drift apart.
- Shared styles live in `styles.css`. Section layout stays inline, as in the design.
- Photos are in `images/`. `CREDITS.md` lists each photographer and the Unsplash License.
- **No Neighbourhoods page and no header link to one.** Chapter B (HZ-701) adds
  `neighbourhoods.html` and the header link on camera.
- `data/sales.csv` holds 300 **fictional** Manhattan sales (Nov 2024 to Oct 2026)
  for the Chapter C Task (HZ-715). Its first line is a `#` note saying the data
  is fictional, so skip it when parsing. `data/generate-sales.mjs` writes it from
  a fixed seed, so every run gives the same file. Rerun the script rather than
  editing the CSV by hand. The site does not link to the file.

```sh
npm --prefix scripts/tenant-sites/parvati-site test          # links, images, sales.csv
npm --prefix scripts/tenant-sites/parvati-site run generate-sales
```

`npm test` prints pages checked, broken links, missing images and sales rows.
It exits non-zero and lists each failure by file and target, or by CSV row and column.

## Tests for this folder

```sh
npm --prefix scripts/tenant-sites test
```

- `check-links.test.mjs`: the site's `npm test` on a clean copy and on seeded failures.
- `sales-data.test.mjs`: `data/sales.csv` contents and generator reproducibility.
- `base-site.test.mjs`: exactly five pages, the shared header and footer, no Neighbourhoods.
- `secrets.test.mjs`: no token shapes or email addresses, and only 555-01xx phone numbers.

The root `npm test` does not run these yet. Neither suite makes network calls.

`scripts/recorder/` is a separate package. It is reference only: nothing here
imports it.
