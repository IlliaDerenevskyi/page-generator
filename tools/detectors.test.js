const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSurfaces, classifySurfaces, detectLineRuns, groupWordsIntoLines, isPhotographic, detectBands, flattenAlpha, estimateTextHeight, chooseOcrScale, resampleLanczos, prepareForOcr, assessResolution, detectOutline, detectIconBlobs, findIcons, isColourful, isRuleWord, detectPhotoRegions } = require('../assets/detectors');

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

function textLines(width, height, lineHeight, gap, ink = [0, 0, 0], paper = [255, 255, 255]) {
    const image = canvas(width, height, paper);
    for (let top = 10; top + lineHeight < height; top += lineHeight + gap) {
        for (let x = 8; x < width - 8; x += 6) fill(image, x, top, 2, lineHeight, ink);
    }
    return image;
}

test('Lanczos resampling keeps flat colour exact and produces the requested size', () => {
    const image = canvas(20, 10, [31, 138, 76]);
    const up = resampleLanczos(image.data, 20, 10, 80, 40);
    assert.equal(up.length, 80 * 40 * 4);
    for (let index = 0; index < up.length; index += 4) {
        assert.ok(Math.abs(up[index] - 31) <= 1 && Math.abs(up[index + 1] - 138) <= 1 && Math.abs(up[index + 2] - 76) <= 1);
    }
});

test('upscaling keeps a hard edge hard instead of smearing it', () => {
    const image = canvas(40, 4, [255, 255, 255]);
    fill(image, 20, 0, 20, 4, [0, 0, 0]);
    const up = resampleLanczos(image.data, 40, 4, 160, 16);
    const at = (x) => up[(8 * 160 + x) * 4];
    assert.ok(at(60) > 250 && at(100) < 5);
    const transition = Array.from({ length: 160 }, (_, x) => at(x)).filter((value) => value > 20 && value < 235).length;
    assert.ok(transition <= 8, 'edge transition spans only a few pixels, got ' + transition);
});

test('semi-transparent pixels are flattened to opaque ones that keep text visible', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0, 20, 20, 20, 255, 240, 240, 240, 128, 255, 255, 255, 255]);
    const flat = flattenAlpha(data);
    for (let index = 3; index < flat.length; index += 4) assert.equal(flat[index], 255);
});

test('text line height is measured from vertical strokes and ignores horizontal borders', () => {
    const image = textLines(400, 300, 14, 10);
    fill(image, 0, 150, 400, 2, [0, 0, 0]);
    assert.ok(Math.abs(estimateTextHeight(image.data, 400, 300) - 14) <= 2);
});

test('scale follows text size: small text is enlarged, readable text and huge images are left alone', () => {
    assert.equal(chooseOcrScale(0, 300, 300), 1);
    assert.equal(chooseOcrScale(34, 1200, 3000), 1);
    const small = chooseOcrScale(8, 300, 700);
    assert.ok(small >= 3.5 && small <= 4);
    assert.equal(chooseOcrScale(10, 3000, 9000), 1, 'an image already over the pixel budget is not enlarged');
    const budgeted = chooseOcrScale(10, 1500, 3000);
    assert.ok(budgeted > 1 && budgeted * budgeted * 1500 * 3000 <= 16000000 * 1.01);
});

test('prepareForOcr enlarges small text and reports the applied scale', () => {
    const small = textLines(200, 160, 8, 8);
    const result = prepareForOcr(small.data, 200, 160);
    assert.ok(result.scale > 1.5);
    assert.equal(result.width, Math.round(200 * result.scale));
    const readable = textLines(300, 300, 36, 20);
    assert.equal(prepareForOcr(readable.data, 300, 300).scale, 1);
});

test('a dark frame around the screenshot does not hide the text line height', () => {
    const image = textLines(310, 400, 8, 12);
    fill(image, 0, 0, 3, 400, [0, 0, 0]);
    fill(image, 307, 0, 3, 400, [0, 0, 0]);
    const height = estimateTextHeight(image.data, 310, 400);
    assert.ok(height >= 6 && height <= 10, 'measured ' + height);
    assert.ok(prepareForOcr(image.data, 310, 400).scale >= 3.5);
});

test('merging OCR passes keeps the more confident reading of the same word and adds words only one pass found', () => {
    const { mergeWordPasses } = require('../assets/detectors');
    const merged = mergeWordPasses([
        [{ text: 'Sernices', x: 10, y: 10, width: 60, height: 14, confidence: 41 }, { text: 'Work', x: 100, y: 10, width: 40, height: 14, confidence: 90 }],
        [{ text: 'Services', x: 11, y: 10, width: 60, height: 14, confidence: 88 }, { text: 'Contact', x: 10, y: 80, width: 60, height: 14, confidence: 70 }]
    ]);
    assert.deepEqual(merged.map((word) => word.text), ['Services', 'Work', 'Contact']);
});

test('assessResolution advises on narrow, tiny-text and empty inputs', () => {
    const words = (height) => Array.from({ length: 5 }, () => ({ height }));
    assert.deepEqual(assessResolution(1440, words(20)), []);
    assert.equal(assessResolution(600, words(20)).length, 1);
    assert.match(assessResolution(1440, words(6))[0], /дрібний/);
    assert.match(assessResolution(1440, [])[0], /не розпізнано/);
    assert.match(assessResolution(5000, words(20))[0], /великий/);
});

test('a button whose gradient stops the flood fill halfway is still a button', () => {
    const width = 400;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (y0, y1, [r, g, b]) => {
        for (let y = y0; y < y1; y += 1) {
            for (let x = 50; x < 350; x += 1) {
                const index = (y * width + x) * 4;
                data[index] = r;
                data[index + 1] = g;
                data[index + 2] = b;
            }
        }
    };
    paint(50, 62, [35, 130, 225]);
    paint(62, 70, [28, 118, 210]);
    const surfaces = classifySurfaces(detectSurfaces(data, width, height), width, data, height);
    const plate = surfaces.find((surface) => surface.y === 50);
    assert.ok(plate, 'the upper part of the button is detected as a surface');
    assert.equal(plate.kind, 'button');
});

test('detectOutline finds a thin border around a white field on a white page and ignores a bare white area', () => {
    const width = 400;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const line = [233, 232, 230];
    for (let x = 49; x <= 350; x += 1) {
        [49, 90].forEach((y) => data.set([...line, 255], (y * width + x) * 4));
    }
    for (let y = 49; y <= 90; y += 1) {
        [49, 350].forEach((x) => data.set([...line, 255], (y * width + x) * 4));
    }
    const field = { x: 50, y: 50, width: 300, height: 40, fill: [255, 255, 255] };
    assert.ok(detectOutline(field, data, width, height));
    assert.equal(detectOutline(field, data, width, height).color, '#e9e8e6');
    assert.equal(detectOutline({ x: 50, y: 140, width: 300, height: 40, fill: [255, 255, 255] }, data, width, height), null);
});

function iconPage() {
    const width = 400;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (x0, y0, x1, y1, [r, g, b]) => {
        for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) data.set([r, g, b, 255], (y * width + x) * 4);
        }
    };
    const ring = (x0, y0, size, colour) => {
        paint(x0, y0, x0 + size, y0 + size, colour);
        paint(x0 + 4, y0 + 4, x0 + size - 4, y0 + size - 4, [255, 255, 255]);
    };
    return { width, height, data, paint, ring };
}

test('detectIconBlobs finds small graphics and ignores words and oversized areas', () => {
    const { width, height, data, paint, ring } = iconPage();
    ring(50, 50, 18, [30, 30, 30]);
    ring(200, 50, 18, [30, 30, 30]);
    paint(40, 150, 360, 290, [30, 30, 30]);
    const blobs = detectIconBlobs(data, width, height, [{ x: 200, y: 50, width: 18, height: 18 }]);
    assert.equal(blobs.length, 1);
    assert.deepEqual([blobs[0].x, blobs[0].y, blobs[0].width, blobs[0].height], [50, 50, 18, 18]);
});

test('findIcons drops a single junk character on a picture but keeps short real words as text', () => {
    const { width, height, data, ring } = iconPage();
    ring(50, 50, 18, [30, 30, 30]);
    ring(200, 50, 18, [30, 30, 30]);
    const junk = { text: '@', x: 50, y: 50, width: 18, height: 18 };
    const real = { text: 'in', x: 200, y: 50, width: 18, height: 18 };
    const found = findIcons(data, width, height, [junk, real]);
    assert.equal(found.icons.length, 1);
    assert.equal(found.icons[0].x, 50);
    assert.deepEqual(found.droppedWords, [junk]);
});

test('isColourful needs saturation over much of the area, so anti-aliasing fringes on text do not count', () => {
    const { width, data, paint } = iconPage();
    paint(50, 50, 68, 68, [30, 30, 30]);
    [[50, 50, [220, 40, 40]], [51, 50, [40, 40, 220]], [52, 50, [40, 200, 40]], [53, 50, [230, 190, 20]]].forEach(([x, y, c]) => data.set([...c, 255], (y * width + x) * 4));
    assert.equal(isColourful(data, width, { x: 50, y: 50, width: 18, height: 18 }), false);
    paint(120, 50, 129, 59, [220, 40, 40]);
    paint(129, 50, 138, 59, [40, 200, 40]);
    paint(120, 59, 129, 68, [40, 80, 230]);
    paint(129, 59, 138, 68, [230, 190, 20]);
    assert.equal(isColourful(data, width, { x: 120, y: 50, width: 18, height: 18 }), true);
});

test('a dark panel on a light page is a card, not just a light one', () => {
    const width = 400;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4).fill(245);
    for (let y = 40; y < 200; y += 1) {
        for (let x = 30; x < 230; x += 1) data.set([0, 0, 0, 255], (y * width + x) * 4);
    }
    const surfaces = classifySurfaces(detectSurfaces(data, width, height), width, data, height);
    const panel = surfaces.find((surface) => surface.x === 30 && surface.y === 40);
    assert.ok(panel);
    assert.equal(panel.kind, 'card');
});

test('findIcons keeps a one-letter word inside a line of text but drops a lone letter on a picture', () => {
    const { width, height, data, ring } = iconPage();
    ring(50, 50, 18, [30, 30, 30]);
    ring(200, 50, 18, [30, 30, 30]);
    const inLine = { text: 'в', x: 200, y: 50, width: 18, height: 18 };
    const neighbour = { text: 'анабиоз', x: 222, y: 50, width: 80, height: 18 };
    const alone = { text: 'G', x: 50, y: 50, width: 18, height: 18 };
    const found = findIcons(data, width, height, [alone, inLine, neighbour]);
    assert.deepEqual(found.droppedWords, [alone]);
    assert.equal(found.icons.length, 1);
    assert.equal(found.icons[0].x, 50);
});

test('a vivid blue pill is a button while a pale pill stays a badge', () => {
    const width = 1000;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const pill = (x0, y0, w, h, colour) => {
        for (let y = y0; y < y0 + h; y += 1) {
            for (let x = x0; x < x0 + w; x += 1) {
                const corner = (x - x0 < 6 && y - y0 < 6) || (x0 + w - x <= 6 && y - y0 < 6) || (x - x0 < 6 && y0 + h - y <= 6) || (x0 + w - x <= 6 && y0 + h - y <= 6);
                if (!corner) data.set([...colour, 255], (y * width + x) * 4);
            }
        }
    };
    pill(100, 100, 200, 40, [0, 113, 227]);
    pill(500, 100, 150, 30, [220, 245, 225]);
    const surfaces = classifySurfaces(detectSurfaces(data, width, height), width, data, height);
    assert.equal(surfaces.find((surface) => surface.x === 100 && surface.y === 100).kind, 'button');
    assert.equal(surfaces.find((surface) => surface.x === 500 && surface.y === 100).kind, 'badge');
});

test('isRuleWord rejects thin border lines read as characters but keeps real letters', () => {
    assert.equal(isRuleWord({ text: '|', x: 0, y: 0, width: 4, height: 86 }), true);
    assert.equal(isRuleWord({ text: 'I', x: 0, y: 0, width: 4, height: 60 }), true);
    assert.equal(isRuleWord({ text: 'I', x: 0, y: 0, width: 10, height: 30 }), false);
    assert.equal(isRuleWord({ text: 'l', x: 0, y: 0, width: 8, height: 24 }), false);
    assert.equal(isRuleWord({ text: 'Get', x: 0, y: 0, width: 4, height: 86 }), false);
});

test('detectSurfaces measures the corner radius of a pill and of a lightly rounded plate', () => {
    const width = 600;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const plate = (x0, y0, w, h, radius) => {
        for (let y = y0; y < y0 + h; y += 1) {
            for (let x = x0; x < x0 + w; x += 1) {
                const cx = Math.min(Math.max(x, x0 + radius), x0 + w - 1 - radius);
                const cy = Math.min(Math.max(y, y0 + radius), y0 + h - 1 - radius);
                if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) data.set([0, 113, 227, 255], (y * width + x) * 4);
            }
        }
    };
    plate(30, 40, 220, 44, 22);
    plate(320, 40, 220, 44, 6);
    const surfaces = detectSurfaces(data, width, height);
    const pill = surfaces.find((surface) => surface.x === 30);
    const light = surfaces.find((surface) => surface.x === 320);
    assert.ok(pill.rounded >= 16 && pill.rounded <= 22, 'pill radius ' + pill.rounded);
    assert.ok(light.rounded >= 3 && light.rounded <= 9, 'light radius ' + light.rounded);
});

test('detectPhotoRegions finds a picture, and ignores a flat button, a thin seam and masked text', () => {
    const width = 1000;
    const height = 600;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 100; y < 300; y += 1) {
        for (let x = 100; x < 400; x += 1) {
            const base = 60 + (x - 100) / 3;
            data.set([base + random() * 80, 120 + random() * 90, 200 - (y - 100) / 2 + random() * 40, 255], (y * width + x) * 4);
        }
    }
    for (let y = 400; y < 460; y += 1) {
        for (let x = 500; x < 800; x += 1) data.set([0, 113, 227, 255], (y * width + x) * 4);
    }
    for (let x = 0; x < width; x += 1) {
        for (let y = 520; y < 528; y += 1) data.set([30, 30, 30, 255], (y * width + x) * 4);
    }
    const found = detectPhotoRegions(data, width, height, []);
    assert.equal(found.length, 1);
    assert.ok(Math.abs(found[0].x - 100) <= 16 && Math.abs(found[0].y - 100) <= 16);
    assert.ok(found[0].width >= 280 && found[0].height >= 180);
    assert.equal(detectPhotoRegions(data, width, height, [{ x: 100, y: 100, width: 300, height: 200 }]).length, 0);
});

test('detectPhotoRegions stretches over a word that lies partly on the picture', () => {
    const width = 1000;
    const height = 600;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    let seed = 11;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 100; y < 300; y += 1) {
        for (let x = 300; x < 700; x += 1) data.set([60 + random() * 120, 120 + random() * 90, 200 + random() * 40, 255], (y * width + x) * 4);
    }
    const word = { x: 260, y: 180, width: 100, height: 30 };
    const [region] = detectPhotoRegions(data, width, height, [word]);
    assert.ok(region.x <= 260, 'region starts at or before the word: ' + region.x);
    assert.ok(region.x + region.width >= 700);
});
