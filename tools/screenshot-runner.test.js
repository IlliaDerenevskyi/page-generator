const test = require('node:test');
const assert = require('node:assert/strict');
const { unsafeIpAddress, publicHost, isAllowedTarget, isAllowedSiteOrigin, validateCookies } = require('./screenshot-runner');

test('blocks reserved and private IPv4 ranges', () => {
    [
        '0.1.2.3',
        '10.0.0.1',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.1.1',
        '172.16.0.1',
        '192.168.1.1',
        '192.0.2.10',
        '198.51.100.5',
        '203.0.113.4',
        '224.0.0.1'
    ].forEach((address) => assert.equal(unsafeIpAddress(address), true, address));
    assert.equal(unsafeIpAddress('8.8.8.8'), false);
});

test('authentication cookies are accepted only when scoped to the configured WordPress host', () => {
    const cookies = [{
        name: 'wordpress_logged_in_hash',
        value: 'secret',
        url: 'https://example.com/',
        secure: true,
        httpOnly: true
    }];
    assert.deepEqual(validateCookies(cookies, 'example.com', 'https://example.com'), cookies);
    assert.throws(() => validateCookies([{
        ...cookies[0],
        url: 'https://attacker.example/'
    }], 'example.com', 'https://example.com'), /configured site host/);
    assert.throws(() => validateCookies([{
        ...cookies[0],
        url: 'https://example.com:8443/'
    }], 'example.com', 'https://example.com'), /configured site host/);
    assert.throws(() => validateCookies([{
        ...cookies[0],
        name: 'session'
    }], 'example.com', 'https://example.com'), /WordPress cookies/);
});

test('same-site requests must keep the configured scheme and port', () => {
    assert.equal(isAllowedSiteOrigin('https://example.com/path', 'https://example.com'), true);
    assert.equal(isAllowedSiteOrigin('http://example.com/path', 'https://example.com'), false);
    assert.equal(isAllowedSiteOrigin('https://example.com:8443/path', 'https://example.com'), false);
});

test('blocks private IPv6 and IPv4-mapped private addresses', () => {
    [
        '::',
        '::1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        'fc00::1',
        'fe80::1',
        '2001:db8::1',
        '2002::1'
    ].forEach((address) => assert.equal(unsafeIpAddress(address), true, address));
    assert.equal(unsafeIpAddress('2606:4700:4700::1111'), false);
});

test('rejects local hostnames and private literal hosts without DNS lookups', async () => {
    const cache = new Map();
    assert.equal(await publicHost('localhost', cache), false);
    assert.equal(await publicHost('service.internal', cache), false);
    assert.equal(await publicHost('127.0.0.1', cache), false);
    assert.equal(await publicHost('[::1]', cache), false);
});

test('comparison target must be HTTP(S) on the configured host without credentials', () => {
    assert.equal(isAllowedTarget('https://example.com/page?preview=1', 'example.com'), true);
    assert.equal(isAllowedTarget('http://example.com/page', 'example.com'), true);
    assert.equal(isAllowedTarget('https://example.com.evil.test/page', 'example.com'), false);
    assert.equal(isAllowedTarget('https://other.example/page', 'example.com'), false);
    assert.equal(isAllowedTarget('file:///etc/passwd', 'example.com'), false);
    assert.equal(isAllowedTarget('https://user:pass@example.com/page', 'example.com'), false);
});

const { PNG } = require('pngjs');
const { contentSimilarity, worstZone } = require('./screenshot-runner');

function solid(width, height, colour, rects = []) {
    const image = new PNG({ width, height });
    const paint = (x0, y0, x1, y1, [r, g, b]) => {
        for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
                const index = (y * width + x) * 4;
                image.data[index] = r;
                image.data[index + 1] = g;
                image.data[index + 2] = b;
                image.data[index + 3] = 255;
            }
        }
    };
    paint(0, 0, width, height, colour);
    rects.forEach((rect) => paint(...rect));
    return image;
}

test('contentSimilarity ignores empty background, so a white page cannot score high by being white', () => {
    const blue = [20, 90, 220];
    const reference = solid(400, 800, [255, 255, 255], [[40, 40, 360, 120, blue]]);
    const blank = solid(400, 800, [255, 255, 255]);
    assert.equal(contentSimilarity(reference, reference).similarity, 1);
    assert.equal(contentSimilarity(reference, blank).similarity, 0);
    assert.equal(contentSimilarity(blank, blank).similarity, 1);
});

test('contentSimilarity reports the weakest zone of the page', () => {
    const blue = [20, 90, 220];
    const reference = solid(400, 800, [255, 255, 255], [[0, 40, 400, 120, blue], [0, 440, 400, 520, blue]]);
    const rendered = solid(400, 800, [255, 255, 255], [[0, 40, 400, 120, blue]]);
    const { zones } = contentSimilarity(reference, rendered);
    const worst = worstZone(zones);
    assert.equal(worst.row, 1);
    assert.equal(worst.similarity, 0);
    assert.equal(zones.cells[0], 100);
});
