const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.join(__dirname, 'references');
const listFiles = (folders) => folders.flatMap((folder) => fs.readdirSync(path.join(root, folder)).filter((name) => /\.png$/i.test(name)).map((name) => ({ folder, name })));
const referenceFiles = listFiles(['desktop', 'heavy']);
const holdoutFiles = listFiles(['holdout']);

test('every reference screenshot is a valid PNG within the plugin limits', () => {
    assert.ok(referenceFiles.length >= 8);
    for (const { folder, name } of referenceFiles) {
        const png = PNG.sync.read(fs.readFileSync(path.join(root, folder, name)));
        assert.ok(png.height <= 10000 && png.width * png.height <= 40000000, `${name}: ${png.width}x${png.height} is over the limit`);
        assert.ok(png.width >= 900, `${name}: too narrow to be a desktop reference`);
    }
});

test('every reference has a baseline entry with the gated metrics, and the baseline has no stale entries', () => {
    const baselinePath = path.join(root, 'baseline.json');
    assert.ok(fs.existsSync(baselinePath), 'references/baseline.json is missing: run `npm run bench:update`');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    for (const { name } of referenceFiles) {
        assert.ok(baseline[name], `${name} has no baseline`);
        for (const key of ['visual', 'perceptual', 'content', 'text']) {
            assert.strictEqual(typeof baseline[name][key], 'number', `${name}: baseline lacks ${key}`);
        }
    }
    const known = new Set(referenceFiles.map((file) => file.name));
    for (const name of Object.keys(baseline)) assert.ok(known.has(name), `baseline entry ${name} has no file`);
});

test('the README lists every reference', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    for (const { name } of referenceFiles) assert.ok(readme.includes(name.replace(/\.png$/i, '')), `${name} is not described in references/README.md`);
});

test('the hold-out set is a separate, measured set that the tuning baseline does not mention', () => {
    assert.ok(holdoutFiles.length >= 8);
    const holdout = JSON.parse(fs.readFileSync(path.join(root, 'baseline-holdout.json'), 'utf8'));
    const tuning = JSON.parse(fs.readFileSync(path.join(root, 'baseline.json'), 'utf8'));
    for (const { name } of holdoutFiles) {
        assert.ok(holdout[name], `${name} has no hold-out baseline`);
        assert.strictEqual(tuning[name], undefined, `${name} is in both sets`);
        const png = PNG.sync.read(fs.readFileSync(path.join(root, 'holdout', name)));
        assert.ok(png.height <= 10000 && png.width * png.height <= 40000000, `${name} is over the plugin limit`);
    }
    for (const name of Object.keys(holdout)) assert.ok(holdoutFiles.some((file) => file.name === name), `hold-out entry ${name} has no file`);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    for (const { name } of holdoutFiles) assert.ok(readme.includes(name.replace(/\.png$/i, '')), `${name} is not described in the README`);
});
