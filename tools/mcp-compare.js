#!/usr/bin/env node
// Compares results gathered through the Playwright MCP (see mcp-run.js) with a baseline, with the same rules as benchmark.js.
//
//   node mcp-compare.js <results.jsonl> [--holdout [--details]] [--baseline file] [--update-baseline]
//
// results.jsonl has one JSON object per line: {"file":"x.png","visual":..,"perceptual":..,"content":..,"worstZone":..,"text":..,"dom":..}.
// The baseline defaults to references/baseline.json (references/baseline-holdout.json with --holdout).
const fs = require('fs');
const path = require('path');
const { compareToBaseline, formatReport, formatSummary } = require('./benchmark');

function readResults(text) {
    const results = {};
    for (const line of text.split('\n').filter((row) => row.trim().startsWith('{'))) {
        const { file, failed, ...metrics } = JSON.parse(line);
        results[file] = failed ? {} : Object.fromEntries(Object.entries(metrics).filter(([, value]) => typeof value === 'number'));
    }
    return results;
}

function main(argv) {
    const args = argv.slice(2);
    const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
    const baselineFlag = flag('--baseline');
    const holdout = args.includes('--holdout');
    const details = args.includes('--details');
    const update = args.includes('--update-baseline');
    const input = args.find((arg) => !arg.startsWith('--'));
    if (!input) { console.error('usage: node mcp-compare.js <results.jsonl> [--holdout [--details]] [--baseline file] [--update-baseline]'); process.exit(2); }
    const baselinePath = baselineFlag || path.join(__dirname, 'references', holdout ? 'baseline-holdout.json' : 'baseline.json');
    const results = readResults(fs.readFileSync(input, 'utf8'));
    const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
    const rows = compareToBaseline(results, baseline);
    console.log(holdout && !details ? formatSummary(rows) : formatReport(rows));
    const failed = Object.keys(results).filter((name) => Object.keys(results[name]).length === 0);
    if (failed.length) console.error(`Не вдалося отримати метрики: ${failed.join(', ')}`);
    if (update) {
        const fresh = Object.fromEntries(Object.entries(results).filter(([name]) => !failed.includes(name)));
        fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, ...fresh }, null, 2));
        console.log(`Baseline оновлено: ${baselinePath}`);
    }
    process.exit(failed.length ? 2 : rows.some((row) => row.regressed) ? 1 : 0);
}

if (require.main === module) main(process.argv);
module.exports = { readResults };
