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
