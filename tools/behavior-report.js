// node behavior-report.js results.jsonl : what the descriptions turned into on each page (from a run made with `php mcp-make.php <dir> describe`).
// Per page: sentences, those the dictionary did not understand, the labels found on the page and the labels that were not.
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node behavior-report.js results.jsonl'); process.exit(1); }
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const total = { sentences: 0, unknown: 0, labels: 0, bound: 0, unbound: 0, nolabel: 0 };
rows.forEach((row) => {
    if (!row.behavior) return;
    const first = JSON.parse(row.behavior);
    // A run now returns a summary (counts and issues); an older run returned the whole report.
    if (!Array.isArray(first)) {
        total.sentences += first.sentences; total.unknown += first.unknown; total.bound += first.bound; total.unbound += first.unbound; total.nolabel += first.noElement;
        console.log(`${row.file.padEnd(28)} sentences ${String(first.sentences).padStart(2)}  unknown ${first.unknown}  labels found ${String(first.bound).padStart(2)}  not found ${String(first.unbound).padStart(2)}  no element ${first.noElement}`);
        first.issues.forEach((issue) => console.log(`    ${issue}`));
        return;
    }
    const report = first;
    const unknown = report.filter((entry) => entry.action === 'unknown');
    const anchors = report.filter((entry) => entry.action === 'anchors');
    const others = report.filter((entry) => entry.action !== 'unknown' && entry.action !== 'anchors');
    const bound = others.reduce((sum, entry) => sum + (entry.labels || []).length, 0) + anchors.reduce((sum, entry) => sum + (entry.links || []).length, 0);
    const unbound = others.reduce((sum, entry) => sum + (entry.unbound || []).length, 0) + anchors.reduce((sum, entry) => sum + (entry.unlinked || []).length, 0);
    const nolabel = others.filter((entry) => !(entry.labels || []).length && !(entry.unbound || []).length).length + anchors.filter((entry) => !entry.ok).length;
    total.sentences += report.length; total.unknown += unknown.length; total.bound += bound; total.unbound += unbound; total.nolabel += nolabel;
    console.log(`${row.file.padEnd(28)} sentences ${String(report.length).padStart(2)}  unknown ${unknown.length}  labels found ${String(bound).padStart(2)}  not found ${String(unbound).padStart(2)}  no element ${nolabel}`);
    unknown.forEach((entry) => console.log(`    unknown: ${entry.source}`));
    others.filter((entry) => (entry.unbound || []).length).forEach((entry) => console.log(`    ${entry.action}: not found on the page: ${entry.unbound.join(', ')}`));
    anchors.filter((entry) => !entry.ok || (entry.unlinked || []).length).forEach((entry) => console.log(`    anchors: ${entry.ok ? 'no section for ' + entry.unlinked.join(', ') : entry.message}`));
    others.filter((entry) => !(entry.labels || []).length && !(entry.unbound || []).length).forEach((entry) => console.log(`    ${entry.action}: ${entry.message || 'no element named'} («${entry.source}»)`));
});
const labels = total.bound + total.unbound;
console.log(`\ntotal: ${total.sentences} sentences, ${total.unknown} not understood; ${total.bound} of ${labels} labels found on the pages (${labels ? Math.round(100 * total.bound / labels) : 0}%), ${total.nolabel} sentences name no element`);
