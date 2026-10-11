const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSurfaces, classifySurfaces, detectLineRuns, groupWordsIntoLines, isPhotographic, detectBands } = require('../assets/detectors');

function canvas(width, height, color) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
        data.set([...color, 255], index * 4);
    }
    return { data, width, height };
}

function fill(image, x, y, width, height, color, radius = 0) {
    for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
            const cornerX = Math.min(column - x, x + width - 1 - column);
            const cornerY = Math.min(row - y, y + height - 1 - row);
            if (radius && cornerX < radius && cornerY < radius
                && Math.hypot(radius - cornerX, radius - cornerY) > radius) continue;
            image.data.set([...color, 255], (row * image.width + column) * 4);
        }
    }
}

function detect(image) {
    return classifySurfaces(detectSurfaces(image.data, image.width, image.height), image.width, image.data, image.height);
}

test('finds buttons, stacked inputs, badges and cards by geometry and colour only', () => {
    const image = canvas(1000, 900, [244, 247, 250]);
    fill(image, 40, 40, 920, 820, [255, 255, 255]);
    fill(image, 80, 80, 300, 70, [31, 138, 76], 10);
    [200, 300, 400].forEach((y) => {
        fill(image, 80, y, 840, 60, [241, 246, 249], 8);
    });
    fill(image, 780, 80, 120, 28, [222, 246, 231], 12);
    fill(image, 80, 520, 840, 70, [31, 138, 76], 10);
    const kinds = detect(image).map((surface) => surface.kind);
    assert.equal(kinds.filter((kind) => kind === 'button').length, 2);
    assert.equal(kinds.filter((kind) => kind === 'input').length, 3);
    assert.equal(kinds.filter((kind) => kind === 'badge').length, 1);
    assert.ok(kinds.includes('card'));
});

test('a single wide plate is not treated as an input field', () => {
    const image = canvas(1000, 400, [255, 255, 255]);
    fill(image, 80, 100, 840, 60, [241, 246, 249], 8);
    assert.equal(detect(image).filter((surface) => surface.kind === 'input').length, 0);
});

test('same-height lines on one axis with even spacing form a menu run', () => {
    const column = [0, 1, 2, 3].map((index) => ({ x: 20, y: 100 + index * 70, width: 140, height: 20 }));
    const runs = detectLineRuns(column);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].axis, 'column');
    assert.equal(runs[0].items.length, 4);
    const row = [0, 1, 2, 3].map((index) => ({ x: 100 + index * 160, y: 40, width: 100, height: 20 }));
    assert.equal(detectLineRuns(row)[0].axis, 'row');
});

test('two lines or uneven spacing are not a menu', () => {
    assert.equal(detectLineRuns([{ x: 20, y: 100, width: 140, height: 20 }, { x: 20, y: 170, width: 140, height: 20 }]).length, 0);
    const uneven = [100, 160, 330, 380].map((y) => ({ x: 20, y, width: 140, height: 20 }));
    assert.equal(detectLineRuns(uneven).length, 0);
});

test('words are ordered by x inside a line even when their tops differ', () => {
    const words = [
        { text: 'завтра', x: 234, y: 12, width: 70, height: 16 },
        { text: 'Тиша', x: 10, y: 14, width: 40, height: 14 },
        { text: 'сьогодні', x: 58, y: 10, width: 80, height: 18 },
        { text: 'комфорт', x: 146, y: 13, width: 80, height: 15 },
        { text: 'Другий', x: 10, y: 60, width: 60, height: 16 }
    ];
    const lines = groupWordsIntoLines(words);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].words.map((word) => word.text), ['Тиша', 'сьогодні', 'комфорт', 'завтра']);
});

test('a large horizontal gap on one row starts a separate line', () => {
    const lines = groupWordsIntoLines([
        { text: 'Район', x: 10, y: 10, width: 50, height: 16 },
        { text: 'Норма', x: 900, y: 10, width: 60, height: 16 }
    ]);
    assert.equal(lines.length, 2);
});

test('flat UI regions are not photographic, noisy regions are', () => {
    const image = canvas(400, 300, [255, 255, 255]);
    fill(image, 20, 20, 200, 60, [31, 138, 76], 8);
    for (let y = 150; y < 290; y += 1) {
        for (let x = 20; x < 380; x += 1) {
            const seed = (x * 7919 + y * 104729) % 256;
            image.data.set([seed, (seed * 3) % 256, (seed * 5) % 256, 255], (y * image.width + x) * 4);
        }
    }
    assert.equal(isPhotographic(image.data, image.width, { x: 20, y: 20, width: 200, height: 60 }), false);
    assert.equal(isPhotographic(image.data, image.width, { x: 20, y: 150, width: 360, height: 140 }), true);
});

test('page is split by edge colour and by wide empty gaps, independent of page height', () => {
    const image = canvas(600, 3000, [244, 247, 250]);
    fill(image, 0, 0, 600, 300, [255, 255, 255]);
    fill(image, 0, 2700, 600, 300, [17, 24, 39]);
    fill(image, 40, 400, 520, 200, [255, 255, 255]);
    fill(image, 40, 900, 520, 200, [255, 255, 255]);
    fill(image, 40, 1000, 520, 30, [31, 138, 76]);
    const bands = detectBands(image.data, image.width, image.height);
    assert.equal(bands[0].background, '#ffffff');
    assert.equal(bands[bands.length - 1].background, '#111827');
    assert.ok(bands.some((band) => band.y >= 300 && band.y < 400 + 100 && band.background === '#f4f7fa'));
    const body = bands.filter((band) => band.background === '#f4f7fa');
    assert.ok(body.length >= 2, 'two cards separated by a wide gap are two sections');
});
