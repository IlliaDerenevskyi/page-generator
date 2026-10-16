# Reference screenshots

A fixed set of screenshots the plugin is measured against, so a change can be checked with one command instead of by eye.
Each file is built into a page by the real editor (OCR, layout analysis, export), and the plugin's own comparison reports how
close the result is to the screenshot.

## Run

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
| | `notion-login` | a single outlined email field, buttons |
| `heavy/` | `apple-ua` | photographic sections, long page |
| | `stripe` | gradients, baked-in text, product mockups |
| | `wikipedia-article` | very small text, serif headings, infobox |
| `holdout/` | `hacker-news` | plain markup, tiny text, no cards |
| | `mdn-flexbox` | documentation: sidebar, code blocks, long article |
| | `python-org` | dark landing, colour bands |
| | `bootstrap` | pastel gradient landing |
| | `ukr-net` | dense Cyrillic news portal, ad banners |
| | `diia` | government services, gradient hero, cookie dialog |
| | `vuejs` | light landing, large headings |
| | `django` | landing with a green header and side columns |
| | `python-docs` | documentation with tinted callouts |
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
