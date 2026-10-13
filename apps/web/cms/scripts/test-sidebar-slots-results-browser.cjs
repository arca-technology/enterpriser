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
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', (route) => route.request().url() === 'http://slots-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://slots-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      loadNavigationPreference(); saveNavigationPreference({ mode: 'sidebar' });
      state.tab = 'contacts'; state.view = 'table'; render();
    });
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const assertSlots = async (hostSelector = 'body') => {
      await settle();
      const geometry = await page.evaluate((selector) => {
        const host = document.querySelector(selector);
        const visible = (selector) => [...host.querySelectorAll(selector)].find((el) => el.getClientRects().length);
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        return {
          brand: box(document.querySelector('.sidebar-brand-slot')),
          cms: box(document.querySelector('.sidebar-system')),
          company: box(document.querySelector('.sidebar-company-slot')),
          toolbar: box(visible('.subbar,.registration-toolbar,.tools-toolbar,.project-data-toolbar')),
          header: box(visible('thead th')), width: document.getElementById('app-sidebar').getBoundingClientRect().width
        };
      }, hostSelector);
      const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1.1, JSON.stringify(geometry));
      close(geometry.brand.top, geometry.toolbar.top);
      close(geometry.brand.bottom, geometry.toolbar.bottom);
      close(geometry.cms.top, geometry.toolbar.bottom);
      close(geometry.cms.bottom, geometry.header.top);
      close(geometry.company.top, geometry.header.top);
      close(geometry.company.bottom, geometry.header.bottom);
      assert.equal(geometry.width, 64);
    };
    for (const tab of ['contacts', 'companies', 'conversations', 'deals', 'projects', 'activities', 'goals', 'objectives']) {
      await page.evaluate((tab) => { state.tab = tab; state.view = 'table'; render(); }, tab);
      await assertSlots();
    }
    for (const section of ['products', 'pipelines', 'users', 'emails']) {
      await page.evaluate((section) => openRegistrationsModal(section), section);
      await assertSlots('#modal-root > .sidebar-module-overlay');
      await page.evaluate(() => closeModal());
    }
    await page.evaluate(() => {
      workspaceIdentityReady = true;
      workspaceIdentity = { company_name: 'Empresa de teste', logo_path: 'workspace/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp' };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d'); context.fillStyle = '#21b7c8'; context.fillRect(0, 0, 32, 32);
      identityDemoFiles.set(workspaceIdentity.logo_path, canvas.toDataURL('image/png'));
      queueIdentityAvatars();
    });
    await page.waitForFunction(() => document.querySelector('.sidebar-company-logo img')?.naturalWidth === 32);
    assert.equal(await page.locator('.sidebar-company-slot').getAttribute('aria-label'), 'Logo de Empresa de teste');
    assert.equal(await page.locator('.sidebar-company-logo').getAttribute('data-identity-user'), '');
    await page.evaluate(() => { state.tab = 'contacts'; render(); });
    await assertSlots();
    await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-slots-desktop.png') });
    for (const width of [1024, 768]) {
      await page.setViewportSize({ width, height: 640 });
      await assertSlots();
      await page.evaluate(() => openRegistrationsModal('products'));
      await assertSlots('#modal-root > .sidebar-module-overlay');
      await page.evaluate(() => closeModal());
    }
    await page.setViewportSize({ width: 390, height: 740 }); await settle();
    assert.equal(await page.locator('#app-sidebar').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1440, height: 1000 });

    assert.deepEqual(await page.evaluate(() => {
      const key = productResultIdentity;
      return [key({ name: ' Primeira venda ', category: 'Vendas', channel: ' Amazon ' }) === key({ name: 'PRIMEIRA VENDA', category: 'vendas', channel: 'amazon' }),
        key({ name: 'Venda' }) === key({ name: 'Venda', category: null, channel: '' }),
        key({ name: 'Venda', category: 'a|b', channel: 'c' }) !== key({ name: 'Venda', category: 'a', channel: 'b|c' })];
    }), [true, true, true]);
    for (const [section, prefix] of [['goals', 'pg'], ['objectives', 'po']]) {
      const save = async (channel, category = 'Vendas', productId = 'pr1', editId = null) => {
        await page.evaluate(({ section, editId, productId }) => {
          openMainPmCatalog(section); productActivityState.productId = productId;
          if (section === 'goals') openProductGoalDrawer(editId); else openProductObjectiveDrawer(editId);
        }, { section, editId, productId });
        await page.locator(`#${prefix}-name`).fill('Primeira venda');
        await page.locator(`#${prefix}-category`).fill(category);
        await page.locator(`#${prefix}-channel`).fill(channel);
        if (section === 'goals') { await page.locator('#pg-metric').fill('Pedidos'); await page.locator('#pg-target').fill('1'); }
        await page.evaluate(async (section) => { if (section === 'goals') await saveProductGoal(); else await saveProductObjective(); }, section);
      };
      await save('Amazon');
      assert.equal(await page.locator(`#${prefix}-save`).count(), 0);
      await save('Mercado Livre');
      assert.equal(await page.locator(`#${prefix}-save`).count(), 0);
      await save(' amazon ', ' vendas ');
      assert.equal(await page.locator(`#${prefix}-save`).count(), 1);
      assert.ok(await page.locator('[role="alert"]').allTextContents().then((text) => text.some((s) => s.includes('mesma categoria, canal e nome'))));
      await page.evaluate(() => closeProductActivityDrawer());
      await save('Amazon', 'Outros');
      await save('Amazon', 'Vendas', 'pr2');
      const rows = await page.evaluate((section) => (section === 'goals' ? loadProductGoals() : loadProductObjectives()).filter((item) => item.name === 'Primeira venda'), section);
      assert.equal(rows.length, 4);
      const item = rows.find((item) => item.product_id === 'pr1' && item.channel === 'Amazon' && item.category === 'Vendas');
      await save('Amazon', 'Vendas', 'pr1', item.id);
      assert.equal(await page.locator(`#${prefix}-save`).count(), 0);
      const delivered = await page.evaluate((section) => (section === 'goals' ? loadDeliveryGoals() : loadDeliveryObjectives()).filter((item) => item.name === 'Primeira venda'), section);
      assert.ok(delivered.some((item) => item.channel === 'Amazon') && delivered.some((item) => item.channel === 'Mercado Livre'));
    }
    await page.evaluate(() => {
      openMainPmCatalog('activities'); productActivityState.productId = 'pr1'; openProductActivityDrawer();
    });
    await page.locator('#pa-activity').fill('Testar vinculo por canal');
    const objectiveIds = await page.evaluate(() => loadProductObjectives().filter((item) => item.name === 'Primeira venda' && item.channel === 'Amazon' && item.category === 'Vendas'));
    await page.locator('#pa-objective').selectOption(objectiveIds.find((item) => item.product_id === 'pr1').id);
    await page.locator('#pa-products .multi-picker-control').click();
    await page.locator('#pa-products .multi-picker-option[data-value="pr2"]').click();
    await page.evaluate(() => saveProductActivity());
    const linked = await page.evaluate(() => loadProductActivities().filter((item) => item.activity === 'Testar vinculo por canal'));
    assert.equal(linked.length, 2);
    assert.equal(linked.find((item) => item.product_id === 'pr2').objective_template_id, objectiveIds.find((item) => item.product_id === 'pr2').id);
    const sourceId = await page.evaluate(async () => {
      productActivityState.productId = 'pr1';
      await openProductActivityDrawer();
      document.getElementById('pa-activity').value = 'Copiar objetivo do Mercado Livre';
      document.getElementById('pa-objective').value = loadProductObjectives().find((item) => item.product_id === 'pr1' && item.name === 'Primeira venda' && item.channel === 'Mercado Livre').id;
      await saveProductActivity();
      return loadProductActivities().find((item) => item.activity === 'Copiar objetivo do Mercado Livre').id;
    });
    await page.evaluate(() => { openProductActivities('pr2'); openReadyActivityPicker(); });
    await page.locator(`#ready-activity-list input[value="${sourceId}"]`).check();
    await page.locator('#ready-add').click();
    await page.waitForFunction(() => !document.getElementById('ready-add'));
    const copied = await page.evaluate(() => {
      const task = loadProductActivities().find((item) => item.product_id === 'pr2' && item.activity === 'Copiar objetivo do Mercado Livre');
      return loadProductObjectives().find((item) => item.id === task.objective_template_id);
    });
    assert.equal(copied.name, 'Primeira venda');
    assert.equal(copied.channel, 'Mercado Livre');
    assert.equal(copied.product_id, 'pr2');
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    console.log('Passed: sidebar slots aligned across eight modules and four submodules; company logo, mobile, multichannel goals/objectives, exact duplicate rejection, self edits, delivery sync and cross-product objective binding.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
