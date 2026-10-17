const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/^startApp\(\);/m, '');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://ui-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://ui-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => { await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin(); saveNavigationPreference({ mode: 'sidebar' }); state.tab = 'contacts'; render(); });
    for (const width of [760, 761, 763, 767, 768]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('#mobile-navigation').isVisible(), width < 768);
      assert.equal(await page.locator('#app-sidebar').isVisible(), width >= 768);
      assert.equal(await page.locator('#new').isVisible(), true, `New action at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#new').click();
    assert.equal(await page.locator('#modal-root .modal').getAttribute('role'), 'dialog');
    assert.equal(await page.locator('#main').evaluate((el) => !!el.closest('[inert]')), true);
    assert.equal(await page.locator('input[data-k="name"]').evaluate((el) => !!el.labels.length), true);
    await page.locator('#save').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#side-close').evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#save').evaluate((el) => el === document.activeElement), true);
    await page.locator('#save').click();
    assert.equal(await page.locator('.ui-error-banner').isVisible(), true);
    assert.equal(await page.locator('input[data-k="name"]').getAttribute('aria-invalid'), 'true');
    await page.waitForTimeout(3400);
    assert.equal(await page.locator('.ui-error-banner').isVisible(), true);
    await page.locator('input[data-k="name"]').fill('Unsaved person');
    assert.equal(await page.locator('input[data-k="name"]').getAttribute('aria-invalid'), null);
    await page.keyboard.press('Escape');
    await page.locator('#ui-confirm-cancel').click();
    assert.equal(await page.locator('input[data-k="name"]').inputValue(), 'Unsaved person');
    await page.locator('#cancel').click();
    await page.locator('#ui-confirm-accept').click();
    assert.equal(await page.locator('#modal-root .modal').count(), 0);
    assert.equal(await page.locator('#main').evaluate((el) => !!el.closest('[inert]')), false);
    assert.equal(await page.locator('#new').evaluate((el) => el === document.activeElement), true);

    await page.evaluate(() => {
      openToolCustomTableEditor();
      const panel = document.createElement('div');
      panel.id = 'custom-table-filter-dd';
      panel.className = 'filter-dd';
      document.body.append(panel);
      mountColumnFilterPanel(panel, { title: 'Test filter', values: ['One', 'Two'], onApply: (value) => { window.appliedUiFilter = value ? [...value] : []; panel.remove(); } });
    });
    await page.locator('.dd-item').first().focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.dd-item').first().getAttribute('aria-pressed'), 'true');
    await page.locator('.dd-apply').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => appliedUiFilter), ['One']);
    await page.evaluate(() => {
      const panel = document.createElement('div'); panel.className = 'filter-dd'; panel.id = 'custom-table-filter-dd';
      document.body.append(panel); mountColumnFilterPanel(panel, { title: 'Dates', key: 'due_date', values: ['2026-01-01'], onApply: () => panel.remove() });
    });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#custom-table-filter-dd').count(), 0, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(UI_FLOATERS)].map(el => ({id:el.id, visible:!!el.getClientRects().length, inert:!!el.closest('[inert]')})))));
    assert.equal(await page.locator('.custom-table-editor-modal').count(), 1);
    await page.locator('#custom-table-name').fill('Keep this draft');
    await page.keyboard.press('Escape');
    await page.locator('#ui-confirm-cancel').click();
    assert.equal(await page.locator('#custom-table-name').inputValue(), 'Keep this draft');
    await page.evaluate(() => closeModal());

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => openToolDocumentForm());
    assert.equal(await page.locator('#document-page-select').isVisible(), true);
    assert.equal(await page.locator('#document-add-page').isVisible(), true);
    assert.equal(await page.locator('#document-add-group').isVisible(), true);
    await page.locator('#document-page-subject').fill('First draft page');
    await page.locator('#document-add-page').click();
    assert.equal(await page.locator('#document-page-select option').count(), 2);
    page.once('dialog', (dialog) => dialog.accept('New group'));
    await page.locator('#document-add-group').click();
    assert.equal(await page.locator('#document-page-select optgroup').count(), 2);
    await page.locator('#document-page-select').selectOption('0');
    assert.equal(await page.locator('#document-page-subject').inputValue(), 'First draft page');
    await page.evaluate(() => { window.formatCommands = []; document.execCommand = (command) => { formatCommands.push(command); return true; }; });
    await page.locator('.documentation-editor [data-command="bold"]').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => formatCommands), ['bold']);
    for (const height of [844, 520]) {
      await page.setViewportSize({ width: 390, height });
      const nav = await page.locator('#mobile-navigation').boundingBox();
      for (const selector of ['#tool-document-cancel', '#tool-document-save']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= nav.y, `${selector} visible at ${height}px`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'shared-ui-document-mobile.png') });
    await page.locator('#tool-document-cancel').click();
    await page.locator('#ui-confirm-cancel').click();
    assert.equal(await page.locator('.document-editor-modal').count(), 1);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => toast('A persistent global error', true));
    const notification = await page.locator('#toast').boundingBox();
    const navigation = await page.locator('#mobile-navigation').boundingBox();
    assert.ok(notification.y + notification.height <= navigation.y);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const can = currentUserCan;
      currentUserCan = (module, action) => module === 'emails' && action === 'create' ? false : can(module, action);
      openToolsModal('emails');
    });
    assert.equal(await page.locator('#tool-email-add').count(), 0);
    assert.equal(await page.locator('#tools-root table').count(), 1);
    assert.equal(await page.locator('#modal-root .modal').getAttribute('role'), 'region');
    assert.equal(await page.locator('#app-sidebar').evaluate((el) => !!el.closest('[inert]')), false);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => {
      cache.projects[0].start_date = '2026-01-01'; cache.projects[0].end_date = '2026-03-31';
      openProjectBoard(cache.projects[0].id); document.querySelector('[data-project-section="data"]').click();
    });
    await page.locator('.business-channel-revenue').first().fill('1500');
    await page.locator('[data-project-section="activities"]').evaluate((button) => button.click());
    await page.locator('#ui-confirm-cancel').click();
    assert.equal(await page.locator('.business-channel-revenue').first().inputValue(), '1500');
    await page.locator('#project-data-save').click();
    assert.equal(await page.locator('.project-data-module').getAttribute('data-ui-dirty'), null);
    await page.locator('[data-project-section="activities"]').evaluate((button) => button.click());
    assert.equal(await page.locator('.project-data-module').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Shared UI checks passed: focus, labels, layered Escape, persistent errors, drafts, keyboard filters, restricted emails and mobile documentation/breakpoints.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
