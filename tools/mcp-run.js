// Template for the Playwright MCP (browser_run_code_unsafe has no require): `php mcp-make.php <png>` fills in the screenshot path and
// the cookies from dev-cookies.php and writes tools/.mcp-run.js, which is then run with filename=tools/.mcp-run.js.
// Builds a page from the screenshot and returns the plugin's own comparison text.
async (page) => {
    const targets = __TARGETS__;
    const mode = '__MODE__';
    const cookies = __COOKIES__;
    await page.context().addCookies(cookies);
    // The MCP browser keeps its cache between runs: without this an edited editor.js/detectors.js would not be picked up.
    await (await page.context().newCDPSession(page)).send('Network.setCacheDisabled', { cacheDisabled: true });
    const results = [];
    const run = async (target) => {
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
        // Outside Elementor's own editor the page is built as blocks; the stub makes the editor ask for the Elementor tree instead.
        if (mode === 'elementor') await page.evaluate(() => { window.elementor = window.elementor || {}; });
        await page.click('#pg-create-page');
        await page.waitForFunction(() => /Візуальна|не виконано|Не вдалося|помилк/i.test(document.querySelector('#pg-status').textContent), null, { timeout: 400000 }).catch(() => {});
        const text = (await page.textContent('#pg-status')).replace(/\s+/g, ' ');
        const pick = (re) => { const m = text.match(re); return m ? parseFloat(m[1]) : null; };
        return JSON.stringify({ file: target.split('/').pop(), visual: pick(/Візуальна відповідність:\s*([\d.]+)%/), perceptual: pick(/Перцептивна відповідність:\s*([\d.]+)%/), content: pick(/Змістова відповідність:\s*([\d.]+)%/), worstZone: pick(/найгірша зона:[^—]*—\s*([\d.]+)%/), text: pick(/Текстова відповідність:\s*([\d.]+)%/), dom: pick(/DOM-відповідність:\s*([\d.]+)%/), sizes: (text.match(/Reference: (\d+x\d+), rendered: (\d+x\d+)/) || []).slice(1).join(' -> '), tokens: (text.match(/tokens: (\d+ → \d+)/) || [])[1], links: await page.$$eval('#pg-status a', (links) => links.map((link) => link.href)), mode, failed: /Візуальна/.test(text) ? undefined : text.slice(0, 200) });
    };
    // A page that does not come up (the editor sometimes reloads under the headless run) is retried once.
    for (const target of targets) {
        let line;
        for (let attempt = 0; attempt < 2 && !line; attempt += 1) line = await run(target).catch((error) => { if (attempt) return JSON.stringify({ file: target.split('/').pop(), failed: String(error.message).slice(0, 160) }); });
        results.push(line);
    }
    return results.join('\n');
}
