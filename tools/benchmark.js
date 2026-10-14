#!/usr/bin/env node
// Reference screenshot benchmark: builds a page from every PNG in a folder, reads the plugin's own comparison
// metrics and compares them with a stored baseline, so each change is checked with a single command.
//
//   node benchmark.js <screenshots-dir> [--baseline baseline.json] [--out results.json] [--update-baseline]
//
// Environment: PG_COOKIES (JSON file with wp-admin cookies, required), PG_POST (test post id, default 2),
// PG_URL (site origin, default http://localhost), PG_CHROMIUM (browser binary, default /usr/bin/chromium).
const fs = require('fs');
const path = require('path');

const METRICS = {
    visual: /Візуальна відповідність:\s*([\d.]+)%/,
    perceptual: /Перцептивна відповідність:\s*([\d.]+)%/,
    content: /Змістова відповідність:\s*([\d.]+)%/,
    worstZone: /найгірша зона:[^—]*—\s*([\d.]+)%/,
    text: /Текстова відповідність:\s*([\d.]+)%/,
    dom: /DOM-відповідність:\s*([\d.]+)%/,
};

function parseMetrics(status) {
    const text = String(status || '').replace(/\s+/g, ' ');
    const result = {};
    for (const [key, pattern] of Object.entries(METRICS)) {
        const match = text.match(pattern);
        if (match) {
            result[key] = parseFloat(match[1]);
        }
    }
    return result;
}

// Only these metrics decide a regression. The worst zone is one noisy cell and the DOM ratio counts nodes, so a newly found element can lower it; both are shown, never gated.
const GATED = ['visual', 'perceptual', 'content', 'text'];

// Returns one row per screenshot with the delta against the baseline; `regressed` when a gated metric dropped by more than `tolerance`.
function compareToBaseline(results, baseline, tolerance = 0.5) {
    return Object.entries(results).map(([name, metrics]) => {
        const previous = (baseline || {})[name];
        const deltas = {};
        let regressed = false;
        for (const key of Object.keys(METRICS)) {
            const gated = GATED.includes(key);
            if (typeof metrics[key] !== 'number') {
                regressed = regressed || (gated && Boolean(previous && typeof previous[key] === 'number'));
                continue;
            }
            if (previous && typeof previous[key] === 'number') {
                deltas[key] = Math.round((metrics[key] - previous[key]) * 100) / 100;
                if (gated && deltas[key] < -tolerance) {
                    regressed = true;
                }
            }
        }
        return { name, metrics, deltas, isNew: !previous, regressed };
    });
}

function formatReport(rows) {
    const cell = (value, delta) => {
        if (typeof value !== 'number') {
            return '—'.padStart(16);
        }
        const suffix = typeof delta === 'number' ? ` (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})` : '';
        return `${value.toFixed(2)}${suffix}`.padStart(16);
    };
    const keys = Object.keys(METRICS);
    const lines = ['screenshot'.padEnd(26) + keys.map((key) => key.padStart(16)).join('')];
    for (const row of rows) {
        const flag = row.regressed ? ' ПОГІРШЕННЯ' : row.isNew ? ' (новий)' : '';
        lines.push(row.name.slice(0, 25).padEnd(26) + keys.map((key) => cell(row.metrics[key], row.deltas[key])).join('') + flag);
    }
    return lines.join('\n');
}

async function buildAndCompare(browser, file, options) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(JSON.parse(fs.readFileSync(options.cookies, 'utf8')));
    const page = await context.newPage();
    try {
        await page.goto(`${options.url}/wp-admin/post.php?post=${options.post}&action=edit`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForSelector('.page-generator-topbar-button', { timeout: 180000 });
        await page.click('.page-generator-topbar-button');
        await page.click('[data-view="screenshots"]').catch(() => {});
        await page.waitForSelector('#pg-images', { state: 'attached', timeout: 30000 });
        await page.setInputFiles('#pg-images', file);
        await page.waitForSelector('#pg-build-screenshot:not([disabled])', { timeout: 120000 });
        await page.click('#pg-build-screenshot');
        await page.waitForFunction(() => jQuery('#pg-output-actions').is(':visible') || /помилк|Не вдалося/i.test(document.querySelector('#pg-status').textContent), null, { timeout: 300000 });
        await page.click('#pg-create-page');
        await page.waitForFunction(() => /Візуальна|не виконано|Не вдалося|помилк/i.test(document.querySelector('#pg-status').textContent), null, { timeout: 400000 }).catch(() => {});
        const status = await page.textContent('#pg-status');
        const metrics = parseMetrics(status);
        if (!Object.keys(metrics).length) {
            throw new Error(`у статусі немає метрик: ${status.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
        }
        return metrics;
    } finally {
        await context.close();
    }
}

async function main(argv) {
    const args = argv.slice(2);
    const flag = (name) => {
        const index = args.indexOf(name);
        return index === -1 ? null : args.splice(index, 2)[1];
    };
    const baselinePath = flag('--baseline');
    const outPath = flag('--out');
    const update = args.includes('--update-baseline');
    const dir = args.find((arg) => !arg.startsWith('--'));
    if (!dir || !process.env.PG_COOKIES) {
        console.error('Usage: PG_COOKIES=cookies.json node benchmark.js <screenshots-dir> [--baseline f.json] [--out f.json] [--update-baseline]');
        process.exit(2);
    }
    const options = {
        cookies: process.env.PG_COOKIES,
        post: process.env.PG_POST || '2',
        url: process.env.PG_URL || 'http://localhost',
    };
    const files = fs.readdirSync(dir).filter((name) => /\.png$/i.test(name)).sort();
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PG_CHROMIUM || '/usr/bin/chromium' });
    const results = {};
    try {
        for (const name of files) {
            process.stderr.write(`→ ${name}\n`);
            results[name] = await buildAndCompare(browser, path.join(dir, name), options).catch((error) => {
                process.stderr.write(`  помилка: ${error.message}\n`);
                return {};
            });
        }
    } finally {
        await browser.close();
    }
    const baseline = baselinePath && fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
    const rows = compareToBaseline(results, baseline);
    console.log(formatReport(rows));
    if (outPath) {
        fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    }
    const failed = Object.keys(results).filter((name) => Object.keys(results[name]).length === 0);
    if (failed.length) {
        console.error(`Не вдалося отримати метрики: ${failed.join(', ')}`);
    }
    if (update && baselinePath) {
        const fresh = Object.fromEntries(Object.entries(results).filter(([name]) => !failed.includes(name)));
        fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, ...fresh }, null, 2));
        console.log(`Baseline оновлено: ${baselinePath}`);
    }
    process.exit(failed.length ? 2 : rows.some((row) => row.regressed) ? 1 : 0);
}

if (require.main === module) {
    main(process.argv).catch((error) => {
        console.error('FAILED', error.message);
        process.exit(2);
    });
}

module.exports = { parseMetrics, compareToBaseline, formatReport };
