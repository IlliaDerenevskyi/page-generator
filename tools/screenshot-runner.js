const fs = require('fs');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : '';
}

function tokenize(value) {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

function overlap(source, rendered) {
    if (!source.length) return rendered.length ? 0 : 1;
    const set = new Set(rendered);
    return source.filter((token) => set.has(token)).length / source.length;
}

function symmetricOverlap(source, rendered) {
    if (!source.length && !rendered.length) return 1;
    if (!source.length || !rendered.length) return 0;
    return (overlap(source, rendered) + overlap(rendered, source)) / 2;
}

function visualSimilarity(reference, rendered) {
    if (reference.width !== rendered.width || reference.height !== rendered.height) return 0;
    let different = 0;
    const tolerance = 30;
    for (let index = 0; index < reference.data.length; index += 4) {
        const distance = Math.abs(reference.data[index] - rendered.data[index])
            + Math.abs(reference.data[index + 1] - rendered.data[index + 1])
            + Math.abs(reference.data[index + 2] - rendered.data[index + 2]);
        if (distance > tolerance) different += 1;
    }

    return 1 - (different / (reference.width * reference.height));
}

function perceptualSimilarity(reference, rendered) {
    if (reference.width !== rendered.width || reference.height !== rendered.height) return 0;
    let error = 0;
    for (let index = 0; index < reference.data.length; index += 4) {
        const ref = (reference.data[index] * 0.299) + (reference.data[index + 1] * 0.587) + (reference.data[index + 2] * 0.114);
        const actual = (rendered.data[index] * 0.299) + (rendered.data[index + 1] * 0.587) + (rendered.data[index + 2] * 0.114);
        error += Math.min(1, Math.abs(ref - actual) / 255);
    }
    return 1 - (error / (reference.width * reference.height));
}

function writeDiff(reference, rendered, outputPath) {
    if (!outputPath || reference.width !== rendered.width || reference.height !== rendered.height) return;
    const diff = new PNG({ width: reference.width, height: reference.height });
    for (let index = 0; index < reference.data.length; index += 4) {
        const distance = Math.abs(reference.data[index] - rendered.data[index])
            + Math.abs(reference.data[index + 1] - rendered.data[index + 1])
            + Math.abs(reference.data[index + 2] - rendered.data[index + 2]);
        const mismatch = distance > 30;
        diff.data[index] = mismatch ? 220 : 255;
        diff.data[index + 1] = mismatch ? 38 : 255;
        diff.data[index + 2] = mismatch ? 38 : 255;
        diff.data[index + 3] = mismatch ? 190 : 70;
    }
    fs.writeFileSync(outputPath, PNG.sync.write(diff));
}

async function main() {
    const url = argument('--url');
    const source = argument('--source');
    const schemaPath = argument('--schema');
    const width = Number(argument('--width'));
    const height = Number(argument('--height'));
    const diffPath = argument('--diff');
    const renderedPath = argument('--rendered');
    if (!url || !source || !schemaPath || !width || !height) {
        throw new Error('Missing --url, --source, --schema, --width or --height.');
    }
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const reference = PNG.sync.read(fs.readFileSync(source));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
        });
        const screenshot = await page.screenshot({ type: 'png', fullPage: false });
        if (renderedPath) fs.writeFileSync(renderedPath, screenshot);
        const rendered = PNG.sync.read(screenshot);
        writeDiff(reference, rendered, diffPath);
        const sourceText = [];
        const childNodes = (node) => node.children && node.children.length ? node.children : (node.elements || []);
        const collectText = (nodes) => (nodes || []).forEach((node) => {
            if (node.text || node.content) sourceText.push(node.text || node.content);
            collectText(childNodes(node));
        });
        collectText(schema.sections);
        const renderedText = await page.locator('body').innerText();
        const domCount = await page.locator('section,h1,h2,h3,h4,h5,p,img,button,a,nav,table,form,input,select,textarea').count();
        const countNodes = (nodes) => (nodes || []).reduce((count, node) => {
            return count + 1 + countNodes(childNodes(node));
        }, 0);
        const sourceNodeCount = Math.max(1, countNodes(schema.sections));
        const domSimilarity = Math.min(sourceNodeCount, domCount) / Math.max(sourceNodeCount, domCount);
        const result = {
            success: true,
            visualSimilarity: Math.round(visualSimilarity(reference, rendered) * 10000) / 100,
            perceptualSimilarity: Math.round(perceptualSimilarity(reference, rendered) * 10000) / 100,
            textSimilarity: Math.round(symmetricOverlap(tokenize(sourceText.join(' ')), tokenize(renderedText)) * 10000) / 100,
            domSimilarity: Math.round(domSimilarity * 10000) / 100,
            referenceSize: `${reference.width}x${reference.height}`,
            renderedSize: `${rendered.width}x${rendered.height}`,
            sourceTokenCount: tokenize(sourceText.join(' ')).length,
            renderedTokenCount: tokenize(renderedText).length,
            sourceNodeCount,
            renderedNodeCount: domCount,
            sourceTextSample: sourceText.join(' ').slice(0, 180),
            renderedTextSample: renderedText.slice(0, 180),
            diffCreated: Boolean(diffPath),
            differences: []
        };
        if (result.visualSimilarity < 85) result.differences.push('візуальна геометрія або кольори');
        if (result.textSimilarity < 85) result.differences.push('текстові блоки');
        if (result.domSimilarity < 85) result.differences.push('структура компонентів');
        process.stdout.write(JSON.stringify(result));
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    process.stdout.write(JSON.stringify({ success: false, error: error.message }));
    process.exitCode = 1;
});
