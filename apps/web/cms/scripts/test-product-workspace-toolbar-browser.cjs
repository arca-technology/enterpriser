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
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://product-toolbar.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://product-toolbar.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'toolbar-admin', role: 'admin', status: 'active' };
      saveProductActivities([
        { id: 'parent', product_id: 'pr1', activity: 'Vendas', category: 'ERP', channel: 'BLING', module: 'Vendas', sort_order: 0 },
        { id: 'child', product_id: 'pr1', activity: 'Lancamento', category: 'Fiscal', channel: 'BLING', parent_template_id: 'parent', sort_order: 1 },
        { id: 'other', product_id: 'pr1', activity: 'Suporte', category: 'ERP', channel: 'OLIST', sort_order: 2 },
        { id: 'source', product_id: 'pr2', activity: 'Importar', category: 'Financeiro', sort_order: 0 }
      ]);
      saveProductObjectives([
        { id: 'objective', product_id: 'pr1', name: 'Cadastrar', category: 'ERP', channel: 'BLING' },
        { id: 'outside-objective', product_id: 'pr2', name: 'Outro produto' }
      ]);
      saveProductGoals([
        { id: 'goal', product_id: 'pr1', name: 'Primeira venda', category: 'Comercial', metric: 'Pedidos', target_value: 1 },
        { id: 'outside-goal', product_id: 'pr2', name: 'Outro produto', metric: 'Pedidos', target_value: 2 }
      ]);
      window.workspaceSnapshot = JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals(), loadProjectTasks()]);
      render(); openProductActivities('pr1');
    });
    const workspace = page.locator('#product-activities-root');
    const search = () => workspace.locator('.product-workspace-search');
    const visibleIds = () => workspace.locator('tbody tr[data-id]:not([hidden])').evaluateAll(rows => rows.map(row => row.dataset.id));
    const view = async name => {
      await workspace.locator('.product-view-menu-btn').click();
      await page.locator(`#product-view-dd [data-view="${name}"]`).click();
    };
    assert.equal(await search().isVisible(), true);
    assert.equal(await workspace.locator('.registration-toolbar-center #pa-ready').count(), 1);
    for (const name of ['Matriz', 'Dashboard']) assert.equal(await workspace.getByRole('button', { name, exact: true }).isDisabled(), true);
    await search().fill('Lancamento');
    assert.deepEqual(await visibleIds(), ['parent', 'child']);
    assert.equal(await workspace.locator('.product-record-count').innerText(), '2 Tarefas');
    await view('mindmap');
    assert.equal(await workspace.locator('.product-activity-list').isVisible(), false);
    assert.equal(await workspace.locator('.product-mind-view .product-mind-edit[data-id="child"]').count(), 1);
    assert.equal(await workspace.locator('.product-mind-view').innerText().then(text => text.includes('Suporte')), false);
    assert.equal(await workspace.locator('.product-cols-btn').isDisabled(), true);
    await search().fill('Nao existe');
    assert.equal(await workspace.locator('.product-mind-view .empty').count(), 1);
    await search().fill('Lancamento');
    await view('table');
    assert.deepEqual(await visibleIds(), ['parent', 'child']);
    await search().fill('');
    const category = workspace.locator('th[data-product-label="Categoria"]');
    await category.click({ modifiers: ['Control'] });
    await page.locator('#product-filter-dd .dd-item[data-value="Fiscal"]').click();
    await page.locator('#product-filter-dd .dd-apply').click();
    await view('mindmap');
    assert.equal(await workspace.locator('.product-mind-edit').count(), 2);
    await workspace.locator('.product-mind-edit[data-id="child"]').click();
    assert.equal(await page.locator('#pa-activity').inputValue(), 'Lancamento');
    assert.equal(await page.locator('#pa-add-subtask').count(), 0, 'Products only link existing tasks');
    await page.locator('#pa-cancel').click();
    await view('table');
    await workspace.locator('.product-filter-strip .registration-filter-badge').click();
    await workspace.locator('.product-cols-btn').click();
    const channelKey = await workspace.locator('th[data-product-label="Canal"]').getAttribute('data-product-column');
    await page.locator(`#cols-dd .column-manager-row[data-k="${channelKey}"] .column-switch`).click();
    assert.equal(await workspace.locator('th[data-product-label="Canal"]').isVisible(), false);
    await page.locator('#cols-dd .column-manager-close').click();
    await page.evaluate(() => renderProductActivities());
    assert.equal(await workspace.locator('th[data-product-label="Canal"]').isVisible(), false, 'Column preferences survive rerenders');
    assert.equal(await workspace.locator('thead th').first().getAttribute('class'), 'select-head noclick');
    assert.ok((await workspace.locator('thead th').last().getAttribute('class')).includes('table-actions-head'));
    await workspace.locator('.product-cols-btn').click();
    await page.locator('#cols-dd .column-manager-preset').click();
    await page.locator('#cols-dd .column-manager-close').click();
    assert.equal(await workspace.locator('th[data-product-label="Canal"]').isVisible(), true);
    await workspace.locator('#pa-ready').click();
    assert.equal(await page.locator('#ready-activity-list input[value="source"]').count(), 1);
    await page.locator('#ready-close').click();
    for (const [section, field] of [['objectives', 'po-name'], ['goals', 'pg-name']]) {
      await page.locator(`[data-product-tab="${section}"]`).click();
      assert.equal(await workspace.locator('#po-new,#pg-new,.po-clone,.pg-clone').count(), 0);
      assert.equal(await search().inputValue(), '');
      await search().fill(section === 'goals' ? 'Primeira' : 'Cadastrar');
      await view('mindmap');
      assert.equal(await workspace.locator('.product-mind-edit').count(), 1);
      assert.equal(await workspace.locator('.product-mind-view').innerText().then(text => text.includes('Outro produto')), false);
      await workspace.locator('.product-mind-edit').click();
      assert.equal(await page.locator(`#${field}`).count(), 1);
      await page.locator(`#${section === 'goals' ? 'pg' : 'po'}-cancel`).click();
      await view('table');
      assert.equal(await search().inputValue(), section === 'goals' ? 'Primeira' : 'Cadastrar');
    }
    await page.locator('[data-product-tab="activities"]').click();
    assert.equal(await workspace.locator('.pa-clone').count(), 0);
    for (const width of [1920, 1738, 1650, 1440, 1280, 1101, 1024, 768, 390, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const input = await search().boundingBox(), link = await workspace.locator('#pa-ready').boundingBox();
      const tools = await workspace.locator('.registration-toolbar-right').boundingBox();
      assert.ok(input && link && input.x + input.width <= link.x && Math.abs(input.y - link.y) < 5, `${width}: search and link button must be side by side`);
      assert.ok(tools && tools.x >= 0 && tools.x + tools.width <= width, `${width}: toolbar must fit`);
      if (width > 1100) {
        const toolbar = await workspace.locator('.product-workspace-toolbar').boundingBox();
        assert.ok(Math.abs(input.x + input.width / 2 - toolbar.x - toolbar.width / 2) < 2, `${width}: search input must be centered in the toolbar`);
        const firstTool = await workspace.locator('.product-cols-btn').boundingBox();
        assert.ok(link.x + link.width + 6 <= firstTool.x, `${width}: link must not overlap the view controls`);
      }
      assert.equal(await workspace.locator('.product-cols-btn').isVisible(), true, `${width}: column selector must remain available`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(os.tmpdir(), `product-workspace-toolbar-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await workspace.locator('.product-cols-btn').click();
    const manager = await page.locator('#cols-dd').boundingBox();
    assert.ok(manager && manager.x >= 0 && manager.x + manager.width <= 390, 'Mobile column manager must fit the viewport');
    await page.locator('#cols-dd .column-manager-close').click();
    await view('mindmap');
    await page.screenshot({ path: path.join(os.tmpdir(), 'product-workspace-mindmap-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals(), loadProjectTasks()]) === workspaceSnapshot), true);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log('Product workspace toolbar passed: search, link placement, column preferences/reset, filtered mind maps and editing in all tabs, responsive layouts, scoped data and no writes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
