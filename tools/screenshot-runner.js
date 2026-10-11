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
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        const canvas = page.locator('[data-page-generator="canvas"], .page-generator-canvas').first();
        if (!await canvas.count()) {
            throw new Error('Generated page canvas was not found; comparison cannot be scoped safely.');
        }
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
        const renderedText = await canvas.innerText();
        const domCount = await canvas.locator('section,h1,h2,h3,h4,h5,p,img,button,a,nav,table,form,input,select,textarea,[data-block-id]').count();
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

if (require.main === module) {
    main().catch((error) => {
        process.stdout.write(JSON.stringify({ success: false, error: error.message }));
        process.exitCode = 1;
    });
}

module.exports = { unsafeIpAddress, publicHost, isAllowedTarget, isAllowedSiteOrigin, validateCookies };
