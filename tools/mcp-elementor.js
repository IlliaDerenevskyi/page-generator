// Template for the Playwright MCP: the real Elementor path. Opens the page in Elementor's own editor, builds the schema with the plugin's
// button, clears the document, inserts the tree with "Вставити в Elementor", saves with Elementor's saver and compares the saved page
// (`php mcp-make.php <png-or-dir> elementor-editor` fills in __TARGETS__ and __COOKIES__).
async (page) => {
    const targets = __TARGETS__;
    const cookies = __COOKIES__;
    await page.context().addCookies(cookies);
    await (await page.context().newCDPSession(page)).send('Network.setCacheDisabled', { cacheDisabled: true });
    const results = [];
    const run = async (target) => {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.goto('http://localhost/wp-admin/post.php?post=2&action=elementor', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => window.elementor && window.elementor.documents && window.elementor.documents.getCurrent && window.elementor.documents.getCurrent() && window.$e, null, { timeout: 120000 });
        await page.waitForSelector('.page-generator-topbar-button', { timeout: 60000 });
        await page.click('.page-generator-topbar-button');
        await page.click('[data-view="screenshots"]').catch(() => {});
        await page.waitForSelector('#pg-images', { state: 'attached', timeout: 30000 });
        await page.setInputFiles('#pg-images', target);
        await page.waitForSelector('#pg-build-screenshot:not([disabled])', { timeout: 120000 });
        await page.click('#pg-build-screenshot');
        await page.waitForFunction(() => jQuery('#pg-output-actions').is(':visible') || /помилк|Не вдалося/i.test(document.querySelector('#pg-status').textContent), null, { timeout: 300000 });
        // Empty the document, insert the plugin's tree, save as Elementor itself would.
        await page.evaluate(async () => {
            const root = elementor.documents.getCurrent().container;
            if (root.children.length) await $e.run('document/elements/delete', { containers: root.children.slice() });
        });
        await page.click('#pg-insert-elementor');
        await page.waitForFunction(() => /вставлено|Не вдалося|не знайдено/i.test(document.querySelector('#pg-status').textContent), null, { timeout: 120000 });
        const inserted = await page.evaluate(() => ({ text: document.querySelector('#pg-status').textContent, children: elementor.documents.getCurrent().container.children.length }));
        if (!inserted.children) return JSON.stringify({ file: target.split('/').pop(), failed: 'insert: ' + inserted.text });
        await page.evaluate(async () => { await $e.run('document/save/publish'); });
        await page.waitForTimeout(3000);
        const result = await page.evaluate(async () => {
            const schema = jQuery('#page-generator-modal').data('schema');
            const section = schema.sections[0];
            const form = {
                action: 'page_generator_compare_page', nonce: PageGeneratorConfig.nonce, postId: PageGeneratorConfig.currentPostId || elementor.config.document.id,
                url: elementor.config.document.urls.permalink, sourceUrl: section.source.url, sourceAttachmentId: section.source.attachmentId || 0,
                schema: JSON.stringify(schema), width: section.settings.sourceWidth, height: section.settings.sourceHeight
            };
            const response = await jQuery.post(PageGeneratorConfig.ajaxUrl, form);
            return response;
        });
        if (!result.success) return JSON.stringify({ file: target.split('/').pop(), failed: String(result.data).slice(0, 200) });
        const d = result.data;
        return JSON.stringify({ file: target.split('/').pop(), visual: +d.visualSimilarity.toFixed(2), perceptual: +Number(d.perceptualSimilarity).toFixed(2), content: +Number(d.contentSimilarity).toFixed(2), worstZone: d.worstZone ? Math.round(d.worstZone.similarity) : null, text: +d.textSimilarity.toFixed(2), dom: +d.domSimilarity.toFixed(2), sizes: d.referenceSize + ' -> ' + d.renderedSize, links: [d.renderedUrl, d.diffUrl], mode: 'elementor-editor' });
    };
    for (const target of targets) {
        let line;
        for (let attempt = 0; attempt < 2 && !line; attempt += 1) line = await run(target).catch((error) => { if (attempt) return JSON.stringify({ file: target.split('/').pop(), failed: String(error.message).slice(0, 160) }); });
        results.push(line);
    }
    return results.join('\n');
}
