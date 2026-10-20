// Template for the Playwright MCP (browser_run_code_unsafe has no require): `php mcp-make.php <png>` fills in the screenshot path and
// the cookies from dev-cookies.php and writes tools/.mcp-schema.js, which is then run with filename=tools/.mcp-run.js.
// Builds a page from the screenshot and returns the plugin's own comparison text.
async (page) => {
    const target = __TARGETS__[0];
    const cookies = __COOKIES__;
    await page.context().addCookies(cookies);
    await (await page.context().newCDPSession(page)).send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://localhost/wp-admin/post.php?post=2&action=edit', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('.page-generator-topbar-button', { timeout: 180000 });
    await page.click('.page-generator-topbar-button');
    await page.click('[data-view="screenshots"]').catch(() => {});
    await page.waitForSelector('#pg-images', { state: 'attached', timeout: 30000 });
    await page.setInputFiles('#pg-images', target);
    await page.waitForSelector('#pg-build-screenshot:not([disabled])', { timeout: 120000 });
    await page.click('#pg-build-screenshot');
    await page.waitForFunction(() => jQuery('#pg-output-actions').is(':visible') || /помилк|Не вдалося/i.test(document.querySelector('#pg-status').textContent), null, { timeout: 300000 });
    return await page.evaluate(() => JSON.stringify(window.__dropped || []));
}
