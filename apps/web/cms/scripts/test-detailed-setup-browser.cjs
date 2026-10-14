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
    const errors = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', (route) => route.request().url() === 'http://setup-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://setup-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentProfile = { ...cache.users[0], role: 'admin', status: 'active' };
      cache.productById.pr1.name = 'BLING UP';
      const rows = loadProductActivities();
      for (const [id, channel, module, submodule] of [
        ['catalog-bling', 'BLING', 'Financeiro', 'Contas a pagar'],
        ['catalog-bling2', 'BLING', 'Cadastros', 'Produtos'],
        ['catalog-market', 'MERCADO LIVRE', 'Vendas', 'Pedidos'],
        ['catalog-store', 'SHOPIFY', 'Vendas', 'Produtos']
      ]) rows.push({ id, product_id: 'pr1', activity: id, channel, module, submodule, recurrence: 'once', required_setup: [channel] });
      saveProductActivities(rows); cache.productActivities = rows;
      Object.assign(cache.projectById.pj1, { start_date: '2026-10-01', end_date: '2026-12-31', erp_platform: 'BLING', marketplace_channels: ['MERCADO LIVRE'], store_platforms: ['SHOPIFY'], financial_accounts: ['INTER'] });
      init = async () => { await syncProductActivities(); refreshActivityCache(); render(); };
      state.tab = 'projects'; render();
    });
    const choose = async (id, label) => {
      await page.locator(`#${id} .multi-picker-control`).click();
      await page.locator(`#${id} .multi-picker-option`).filter({ hasText: label }).first().click();
      await page.keyboard.press('Escape');
    };
    const openDelivery = async () => {
      await page.evaluate(() => { closeModal(); state.tab = 'projects'; render(); openForm('projects', 'pj1'); });
      await page.locator('[data-form-tab-btn="setup"]').click();
    };
    await openDelivery();
    await choose('delivery-erp-channel-0-modules', 'Financeiro');
    await choose('delivery-erp-channel-0-submodules', 'Contas a pagar');
    await choose('delivery-marketplaces-channel-0-modules', 'Vendas');
    await choose('delivery-marketplaces-channel-0-submodules', 'Pedidos');
    await choose('delivery-stores-channel-0-modules', 'Vendas');
    await choose('delivery-stores-channel-0-submodules', 'Produtos');
    await page.locator('#delivery-financial-configuration [data-setup-channel="INTER"] [data-setup-boleto]').selectOption('no');
    await choose('form-setup_product_types', 'Produto próprio · Nacional');
    await choose('form-setup_product_types', 'Produto de terceiros · Internacional');
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-detailed-delivery-setup.png') });
    await page.locator('#save').click(); await page.waitForFunction(() => !document.getElementById('save'));
    const saved = await page.evaluate(() => cache.projectById.pj1);
    assert.equal(saved.setup_configuration.INTER.emits_boleto, false);
    assert.deepEqual(saved.setup_configuration.BLING.submodules, [{ module: 'Financeiro', name: 'Contas a pagar' }]);
    assert.deepEqual(saved.setup_product_types.sort(), ['own_national', 'third_party_international']);
    await openDelivery();
    assert.equal(await page.locator('#delivery-financial-configuration [data-setup-channel="INTER"] [data-setup-boleto]').inputValue(), 'no');
    assert.equal(await page.evaluate(() => multiPickerValues('delivery-erp-channel-0-modules').includes('Financeiro')), true);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(os.tmpdir(), `cms-detailed-delivery-setup-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => { closeModal(); openMainPmCatalog('activities'); productActivityState.productId = 'pr1'; await openProductActivityDrawer(); });
    await page.locator('#pa-activity').fill('Boleto e financeiro');
    await page.locator('#product-activity-drawer-overlay [data-form-tab-btn="setup"]').click();
    await choose('pa-required-setup', 'INTER');
    await choose('pa-channel-0-modules', 'Financeiro');
    await choose('pa-channel-0-submodules', 'Contas a pagar');
    await page.locator('#pa-configuration [data-setup-channel="INTER"] [data-setup-boleto]').selectOption('no');
    await choose('pa-product-types', 'Produto próprio · Nacional');
    await page.locator('#pa-save').click(); await page.waitForFunction(() => !productActivitySavePending && !document.getElementById('pa-save'));
    assert.equal(await page.evaluate(() => operationalProjectTasks('pj1').some((task) => task.title === 'Boleto e financeiro')), true);
    assert.equal(await page.evaluate(() => loadProductActivities().find((task) => task.activity === 'Boleto e financeiro').required_setup_configuration.INTER.emits_boleto), false);
    await page.evaluate(async () => { const task = loadProjectTasks().find((task) => task.title === 'Boleto e financeiro'); closeModal(); await openDeliveryTaskDrawer('pj1', task.id); });
    await page.locator('#project-task-drawer-overlay [data-form-tab-btn="setup"]').click();
    assert.equal(await page.locator('#project-task-required-setup').getAttribute('data-disabled'), 'true');
    assert.equal(await page.locator('#project-task-configuration [data-setup-boleto]').isDisabled(), true);
    await page.locator('#project-task-save').click(); await page.waitForFunction(() => !document.getElementById('project-task-save'));
    assert.equal(await page.evaluate(() => loadProjectTasks().find((task) => task.title === 'Boleto e financeiro').required_setup_configuration.INTER.emits_boleto), false);
    const ids = await page.evaluate(() => loadProjectTasks().map((task) => task.id));
    await page.evaluate(async () => { await syncProductActivities(); await syncProductActivities(); });
    assert.deepEqual(await page.evaluate(() => loadProjectTasks().map((task) => task.id)), ids);
    await page.evaluate(() => { cache.projectById.pj1.setup_configuration.INTER.emits_boleto = true; });
    assert.equal(await page.evaluate(() => operationalProjectTasks('pj1').some((task) => task.title === 'Boleto e financeiro')), false);
    assert.equal(await page.evaluate(() => loadProjectTasks().some((task) => task.title === 'Boleto e financeiro')), true, 'Hide without deleting');
    await page.evaluate(async () => { closeModal(); openMainPmCatalog('activities'); productActivityState.productId = 'pr1'; await openProductActivityDrawer(); });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#product-activity-drawer-overlay [data-form-tab-btn="setup"]').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#pa-save').isVisible(), true);
      const action = await page.locator('#pa-save').boundingBox();
      const navigation = await page.locator('#mobile-navigation').boundingBox();
      assert.ok(action.y + action.height <= navigation.y + 1, `Save must be above mobile navigation: ${JSON.stringify({ action, navigation })}`);
      await page.screenshot({ path: path.join(os.tmpdir(), `cms-detailed-task-setup-${width}.png`) });
    }
    await page.evaluate(() => closeProductActivityDrawer());
    await page.evaluate(async () => { closeModal(); await openDeliveryTaskDrawer('pj1'); });
    assert.equal(await page.locator('#project-task-drawer-overlay [data-form-tab-btn="setup"]').count(), 1);
    await page.locator('#project-task-title').fill('Tarefa do dia');
    await page.locator('#project-task-drawer-overlay [data-form-tab-btn="setup"]').click();
    await choose('project-task-required-setup', 'INTER');
    await page.locator('#project-task-configuration [data-setup-boleto]').selectOption('yes');
    await page.locator('#project-task-save').click(); await page.waitForFunction(() => !document.getElementById('project-task-save'));
    assert.equal(await page.evaluate(() => loadProjectTasks().find((task) => task.title === 'Tarefa do dia').required_setup_configuration.INTER.emits_boleto), true);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Detailed Setup browser passed: scoped ERP/marketplace/store modules, qualified submodules, per-account boleto, product types, delivery/template/day-to-day save, persistence, conditional visibility without deletion, replay and mobile layouts.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
