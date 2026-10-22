# Reference screenshots

A fixed set of screenshots the plugin is measured against, so a change can be checked with one command instead of by eye.
Each file is built into a page by the real editor (OCR, layout analysis, export), and the plugin's own comparison reports how
close the result is to the screenshot.

## Run

Two ways, same numbers (checked: all 9 hold-out pages gave identical results in both):

**Through the Playwright MCP (preferred, the browser is visible and can be inspected between steps):**

```
php dev-cookies.php                          # once per 12 hours (writes tools/.cookies.json)
php mcp-make.php references/holdout          # or references/desktop, references/heavy, or one .png: writes tools/.mcp-run.js
# run it with the MCP tool browser_run_code_unsafe, filename = tools/.mcp-run.js; it returns one JSON line per screenshot
# save those lines to a file, then:
node mcp-compare.js results.jsonl [--holdout [--details]] [--update-baseline]
php mcp-make.php <png> schema                # same, but returns the section list with styles instead of the metrics (debugging)
php mcp-make.php references/holdout elementor          # the page is built as an Elementor tree (same server code, no Elementor editor)
php mcp-make.php references/holdout elementor-editor   # the real path: Elementor's own editor, "Вставити в Elementor", Elementor's save
```

**Headless, no MCP (CI-style):**

```
php dev-cookies.php          # once per 12 hours: wp-admin cookies for the headless browser (writes tools/.cookies.json)
npm run bench                # all references; compares with references/baseline.json, exit 1 on a regression
npm run bench:update         # same, then stores the new numbers as the baseline (do this after an intended change)
npm run bench:holdout        # the hold-out set: averages only (see "Two sets")
node benchmark.js <dir> [--baseline f.json] [--out results.json]   # any other folder of PNGs
```

Needs a WordPress site with the plugin active (`PG_URL`, default `http://localhost`), a page to rebuild (`PG_POST`, default `2`:
the run **overwrites its content**, so use a scratch page), Chromium (`PG_CHROMIUM`, default `/usr/bin/chromium`) and
`npm install` in this folder. Do not edit plugin files while it runs: the numbers would mix two versions.

Script and stylesheet URLs carry the file's modification time (`asset_version()`), so an edited `editor.js` or `detectors.js` is
fetched fresh; before that, a browser that kept its cache between runs (the MCP one does) measured the previous code.

## The screenshots are not in git

The PNG folders (`desktop/`, `heavy/`, `holdout/`, `mobile/`) are in `.gitignore`: they are large, and some captures can show
personal data (a logged-in account in a menu). Keep them on your machine; a fresh clone has none, and `references.test.js` then
skips its checks. Only what is small and safe is tracked: this README, the two baselines and the HTML sources of the synthetic
pages (`gradients-css.html`, `backdrops-css.html`, `gradients-multi.html`, `fonts-css.html`, `form-required.html`, `anchors-menu.html`). A synthetic PNG
is rebuilt from its source with `chromium --headless --hide-scrollbars --window-size=1370,<height> --screenshot=desktop/<name>.png file://$PWD/<name>.html`.
Hold-out pages must be captured again (1370 px viewport, 1x, cut to 4000 px, logged out).

## Two sets: tuning and hold-out

The detectors contain many empirical thresholds (what counts as a card, a pill-shaped button, a photo, an icon). They were found
by looking at the **tuning set** (`desktop/`, `heavy/`), so numbers on it say whether a change broke something, but they are
optimistic: the thresholds were chosen to fit those pages.

The **hold-out set** (`holdout/`) is pages nobody tuned on. It answers a different question: how well does the plugin do on a
page it has not seen? Rules for keeping it honest:

- `npm run bench:holdout` prints only averages and counts (add `--details` for per-file lines when a run fails or errors).
  Do not use per-file numbers to adjust thresholds.
- If a hold-out page was studied to fix something, move it to `desktop/` (and `bench:update`), and capture a fresh hold-out
  page in its place. A page that has been looked at is no longer a test.
- Change the baseline (`node benchmark.js --holdout --update-baseline`) only after a real, general improvement.

Measured on 2026-10-16, before any tuning on it: tuning set mean visual 89.6 / content 68.7, hold-out mean visual 78.2 / content 54.0.
Part of that gap is real overfitting; part is that the hold-out pages are harder (gradients, ad banners, cookie dialogs, dense
news layout), and the two cannot be separated from these numbers alone.

A run is a regression when `visual`, `perceptual`, `content` or `text` drops by more than 0.5 points. `worstZone` (one noisy
grid cell) and `dom` (a node count that grows when a new element is found) are printed but never fail the run.

## What is in the set

| Folder | File | What it stresses |
|---|---|---|
| `desktop/` | `azure-node-service` | dark admin UI, sidebar, many small icons |
| | `github-repo` | dense text, file list, light UI |
| | `lab6` | a plain responsive site: cards, table, form (the "Акустична варта" page) |
| | `nodejs-org` | large headings, dark/light bands |
| | `mdn-flexbox` | documentation: sidebar, code blocks, long article (moved here from `holdout/` on 2026-10-21: it was studied by eye to fix a regression, so it no longer counts as unseen) |
| | `notion-login` | a single outlined email field, buttons |
| | `gradients-css` | **synthetic** page of our own (source: `gradients-css.html`): CSS linear gradients on a hero, cards and a band; guards the gradient detector and both exporters |
| | `backdrops-css` | **synthetic** page of our own (source: `backdrops-css.html`): a mesh-gradient hero and a radial-gradient band; guards the soft-backdrop detector (background cut out as a picture, text removed) |
| | `gradients-multi` | **synthetic** page of our own (source: `gradients-multi.html`): a four-colour and a five-colour ramp; guards multi-stop gradient detection (Gutenberg/HTML keep every stop, Elementor keeps its ends and the middle stop that bends most) |
| | `fonts-css` | **synthetic** page of our own (source: `fonts-css.html`): serif, sans and monospace lines; guards the font-family detection (serif by stroke contrast, monospace by an equal character pitch) |
| | `form-required` | **synthetic** page of our own (source: `form-required.html`): a contact form with two fields marked `*`; guards the required-field flag |
| | `anchors-menu` | **synthetic** page of our own (source: `anchors-menu.html`): a top menu of four items and four sections titled like them; with the description "у верхньому меню є 4 пункти, кожен веде на відповідний розділ" the items must lead to the sections (anchors) |
| `heavy/` | `apple-ua` | photographic sections, long page |
| | `stripe` | gradients, baked-in text, product mockups |
| | `wikipedia-article` | very small text, serif headings, infobox |
| `holdout/` | `hacker-news` | plain markup, tiny text, no cards |
| | `python-org` | dark landing, colour bands |
| | `bootstrap` | pastel gradient landing |
| | `ukr-net` | dense Cyrillic news portal, ad banners |
| | `diia` | government services, gradient hero, cookie dialog |
| | `vuejs` | light landing, large headings |
| | `django` | landing with a green header and side columns |
| | `python-docs` | documentation with tinted callouts |
| | `rozetka` | online-store catalogue: banner carousel, product-card grid with price and badges, left menu, lazy-loading image placeholders (captured 2026-10-21 at 2x, reduced to 1x and cut to 4000 px) |
| | `www.foxtrot.com.ua_` | Ukrainian electronics store: promo banner, left category menu with icons, banner carousel, brand-logo grid, long SEO text, dark footer with link columns (captured 2026-10-22, never tuned on) |
| `mobile/` | `lab6-mobile-390` | the same page at 390 px, for the mobile layout (not run by `benchmark.js`) |

Heavy files are cut to 5000 px and hold-out pages to 4000 px, so a run stays within the plugin's limits (height 10000 px, 40 megapixels).
Hold-out pages were captured live from the public sites on 2026-10-16 (1370 px viewport, 1x), exactly as they were, banners included.

## Provenance, and what the numbers mean

These files are **not original captures**. The originals were lost; the images here were rebuilt from the copies the plugin
had stored (2x upscaled), reduced back by half with Lanczos. They are close to a real 1x screenshot but a little softer, so
the baseline is valid for *this* set only and must not be compared with numbers measured on other captures of the same sites.
`azure-node-service` is a logged-in portal and cannot be recaptured. The other sites are public but change over time, which is
why the images are kept here instead of being fetched.

`content` is the coarsest metric (8x8 px blocks; the background does not count), and `dom` counts nodes, not quality: use them
to see direction, not to rank two versions that differ by a point or two. Nothing here measures flow layout: the comparison is
by pixels and flow deliberately moves things.

## Mobile layout check (manual)

The mobile pair for lab6 is `desktop/lab6.png` plus `mobile/lab6-mobile-390.png` (upload both in the editor; the narrow one is
detected as the mobile layout). To measure the result at phone width:

```
node screenshot-runner.js --url <page-url> --allowed-host <host> --source references/mobile/lab6-mobile-390.png \
     --schema schema.json --cookies <runner-cookies.json> --diff diff.png --rendered rendered.png --width 390 --height 4934
```

## Adding a reference

Put a PNG (1x, desktop width ~1370-1440) in `desktop/` or `heavy/`, run `npm run bench:update`, and add a row to the table above.
Keep it under ~3 MB; a new file gets a baseline on its first update and is never reported as a regression.

## Descriptions (behaviour)

`descriptions.json` holds, per screenshot, a description of what the page does ("кнопка Code відкриває випадаюче меню ...") written the way a person
would write it. A plain run (`php mcp-make.php <dir>`) measures without descriptions, so the baselines stay comparable; with `describe`
(`php mcp-make.php <dir> describe`) each screenshot gets its description and the run also returns what the description became: sentences, those
the dictionary did not understand, labels found on the page and labels that were not (`node behavior-report.js results.jsonl` prints it).
`detectors.test.js` checks that every description is understood by the dictionary of meanings (no sentence is left `unknown`). The visual metrics
of a `describe` run must stay at the baseline: a description changes what the page means, not how it looks.
