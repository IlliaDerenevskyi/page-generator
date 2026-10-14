const test = require('node:test');
const assert = require('node:assert');
const { parseMetrics, compareToBaseline } = require('./benchmark');

test('parseMetrics reads the four similarity values from the status text', () => {
    const status = 'Page оновлено.Візуальна відповідність: 74.38%Перцептивна відповідність: 82.81%Текстова відповідність: 97.53%DOM-відповідність: 93.96%Reference: 1392x2560';
    assert.deepStrictEqual(parseMetrics(status), { visual: 74.38, perceptual: 82.81, text: 97.53, dom: 93.96 });
    assert.deepStrictEqual(parseMetrics('Не вдалося'), {});
});

test('compareToBaseline flags drops beyond the tolerance and marks new screenshots', () => {
    const baseline = { a: { visual: 75, perceptual: 83, content: 40, text: 98, dom: 93 }, b: { visual: 60, perceptual: 70, content: 30, text: 90, dom: 80 } };
    const results = {
        a: { visual: 74.6, perceptual: 83, content: 40, text: 98, dom: 93 },
        b: { visual: 58, perceptual: 70, content: 30, text: 90, dom: 80 },
        c: { visual: 50, perceptual: 50, text: 50, dom: 50 },
    };
    const rows = Object.fromEntries(compareToBaseline(results, baseline, 0.5).map((row) => [row.name, row]));
    assert.strictEqual(rows.a.regressed, false);
    assert.strictEqual(rows.b.regressed, true);
    assert.strictEqual(rows.b.deltas.visual, -2);
    assert.strictEqual(rows.c.isNew, true);
    assert.strictEqual(rows.c.regressed, false);
});

test('compareToBaseline treats a missing metric that existed in the baseline as a regression', () => {
    const rows = compareToBaseline({ a: {} }, { a: { visual: 75 } });
    assert.strictEqual(rows[0].regressed, true);
});

test('compareToBaseline does not treat a lower DOM ratio or worst zone as a regression', () => {
    const baseline = { a: { visual: 80, perceptual: 80, content: 40, text: 99, dom: 90, worstZone: 5 } };
    const rows = compareToBaseline({ a: { visual: 80, perceptual: 80, content: 40, text: 99, dom: 70, worstZone: 0 } }, baseline);
    assert.strictEqual(rows[0].regressed, false);
    assert.strictEqual(rows[0].deltas.dom, -20);
    const missingZone = compareToBaseline({ a: { visual: 80, perceptual: 80, content: 40, text: 99, dom: 90 } }, baseline);
    assert.strictEqual(missingZone[0].regressed, false);
});
