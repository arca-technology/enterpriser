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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://variations.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://variations.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'variations-admin', role: 'admin', status: 'active' };
      saveProductActivities([{ id: 'legacy', product_id: 'pr1', activity: 'Tarefa simples existente', recurrence: 'once', required_setup: [] }]);
      saveProductObjectives([]); saveProductGoals([]);
      cache.projects = [
        { id: 'bling-delivery', product_id: 'pr1', name: 'Bling', start_date: '2026-10-01', end_date: '2026-10-31', erp_platform: 'BLING' },
        { id: 'olist-delivery', product_id: 'pr1', name: 'Olist', start_date: '2026-10-01', end_date: '2026-10-31', erp_platform: 'OLIST' }
      ];
      cache.projectById = Object.fromEntries(cache.projects.map(row => [row.id, row]));
      saveProjectTasks([]);
      window.legacySnapshot = JSON.stringify(loadProductActivities()[0]);
      render(); openMainPmCatalog('activities');
    });
    await page.locator('#registration-add').click();
    assert.equal(await page.locator('.task-variation-toggle input').count(), 5);
    await page.locator('#pa-category').fill('ERP');
    await page.locator('#pa-module').fill('Financeiro');
    await page.locator('#pa-submodule').fill('Contas a pagar');
    await page.locator('#pa-type').fill('Importacao');
    await page.locator('#pa-vary-channel').check();
    await page.locator('#pa-variants-channel .multi-picker-control').click();
    await page.locator('#pa-variants-channel .multi-picker-option[data-value="BLING"]').click();
    await page.locator('#pa-variants-channel .multi-picker-option[data-value="OLIST"]').click();
    await page.locator('#pa-category').click();
    assert.equal(await page.locator('#pa-use-structure').isChecked(), true);
    assert.equal(await page.locator('#pa-variation-preview .task-variation-preview-list>div').count(), 2);
    assert.ok((await page.locator('#pa-variation-preview').innerText()).includes('ERP | OLIST | Financeiro | Contas a pagar | Importacao'));
    await page.evaluate(() => {
      const option = document.querySelector('#pa-required-setup [data-value="BLING"]');
      option.classList.add('active');
    });
    await page.screenshot({ path: path.join(os.tmpdir(), 'task-variations-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#pa-vary-channel').scrollIntoViewIfNeeded();
    const toggle = await page.locator('.task-variation-field[data-variation-field="channel"] .task-field-heading').boundingBox();
    assert.ok(toggle && toggle.x >= 0 && toggle.x + toggle.width <= 390);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'task-variations-mobile.png') });
    await page.locator('#pa-save').click();
    await page.waitForFunction(() => !document.getElementById('pa-save'));
    await page.waitForFunction(() => loadProjectTasks().filter(task => task.source_template_id !== 'legacy').length === 2);
    const created = await page.evaluate(() => {
      const rows = loadProductActivities();
      const parent = rows.find(row => Object.keys(row.variation_axes || {}).length);
      const children = rows.filter(row => row.variation_parent_id === parent.id);
      window.familyId = parent.id; window.childIds = children.map(row => row.id).sort();
      return { axes: parent.variation_axes, parentChannel: parent.channel, channels: children.map(row => row.channel).sort(),
        names: children.map(activityDisplayName).sort(), tasks: loadProjectTasks().filter(task => task.source_template_id !== 'legacy').map(task => ({ source: task.source_template_id, project: task.project_id })),
        parentExecuted: loadProjectTasks().some(task => task.source_template_id === parent.id),
        legacyUnchanged: JSON.stringify(rows.find(row => row.id === 'legacy')) === legacySnapshot };
    });
    assert.deepEqual(created.axes, { channel: ['BLING', 'OLIST'] });
    assert.deepEqual(created.channels, ['BLING', 'OLIST']);
    assert.equal(created.parentChannel, ''); assert.equal(created.parentExecuted, false); assert.equal(created.legacyUnchanged, true);
    assert.equal(created.tasks.length, 2);
    await page.evaluate(() => {
      const tasks = loadProjectTasks();
      const historical = tasks.find(task => task.source_template_id !== 'legacy');
      Object.assign(historical, { status: 'done', notes: 'Historico preservado', actual_start_date: '2026-10-01', actual_end_date: '2026-10-02' });
      saveProjectTasks(tasks); window.executionSnapshot = JSON.stringify(loadProjectTasks());
      openRegistrationTemplateEditor('activities', 'pr1', familyId);
    });
    await page.locator('#pa-type').fill('Conciliacao');
    assert.equal(await page.locator('#pa-vary-channel').isDisabled(), true);
    await page.locator('#pa-save').click();
    await page.waitForFunction(() => !document.getElementById('pa-save'));
    await page.waitForFunction(() => !productActivitySavePending);
    assert.deepEqual(await page.evaluate(() => loadProductActivities().filter(row => row.variation_parent_id === familyId).map(row => row.id).sort()), await page.evaluate(() => childIds));
    assert.equal(await page.evaluate(() => loadProductActivities().filter(row => row.variation_parent_id === familyId).every(row => row.type === 'Conciliacao')), true);
    assert.equal(await page.evaluate(() => JSON.stringify(loadProjectTasks()) === executionSnapshot), true, 'Parent edits must not rewrite execution history or dates');
    assert.equal(await page.evaluate(() => loadProjectTasks().filter(row => row.source_template_id !== 'legacy').every(row => activityDisplayName(row).endsWith('Conciliacao'))), true);
    await page.evaluate(() => openProductActivityDrawer(childIds[0]));
    await page.waitForSelector('#pa-type');
    assert.equal(await page.evaluate(() => productActivityState.editId === familyId), true, 'Child opens its authoritative parent');
    await page.locator('#pa-cancel').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const familyRow = page.locator('#registrations-root tr[data-task-group]').filter({ hasText: 'Pai de variacoes' });
    await page.evaluate(() => {
      const parent = loadProductActivities().find(row => row.id === familyId);
      document.querySelector(`.registration-task-toggle[data-group="${parent.template_group_id}"]`).click();
    });
    assert.equal(await page.locator('.registration-subtask-row:not([hidden])').count(), 2);
    const checks = await page.evaluate(() => {
      const parent = loadProductActivities().find(row => row.id === familyId);
      const combinations = taskVariationCombinations({ category: ['ERP', 'Banco'], channel: ['BLING', 'OLIST'], type: ['Importar', 'Exportar'] });
      const rows = expandTaskVariations([{ ...parent, id: 'matrix', variation_axes: { category: ['ERP', 'Banco'], channel: ['BLING', 'OLIST'], type: ['Importar', 'Exportar'] } }]);
      let duplicate = false, limit = false, empty = false, removing = false;
      try { taskVariationCombinations({ channel: ['BLING', 'bling'] }); } catch { duplicate = true; }
      try { taskVariationCombinations({ channel: Array.from({ length: 20 }, (_, i) => `C${i}`), type: Array.from({ length: 20 }, (_, i) => `T${i}`) }); } catch { limit = true; }
      try { taskVariationCombinations({ channel: [] }); } catch { empty = true; }
      try { expandTaskVariations(loadProductActivities().map(row => row.id === familyId ? { ...row, variation_axes: { channel: ['BLING'] } } : row)); } catch { removing = true; }
      return { count: combinations.length, children: rows.filter(row => row.variation_parent_id).length, duplicate, limit, empty, removing };
    });
    assert.deepEqual(checks, { count: 8, children: 8, duplicate: true, limit: true, empty: true, removing: true });
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Task variations passed: 5 toggles, selectable/custom values, preview, structural names, Cartesian combinations, stable child IDs, inherited edits, product/Setup scope, no parent executions, history and legacy preservation, catalog grouping, mobile and safety limits.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
