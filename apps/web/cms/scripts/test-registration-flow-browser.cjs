const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/^startApp\(\);/m, '');
const library = fs.readFileSync(path.join(root, 'vendor/dagre.min.js'), 'utf8');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], writes = [];
    let libraryRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => {
      if (route.request().url() === 'http://flow.localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/vendor/dagre.min.js')) { libraryRequests++; return route.fulfill({ contentType: 'text/javascript', body: library }); }
      return route.abort();
    });
    await page.goto('http://flow.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'flow-admin', role: 'admin', status: 'active' };
      const objective = (id, name, dependencies = [], extra = {}) => ({ id, product_id: 'pr1', name, category: 'Canais de venda', channel: 'MERCADO LIVRE', dependency_objective_template_ids: dependencies, ...extra });
      saveProductObjectives([
        objective('shipping', 'MERCADO ENVIOS'), objective('places', 'MERCADO ENVIOS PLACES', ['shipping']),
        objective('collection', 'MERCADO ENVIOS COLETAS', ['shipping']), objective('full', 'MERCADO ENVIOS FULL', ['shipping']),
        objective('flex', 'MERCADO ENVIOS FLEX', ['shipping']),
        objective('silver', 'Silver'), objective('gold', 'Gold', ['silver']), objective('platinum', 'Platinum', ['gold']),
        objective('joined', 'Duas dependencias', ['full', 'flex']),
        objective('outside', 'Outro produto', [], { product_id: 'pr2' }),
        objective('same-name', 'Silver', [], { channel: 'AMAZON' })
      ]);
      saveProductGoals([
        { id: 'sales', product_id: 'pr1', name: 'Primeira venda', category: 'Comercial', channel: 'AMAZON', metric: 'Pedidos', target_value: 1 },
        { id: 'growth', product_id: 'pr1', name: 'Crescimento', category: 'Comercial', channel: 'AMAZON', metric: 'Pedidos', target_value: 20, dependency_goal_template_ids: ['sales'] }
      ]);
      saveProductActivities([
        { id: 'parent', product_id: 'pr1', activity: 'Vendas', category: 'ERP', channel: 'BLING' },
        { id: 'child', product_id: 'pr1', activity: 'Lancamento', category: 'ERP', channel: 'BLING', parent_template_id: 'parent' },
        { id: 'review', product_id: 'pr1', activity: 'Revisao', category: 'Fiscal', channel: 'BLING', dependency_template_ids: ['child'] }
      ]);
      window.snapshot = JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals(), loadProjectTasks()]);
      render(); openProductActivities('pr1');
    });
    const product = page.locator('#product-activities-root');
    const selectProductView = async view => {
      await product.locator('.product-view-menu-btn').click();
      await page.locator(`#product-view-dd [data-view="${view}"]`).click();
    };
    const ready = () => page.waitForSelector('.registration-flow-shell[data-flow-ready="true"]');
    const node = id => page.locator(`[data-flow-node="${id}"]`);
    await page.locator('[data-product-tab="objectives"]').click();
    await selectProductView('flow'); await ready();
    assert.equal(libraryRequests, 1, 'Library loads only on demand');
    assert.equal(await node('outside').count(), 0, 'Product scope excludes other products');
    assert.equal(await node('same-name').count(), 1, 'Distinct records with equal names stay distinct');
    assert.equal(await page.locator('.flow-choice').count(), 1);
    assert.equal(await page.locator('.flow-edge-alternative').count(), 2, 'Only Places and Coletas are exclusive');
    for (const id of ['full', 'flex']) assert.equal(await page.locator(`.flow-edge-dependency[data-flow-to="${id}"]`).count(), 1);
    const shipping = await node('shipping').boundingBox(), places = await node('places').boundingBox(), collection = await node('collection').boundingBox();
    assert.ok(shipping.x < places.x && Math.abs(places.x - collection.x) < 1 && Math.abs(places.y - collection.y) > 30, 'Alternative destinations share a rank and branch side by side');
    const silver = await node('silver').boundingBox(), gold = await node('gold').boundingBox(), platinum = await node('platinum').boundingBox();
    assert.ok(silver.x < gold.x && gold.x < platinum.x, 'Sequential objectives follow their dependencies');
    assert.equal(await page.locator('.flow-edge[data-flow-to="joined"]').count(), 2, 'Multiple prerequisites remain AND, without invented alternative');
    const assertNoOverlap = async () => {
      const boxes = await page.locator('.registration-flow-node').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!(boxes[i].left < boxes[j].right - 1 && boxes[i].right > boxes[j].left + 1 && boxes[i].top < boxes[j].bottom - 1 && boxes[i].bottom > boxes[j].top + 1), 'Cards must not overlap');
    };
    await assertNoOverlap();
    await node('places').getByRole('button').click();
    assert.equal(await page.locator('#po-name').inputValue(), 'MERCADO ENVIOS PLACES');
    await page.locator('#po-cancel').click();
    await product.locator('.product-workspace-search').fill('PLACES'); await ready();
    assert.equal(await node('shipping').locator('.flow-context-label').count(), 1, 'Search retains prerequisite context');
    assert.equal(await node('collection').count(), 0);
    await product.locator('.product-workspace-search').fill('Nao existe');
    assert.equal(await page.locator('.registration-flow-status').innerText(), 'Nenhum registro corresponde aos filtros.');
    await product.locator('.product-workspace-search').fill(''); await ready();
    await page.locator('[data-flow-action="vertical"]').click();
    await page.waitForFunction(() => Number(document.querySelector('[data-flow-node="gold"]').style.top.replace('px', '')) < Number(document.querySelector('[data-flow-node="platinum"]').style.top.replace('px', '')));
    await assertNoOverlap();
    await page.locator('[data-flow-action="zoom-in"]').click();
    assert.equal(await page.locator('.flow-zoom').innerText(), '120%');
    await page.locator('[data-flow-action="fullscreen"]').click();
    assert.equal(await page.locator('.registration-flow-shell.is-fullscreen').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.registration-flow-shell.is-fullscreen').count(), 0);
    assert.equal(await product.count(), 1, 'Escape exits fullscreen without closing product');
    await page.locator('[data-flow-action="reset"]').click();
    await page.locator('[data-flow-action="horizontal"]').click();
    await page.waitForFunction(() => Number(document.querySelector('[data-flow-node="gold"]').style.left.replace('px', '')) < Number(document.querySelector('[data-flow-node="platinum"]').style.left.replace('px', '')));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('[data-flow-action="fit"]').click();
      const controls = await page.locator('.registration-flow-controls').boundingBox();
      assert.ok(controls && controls.x >= 0 && controls.x + controls.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(os.tmpdir(), `registration-flow-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [section, id, prefix] of [['goals', 'growth', 'pg'], ['activities', 'child', 'pa']]) {
      await page.locator(`[data-product-tab="${section}"]`).click(); await selectProductView('flow'); await ready();
      assert.equal(await node(id).count(), 1);
      if (section === 'activities') assert.equal(await page.locator('.flow-edge-subtask').count(), 1);
      await node(id).getByRole('button').click();
      assert.equal(await page.locator(`#${prefix}-${prefix === 'pa' ? 'activity' : 'name'}`).count(), 1);
      await page.locator(`#${prefix}-cancel`).click();
      await selectProductView('mindmap'); assert.equal(await product.locator('.registration-mindmap-shell').count(), 1);
      await selectProductView('table'); assert.equal(await product.locator('.product-activity-list').isVisible(), true);
    }
    await page.evaluate(() => closeModal());
    for (const section of ['activities', 'goals', 'objectives']) {
      await page.locator(`#tabs [data-tab="${section}"]`).click();
      await page.evaluate(() => { if (!mainPmCatalogActive()) { state.pmScopes[state.tab] = 'catalog'; render(); } });
      await page.locator('#registration-view-menu-btn').click();
      await page.locator('#registration-view-dd [data-view="flow"]').click(); await ready();
      assert.ok(await page.locator('.registration-flow-node').count() > 0);
      await page.locator('.registration-flow-node .reg-template-edit').first().click();
      assert.equal(await page.locator('.activity-form-drawer').count(), 1);
      await page.locator('.activity-form-drawer .modal-close-x').click();
      await page.locator('#registration-view-menu-btn').click();
      await page.locator('#registration-view-dd [data-view="table"]').click();
      assert.equal(await page.locator('#registrations-root table').count(), 1);
    }
    const modelAudit = await page.evaluate(() => {
      const adapter = REGISTRATION_MIND_MAP_OBJECTIVE_ADAPTER;
      const original = loadProductObjectives();
      const cycle = [{ id: 'cycle-a', name: 'A', dependency_objective_template_ids: ['cycle-b'] }, { id: 'cycle-b', name: 'B', dependency_objective_template_ids: ['cycle-a'] }];
      const model = registrationFlowModel(cycle, adapter);
      const target = document.createElement('div'); target.innerHTML = registrationFlowShellHtml(cycle, adapter, '', 'cycle-test').html;
      document.body.appendChild(target); wireRegistrationFlow(target);
      return { nodes: model.nodes.length, edges: model.edges.length, unchanged: JSON.stringify(original) === JSON.stringify(loadProductObjectives()) };
    });
    assert.deepEqual(modelAudit, { nodes: 2, edges: 2, unchanged: true });
    await page.waitForFunction(() => document.querySelector('[data-flow-scope="flow:cycle-test"]').dataset.flowReady === 'true');
    assert.ok((await page.locator('[data-flow-scope="flow:cycle-test"] .registration-flow-status').innerText()).includes('ciclo'));
    assert.equal(libraryRequests, 1);
    assert.equal(await page.evaluate(() => JSON.stringify([loadProductActivities(), loadProductObjectives(), loadProductGoals(), loadProjectTasks()]) === snapshot), true);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log('Flow passed: real dependencies, exclusive logistics forks, parallel paths, joins, subtasks, equal names, scoped products, search context, cycles, editors, all catalogs, view switching, pan/zoom/fullscreen, mobile layout and zero data writes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
