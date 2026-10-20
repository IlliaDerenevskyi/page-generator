const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : '';
}

function unsafeIpAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const octets = address.split('.').map(Number);
        const [first, second] = octets;
        return first === 0 || first === 10 || first === 127 || first >= 224
            || (first === 100 && second >= 64 && second <= 127)
            || (first === 169 && second === 254)
            || (first === 172 && second >= 16 && second <= 31)
            || (first === 192 && (second === 0 || second === 168))
            || (first === 198 && (second === 18 || second === 19 || second === 51))
            || (first === 203 && second === 0 && octets[2] === 113);
    }
    if (family !== 6) return true;
    const normalized = address.toLowerCase().split('%')[0];
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        if (net.isIP(mapped) === 4) return unsafeIpAddress(mapped);
        const words = mapped.split(':');
        if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
            const value = Number.parseInt(words[0] + words[1], 16);
            return unsafeIpAddress([
                (value >>> 24) & 255,
                (value >>> 16) & 255,
                (value >>> 8) & 255,
                value & 255
            ].join('.'));
        }
    }
    const firstWord = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return (firstWord & 0xe000) !== 0x2000
        || normalized.startsWith('2001:db8:')
        || normalized.startsWith('2001:0:')
        || normalized.startsWith('2001:20:')
        || normalized.startsWith('2002:');
}

async function publicHost(hostname, cache) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return false;
    }
    if (net.isIP(host)) return !unsafeIpAddress(host);
    if (!/^[a-z0-9.-]+$/.test(host)) return false;
    if (!cache.has(host)) {
        cache.set(host, dns.lookup(host, { all: true, verbatim: true }).then((addresses) => {
            return addresses.length > 0 && addresses.every((entry) => !unsafeIpAddress(entry.address));
        }).catch(() => false));
    }
    return cache.get(host);
}

function isAllowedTarget(url, allowedHost) {
    try {
        const target = new URL(url);
        const host = allowedHost.toLowerCase().replace(/^\[|\]$/g, '');
        return ['http:', 'https:'].includes(target.protocol)
            && target.hostname.toLowerCase().replace(/^\[|\]$/g, '') === host
            && !target.username
            && !target.password;
    } catch (error) {
        return false;
    }
}

function isAllowedSiteOrigin(url, allowedOrigin) {
    try {
        return new URL(url).origin === allowedOrigin;
    } catch (error) {
        return false;
    }
}

function validateCookies(cookies, allowedHost, allowedOrigin) {
    if (!Array.isArray(cookies)) {
        throw new Error('The authentication cookie file must contain a JSON array.');
    }
    return cookies.map((cookie) => {
        if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
            || (!cookie.name.startsWith('wordpress_logged_in_') && !cookie.name.startsWith('wordpress_sec_'))
            || !isAllowedTarget(cookie.url, allowedHost)
            || !isAllowedSiteOrigin(cookie.url, allowedOrigin)) {
            throw new Error('Authentication cookies must be valid WordPress cookies scoped to the configured site host.');
        }
        return {
            name: cookie.name,
            value: cookie.value,
            url: cookie.url,
            secure: Boolean(cookie.secure),
            httpOnly: Boolean(cookie.httpOnly)
        };
    });
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

const BLOCK = 8;
const FOREGROUND_DISTANCE = 24;
const MATCH_DISTANCE = 48;

// Mean colour of every BLOCK x BLOCK tile; tiles absorb anti-aliasing and one-pixel shifts that make pixel-exact comparison useless for text.
function blockColours(image) {
    const cols = Math.ceil(image.width / BLOCK);
    const rows = Math.ceil(image.height / BLOCK);
    const colours = new Float32Array(cols * rows * 3);
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
            let r = 0;
            let g = 0;
            let b = 0;
            let count = 0;
            const yEnd = Math.min(image.height, (row + 1) * BLOCK);
            const xEnd = Math.min(image.width, (col + 1) * BLOCK);
            for (let y = row * BLOCK; y < yEnd; y += 1) {
                for (let x = col * BLOCK; x < xEnd; x += 1) {
                    const index = (y * image.width + x) * 4;
                    r += image.data[index];
                    g += image.data[index + 1];
                    b += image.data[index + 2];
                    count += 1;
                }
            }
            const offset = (row * cols + col) * 3;
            colours[offset] = r / count;
            colours[offset + 1] = g / count;
            colours[offset + 2] = b / count;
        }
    }
    return { cols, rows, colours };
}

// The commonest tile colour is the page background; everything that differs from it counts as content.
function dominantColour(blocks) {
    const histogram = new Map();
    let best = [255, 255, 255];
    let bestCount = 0;
    for (let index = 0; index < blocks.colours.length; index += 3) {
        const key = (blocks.colours[index] >> 4) * 256 + (blocks.colours[index + 1] >> 4) * 16 + (blocks.colours[index + 2] >> 4);
        const count = (histogram.get(key) || 0) + 1;
        histogram.set(key, count);
        if (count > bestCount) {
            bestCount = count;
            best = [blocks.colours[index], blocks.colours[index + 1], blocks.colours[index + 2]];
        }
    }
    return best;
}

function colourDistance(a, aOffset, b, bOffset) {
    return Math.abs(a[aOffset] - b[bOffset]) + Math.abs(a[aOffset + 1] - b[bOffset + 1]) + Math.abs(a[aOffset + 2] - b[bOffset + 2]);
}

// Share of content tiles (present in the reference or in the render) whose colour matches in both. Empty background scores nothing, so a mostly white page cannot inflate it.
// `zones` also splits the page into a grid and reports the content similarity of each cell, null where a cell holds no content.
function contentSimilarity(reference, rendered, zoneColumns = 4, zoneHeight = 400) {
    if (reference.width !== rendered.width || reference.height !== rendered.height) {
        return { similarity: 0, zones: null };
    }
    const ref = blockColours(reference);
    const ren = blockColours(rendered);
    const background = dominantColour(ref);
    const zoneRows = Math.max(1, Math.ceil(reference.height / zoneHeight));
    const zoneBlockRows = Math.max(1, Math.round(zoneHeight / BLOCK));
    const zoneBlockCols = Math.ceil(ref.cols / zoneColumns);
    const cells = Array.from({ length: zoneRows * zoneColumns }, () => ({ union: 0, matched: 0 }));
    let union = 0;
    let matched = 0;
    for (let row = 0; row < ref.rows; row += 1) {
        for (let col = 0; col < ref.cols; col += 1) {
            const offset = (row * ref.cols + col) * 3;
            const inReference = colourDistance(ref.colours, offset, background, 0) > FOREGROUND_DISTANCE;
            const inRender = colourDistance(ren.colours, offset, background, 0) > FOREGROUND_DISTANCE;
            if (!inReference && !inRender) continue;
            const same = colourDistance(ref.colours, offset, ren.colours, offset) <= MATCH_DISTANCE ? 1 : 0;
            const cell = cells[Math.min(zoneRows - 1, Math.floor(row / zoneBlockRows)) * zoneColumns + Math.min(zoneColumns - 1, Math.floor(col / zoneBlockCols))];
            cell.union += 1;
            cell.matched += same;
            union += 1;
            matched += same;
        }
    }
    const zones = cells.map((cell) => (cell.union ? Math.round((cell.matched / cell.union) * 10000) / 100 : null));
    return { similarity: union ? matched / union : 1, zones: { columns: zoneColumns, rows: zoneRows, height: zoneHeight, cells: zones } };
}

// Weakest populated cell of the grid, used to point at where the page differs most.
function worstZone(zones) {
    if (!zones) return null;
    let worst = null;
    zones.cells.forEach((value, index) => {
        if (value !== null && (worst === null || value < worst.similarity)) {
            worst = { column: index % zones.columns, row: Math.floor(index / zones.columns), similarity: value };
        }
    });
    return worst;
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
    const allowedHost = argument('--allowed-host').toLowerCase().replace(/^\[|\]$/g, '');
    const source = argument('--source');
    const schemaPath = argument('--schema');
    const cookiesPath = argument('--cookies');
    const width = Number(argument('--width'));
    const height = Number(argument('--height'));
    const diffPath = argument('--diff');
    const renderedPath = argument('--rendered');
    if (!url || !allowedHost || !source || !schemaPath || !cookiesPath || !width || !height || width > 10000 || height > 10000 || width * height > 40000000) {
        throw new Error('Missing or invalid --url, --allowed-host, --source, --schema, --cookies, --width or --height.');
    }
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const reference = PNG.sync.read(fs.readFileSync(source));
    const siteOrigin = new URL(url).origin;
    const cookies = validateCookies(JSON.parse(fs.readFileSync(cookiesPath, 'utf8')), allowedHost, siteOrigin);
    if (!isAllowedTarget(url, allowedHost)) {
        throw new Error('Comparison URL must use the configured site host over HTTP(S).');
    }
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: 1,
            serviceWorkers: 'block'
        });
        if (cookies.length) await context.addCookies(cookies);
        const page = await context.newPage();
        const dnsCache = new Map();
        await context.route('**/*', async (route) => {
            const requestUrl = new URL(route.request().url());
            const sameSiteHost = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') === allowedHost.replace(/\.$/, '');
            const sameSiteOrigin = sameSiteHost && requestUrl.origin === siteOrigin;
            if (!['http:', 'https:'].includes(requestUrl.protocol)
                || (sameSiteHost && !sameSiteOrigin)
                || (!sameSiteOrigin && !await publicHost(requestUrl.hostname, dnsCache))) {
                await route.abort('blockedbyclient');
                return;
            }
            await route.continue();
        });
        // 'networkidle' never settles on a live site (background polling), so the wait is bounded to the load event
        // and the canvas itself. The whole run has to finish inside the web request, which nginx cuts at 60 s.
        await page.goto(url, { waitUntil: 'load', timeout: 25000 });
        const visibleCanvases = page.locator('[data-page-generator="canvas"], .page-generator-canvas, .pg-flow-page, .pg-el-flow').locator('visible=true');
        await visibleCanvases.first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
        if (!await visibleCanvases.count()) {
            throw new Error('Generated page canvas was not found; comparison cannot be scoped safely.');
        }
        // A page built from several screenshots is one canvas per screenshot, one under another; they are pinned together as one stack so
        // the screenshot covers all of them (the reference is the screenshots stacked the same way).
        const stacked = await visibleCanvases.count() > 1 && await visibleCanvases.evaluateAll((elements) => elements.every((element) => element.classList.contains('page-generator-canvas')));
        if (stacked) {
            await page.evaluate(() => {
                const list = Array.from(document.querySelectorAll('.page-generator-canvas')).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
                const box = document.createElement('div');
                box.id = 'pg-compare-stack';
                box.style.cssText = 'position:fixed;left:0;top:0;width:100vw;z-index:2147483647;background:#ffffff;';
                list.forEach((element) => {
                    box.appendChild(element);
                    const source = /(?:^|\s)pg-w-(\d+)(?:\s|$)/.exec(element.className);
                    if (element.classList.contains('pg-el-canvas') && source) {
                        element.style.cssText += ';width:' + source[1] + 'px;max-width:none;margin:0;';
                        element.style.setProperty('--pg-zoom', String(window.innerWidth / Number(source[1])));
                    } else {
                        element.style.cssText += ';width:100vw;max-width:none;margin:0;zoom:1;';
                    }
                });
                document.body.appendChild(box);
                document.documentElement.style.overflow = 'hidden';
                const adminBar = document.getElementById('wpadminbar');
                if (adminBar) adminBar.style.display = 'none';
            });
        }
        const canvas = stacked ? page.locator('#pg-compare-stack') : visibleCanvases.first();
        // The theme wraps the canvas in a header, margins and a footer; pin the canvas to the viewport so the screenshot
        // lines up pixel for pixel with the reference instead of comparing the whole themed page.
        if (!stacked) await canvas.evaluate((element) => {
            // An Elementor canvas is a px layout at its source width, zoomed to fit (assets/canvas-scale.js zooms it to its parent, which is
            // not the viewport here): give it the source width and the zoom that makes it exactly as wide as the viewport.
            const source = /(?:^|\s)pg-w-(\d+)(?:\s|$)/.exec(element.className);
            if (element.classList.contains('pg-el-canvas') && source) {
                element.style.cssText += ';position:fixed;left:0;top:0;width:' + source[1] + 'px;max-width:none;margin:0;z-index:2147483647;';
                element.style.setProperty('--pg-zoom', String(window.innerWidth / Number(source[1])));
            } else {
                element.style.cssText += ';position:fixed;left:0;top:0;width:100vw;max-width:none;margin:0;zoom:1;z-index:2147483647;';
            }
            document.documentElement.style.overflow = 'hidden';
            // Where no block covers the canvas it is transparent; keep the admin bar and theme from showing through.
            if (/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(element).backgroundColor)) element.style.backgroundColor = '#ffffff';
            const adminBar = document.getElementById('wpadminbar');
            if (adminBar) adminBar.style.display = 'none';
        });
        await page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
            // The lines that came out wider than their box in the page's font are shrunk to fit (assets/text-fit.js).
            if (window.PageGeneratorFit) window.PageGeneratorFit();
        });
        const canvasRect = await canvas.boundingBox();
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
        const renderedText = await canvas.innerText();
        const domCount = await canvas.locator('section,h1,h2,h3,h4,h5,p,img,button,a,nav,table,form,input,select,textarea,[data-block-id]').count();
        const countNodes = (nodes) => (nodes || []).reduce((count, node) => {
            return count + 1 + countNodes(childNodes(node));
        }, 0);
        const sourceNodeCount = Math.max(1, countNodes(schema.sections));
        const domSimilarity = Math.min(sourceNodeCount, domCount) / Math.max(sourceNodeCount, domCount);
        const content = contentSimilarity(reference, rendered);
        const result = {
            success: true,
            canvasRect,
            contentSimilarity: Math.round(content.similarity * 10000) / 100,
            zones: content.zones,
            worstZone: worstZone(content.zones),
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
        if (result.contentSimilarity < 60) result.differences.push('змістові елементи (фони, рамки, іконки)');
        if (result.textSimilarity < 85) result.differences.push('текстові блоки');
        if (result.domSimilarity < 85) result.differences.push('структура компонентів');
        process.stdout.write(JSON.stringify(result));
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stdout.write(JSON.stringify({ success: false, error: error.message }));
        process.exitCode = 1;
    });
}

module.exports = { unsafeIpAddress, publicHost, isAllowedTarget, isAllowedSiteOrigin, validateCookies, contentSimilarity, worstZone };
