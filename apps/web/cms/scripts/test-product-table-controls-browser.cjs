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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', hasTouch: true });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://product-controls.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://product-controls.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'product-test-admin', role: 'admin', status: 'active' };
      saveProductActivities([
        { id: 'z', product_id: 'pr1', activity: 'Zeta', category: 'Operacao', target_days: 10, sort_order: 0 },
        { id: 'child', product_id: 'pr1', activity: 'Lancamento', category: 'Fiscal', parent_template_id: 'z', sort_order: 1 },
        { id: 'a', product_id: 'pr1', activity: 'Alfa', category: 'Operacao', target_days: 2, sort_order: 2 },
        { id: 'p2', product_id: 'pr2', activity: 'Outro produto', category: 'Exclusiva', sort_order: 0 }
      ]);
      saveProductObjectives([
        { id: 'oz', product_id: 'pr1', name: 'Zeta', completion_criteria: 'Vender', target_days: 10, sort_order: 0 },
        { id: 'oa', product_id: 'pr1', name: 'Alfa', completion_criteria: 'Cadastrar', target_days: 2, sort_order: 1 }
      ]);
      saveProductGoals([
        { id: 'gz', product_id: 'pr1', name: 'Zeta', metric: 'Pedidos', target_value: 10, target_days: 10, sort_order: 0 },
        { id: 'ga', product_id: 'pr1', name: 'Alfa', metric: 'Receita', target_value: 2, target_days: 2, sort_order: 1 }
      ]);
      window.templateSnapshot = JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals()]);
      render(); openProductActivities('pr1');
    });
    const table = () => page.locator('#product-activities-root table');
    const header = label => table().locator('thead th[data-product-column]').filter({ hasText: new RegExp(`^${label}[\u25b2\u25bc]?$`) });
    const rowIds = () => table().locator('tbody tr[data-id]:not([hidden])').evaluateAll(rows => rows.map(row => row.dataset.id));
    const filter = async (label, value) => {
      await header(label).click({ modifiers: ['Control'] });
      await page.locator('#product-filter-dd .dd-item').filter({ hasText: new RegExp(`^${value}$`) }).click();
      await page.locator('#product-filter-dd .dd-apply').click();
    };
    assert.equal(await page.locator('.product-filter-strip').isVisible(), false);
    assert.deepEqual(await rowIds(), ['z', 'child', 'a']);
    await header('Tarefa').click();
    assert.equal(await header('Tarefa').getAttribute('aria-sort'), 'ascending');
    assert.deepEqual(await rowIds(), ['a', 'z', 'child']);
    await header('Tarefa').click();
    assert.deepEqual(await rowIds(), ['z', 'child', 'a']);
    await header('Tarefa').click();
    assert.equal(await header('Tarefa').getAttribute('aria-sort'), 'none');
    assert.equal(await table().locator('tr[data-id="z"]').getAttribute('draggable'), 'true');
    await filter('Categoria', 'Fiscal');
    assert.deepEqual(await rowIds(), ['z', 'child'], 'A matching child must retain its parent context');
    assert.equal(await table().locator('tr[data-id="z"]').getAttribute('draggable'), 'false');
    const selected = await page.evaluate(async () => { await persistProductActivityOrder(); return JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals()]) === templateSnapshot; });
    assert.equal(selected, true, 'Filtering must never persist a reordered catalog');
    await page.locator('.product-filter-strip .registration-filter-badge').click();
    assert.deepEqual(await rowIds(), ['z', 'child', 'a']);
    await header('Prazo sugerido').click();
    assert.deepEqual((await rowIds()).filter(id => id !== 'child'), ['a', 'z'], 'Natural numeric order must put 2 before 10');
    await header('Prazo sugerido').click(); await header('Prazo sugerido').click();
    await filter('Categoria', 'Fiscal');
    await page.locator('[data-product-tab="objectives"]').click();
    assert.deepEqual(await rowIds(), ['oz', 'oa'], 'Task filters must not affect objectives');
    await header('Objetivo').click();
    assert.deepEqual(await rowIds(), ['oa', 'oz']);
    await header('Objetivo').click();
    assert.deepEqual(await rowIds(), ['oz', 'oa']);
    await header('Objetivo').click();
    await filter('Critério de conclusão', 'Cadastrar');
    assert.deepEqual(await rowIds(), ['oa']);
    await page.evaluate(() => renderProductObjectives());
    assert.deepEqual(await rowIds(), ['oa'], 'Direct rerenders after a save must retain controls and filters');
    assert.equal(await table().locator('.secondary-select-all').count(), 1);
    await page.locator('[data-product-tab="goals"]').click();
    await header('Meta').click();
    assert.deepEqual(await rowIds(), ['ga', 'gz']);
    await header('Meta').click(); await header('Meta').click();
    await filter('Indicador', 'Pedidos');
    assert.deepEqual(await rowIds(), ['gz']);
    await filter('Meta', 'Alfa');
    assert.equal(await table().locator('.product-filter-empty').count(), 1);
    await page.locator('.product-filter-strip .filter-clear-all').click();
    assert.deepEqual(await rowIds(), ['gz', 'ga']);
    await header('Meta').focus(); await page.keyboard.press('Enter');
    assert.deepEqual(await rowIds(), ['ga', 'gz']);
    await page.locator('[data-product-tab="activities"]').click();
    assert.deepEqual(await rowIds(), ['z', 'child'], 'Each tab must restore its own filters');
    await page.evaluate(() => { closeModal(); openProductActivities('pr2'); });
    assert.deepEqual(await rowIds(), ['p2'], 'Filters must be isolated per product');
    await page.evaluate(() => { closeModal(); openProductActivities('pr1'); });
    assert.deepEqual(await rowIds(), ['z', 'child']);
    await page.locator('.product-filter-strip .registration-filter-badge').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { mobilePresentation = 'table'; syncMobilePresentation(); });
    await page.locator('[data-product-tab="goals"]').click();
    const mobileHeader = header('Indicador');
    await mobileHeader.scrollIntoViewIfNeeded();
    await mobileHeader.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 180 });
    await page.locator('#product-filter-dd').waitFor();
    await mobileHeader.dispatchEvent('pointerup', { pointerType: 'touch' });
    const panel = await page.locator('#product-filter-dd').boundingBox();
    assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= 390, 'Mobile filter must stay inside the viewport');
    await page.screenshot({ path: path.join(os.tmpdir(), 'product-column-filter-mobile.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#product-filter-dd').count(), 0);
    assert.equal(await page.locator('#product-activities-root').count(), 1, 'Escape must close the filter, not the product');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'product-column-sort-desktop.png') });
    await page.evaluate(() => closeModal());
    for (const section of ['activities', 'objectives', 'goals']) {
      await page.evaluate(section => openMainPmCatalog(section), section);
      const productHeader = page.locator('#main #registrations-root th[data-registration-label="Produto"]');
      await productHeader.click();
      assert.equal(await productHeader.locator('.registration-sort-arrow').count(), 1);
      await productHeader.click({ modifiers: ['Control'] });
      assert.equal(await page.locator('#registration-filter-dd .dd-item').count() > 0, true);
      await page.keyboard.press('Escape');
    }
    assert.equal(await page.evaluate(() => JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals()]) === templateSnapshot), true);
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    console.log('Product tables passed: sorting/reset, numeric order, multi-column filtering, parent context, isolated product/tab state, rerenders, selection, keyboard/mobile long press, main catalog product headers and no data writes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
