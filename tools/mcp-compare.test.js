const test = require('node:test');
const assert = require('node:assert/strict');
const { readResults } = require('./mcp-compare');

test('readResults keeps numeric metrics and marks failed runs as empty', () => {
    const results = readResults('noise\n{"file":"a.png","visual":90.5,"content":70,"dom":null}\n{"file":"b.png","failed":"Помилка"}\n');
    assert.deepEqual(results['a.png'], { visual: 90.5, content: 70 });
    assert.deepEqual(results['b.png'], {});
});
