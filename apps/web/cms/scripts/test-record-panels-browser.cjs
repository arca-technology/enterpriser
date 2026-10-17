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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://panels-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://panels-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin(); setTheme(true);
      saveConversations([{ id: 'panel-conversation', contact_name: 'Conversa de teste', contact_id: cache.contacts[0].id, source: 'WhatsApp', messages: [], status: 'new' }]);
      cache.conversations = loadConversations();
      const project = cache.projects[0];
      saveDeliveryGoals([{ id: 'panel-goal', project_id: project.id, name: 'Meta clicavel', target_value: 10, status: 'todo' }]);
      saveDeliveryObjectives([{ id: 'panel-objective', project_id: project.id, name: 'Objetivo clicavel', status: 'todo' }]);
      saveProjectTasks([{ id: 'panel-task', project_id: project.id, title: 'Tarefa clicavel', status: 'todo', required_setup: [] }]);
      saveNavigationPreference({ mode: 'top' });
    });
    for (const [tab, key] of [['contacts', 'name'], ['companies', 'legal_name'], ['conversations', 'contact_name'], ['deals', 'title'], ['projects', 'name'], ['activities', 'title'], ['goals', 'name'], ['objectives', 'name']]) {
      await page.evaluate((tab) => { state.tab = tab; state.view = 'table'; state.sortK = null; state.q = ''; render(); }, tab);
      const name = page.locator(`#main td[data-k="${key}"].record-primary-cell`).first();
      assert.equal(await name.count(), 1, tab);
      assert.equal(await name.evaluate((el) => getComputedStyle(el).fontWeight), '700', tab);
      await page.evaluate(() => setTheme(false));
      assert.equal(await name.evaluate((el) => getComputedStyle(el).fontWeight), '700', `${tab}: dark theme`);
      await page.evaluate(() => setTheme(true));
      await page.evaluate((key) => { state.sortK = key; render(); }, key);
      assert.equal(await name.count(), 1, `${tab}: sorted header`);
    }
    await page.evaluate(() => { state.tab = 'deals'; state.sortK = 'title'; render(); });
    await page.locator('#main td[data-k="title"].record-primary-cell').first().click();
    assert.equal(await page.locator('.modal.side-panel').count(), 1);
    assert.equal(await page.locator('#save').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.panelOriginalCan = currentUserCan;
      currentUserCan = (tab, action) => tab === 'deals' && action === 'edit' ? false : panelOriginalCan(tab, action);
      render();
    });
    await page.locator('#main td[data-k="title"].record-primary-cell').first().press('Enter');
    assert.equal(await page.locator('#deal-view-close').count(), 1);
    assert.equal(await page.locator('#save').count(), 0);
    await page.locator('#deal-view-close').click();
    await page.evaluate(() => { currentUserCan = panelOriginalCan; state.tab = 'conversations'; state.sortK = null; render(); });
    for (const mode of ['top', 'sidebar']) {
      await page.evaluate((mode) => saveNavigationPreference({ mode }), mode);
      await page.locator('#main .record-actions-toggle').first().click();
      await page.locator('#record-actions-menu').getByRole('menuitem', { name: 'Editar', exact: true }).click();
      assert.equal(await page.locator('.modal.side-panel').count(), 1);
      assert.equal(await page.locator('.conv-deal-field').first().isVisible(), false);
      await page.waitForTimeout(250);
      const panel = await page.locator('.modal.side-panel').boundingBox();
      assert.ok(mode === 'top' ? Math.abs(panel.x + panel.width - 1440) < 1 : Math.abs(panel.x - 64) < 1, `${mode}: ${JSON.stringify(panel)}`);
      const desktopSave = await page.locator('#save').boundingBox();
      assert.ok(desktopSave && desktopSave.y >= 820 && desktopSave.y + desktopSave.height <= 900);
      await page.locator('#conv-edit-deal').check();
      assert.equal(await page.locator('#conv-edit-product').isVisible(), true);
      await page.screenshot({ path: path.join(os.tmpdir(), `interaction-edit-${mode}.png`) });
      await page.mouse.click(900, 850);
      assert.equal(await page.locator('.modal.side-panel').count(), 1);
      await page.keyboard.press('Escape');
      await page.locator('#ui-confirm-accept').click();
      assert.equal(await page.locator('.modal.side-panel').count(), 0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => openConversationEditModal(['panel-conversation']));
    const save = await page.locator('#save').boundingBox();
    const nav = await page.locator('#mobile-navigation').boundingBox();
    assert.ok(save && nav && save.y + save.height <= nav.y);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'interaction-edit-mobile.png') });
    const dealsBefore = await page.evaluate(() => cache.deals.length);
    const nextPerson = await page.evaluate(() => cache.contacts[1].id);
    await page.locator('#conv-edit-person').selectOption(nextPerson);
    await page.locator('#save').click();
    assert.equal(await page.locator('.modal.side-panel').count(), 0);
    assert.equal(await page.evaluate(() => findConversation('panel-conversation').contact_id), nextPerson);
    assert.equal(await page.evaluate(() => cache.deals.length), dealsBefore);
    assert.deepEqual(errors, []);
    console.log('Record panels passed: bold primary names, sorting, deal click/keyboard/read-only access, interactions drawer and mobile actions.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
