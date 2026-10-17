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
    await page.route('**/*', route => route.request().url() === 'http://hierarchy.localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://hierarchy.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true; currentProfile = { id: 'hierarchy-admin', role: 'admin', status: 'active' };
      document.body.classList.add('light');
      saveProductActivities([{ id: 'tf', product_id: 'pr1', activity: 'Apresentacao', category: 'ERP', module: 'Sistema', variation_axes: { channel: ['BLING', 'OLIST'] } }]);
      saveProductGoals([{ id: 'gf', product_id: 'pr1', name: '100 vendas', category: 'ERP', metric: 'Pedidos', target_value: 100, variation_axes: { channel: ['BLING', 'OLIST'] } }]);
      const goal = loadProductGoals().find(row => row.variation_parent_id === 'gf' && row.channel === 'BLING');
      saveProductObjectives([{ id: 'of', product_id: 'pr1', name: 'ERP implementado', category: 'ERP', variation_axes: { channel: ['BLING', 'OLIST'] }, dependency_goal_template_ids: [goal.id] }]);
      cache.projects = [{ id: 'project', product_id: 'pr1', name: 'Entrega', start_date: '2026-10-01', end_date: '2026-10-31' }];
      cache.projectById = Object.fromEntries(cache.projects.map(row => [row.id, row]));
      saveProjectTasks([]); saveDeliveryObjectives([]); saveDeliveryGoals([]);
      await syncProductObjectives(); await syncProductGoals(); await syncProductActivities(); render();
    });
    for (const selector of ['#tabs [data-tab]', '#mobile-module-track [data-mobile-tab]']) {
      assert.deepEqual(await page.locator(selector).evaluateAll(nodes => nodes.map(node => node.dataset.tab || node.dataset.mobileTab).filter(id => ['objectives','goals','activities'].includes(id))), ['objectives','goals','activities']);
    }
    for (const [section, family] of [['objectives','of'], ['goals','gf'], ['activities','tf']]) {
      await page.evaluate(section => openMainPmCatalog(section), section);
      const table = page.locator('#registrations-root table');
      assert.equal(await table.locator('td:not(.expand-cell) .registration-task-toggle').count(), 0);
      assert.equal(await table.locator('.expand-cell .table-row-expand').count(), 1);
      await table.locator('.expand-cell .table-row-expand').click();
      assert.equal(await table.locator('tr.registration-subtask-row:not([hidden])').count(), 2);
      await table.locator('.expand-head').click({ button: 'right', modifiers: ['Control'] });
      await page.locator('#hierarchy-filter-dd input[value="parent"]').uncheck();
      assert.equal(await table.locator('tbody tr:not([hidden])').count(), 2);
      assert.equal(await table.locator('tbody tr:not([hidden])[data-variation-kind="parent"]').count(), 0);
      await page.evaluate(() => closeFloaters());
      await page.evaluate(() => { registrationTableState().pageSize=1; applyRegistrationTableState(document.querySelector('#registrations-root table')); });
      assert.equal(await table.locator('tbody tr:not([hidden])').count(), 1);
      await page.locator('.reg-page-next').click();
      assert.equal(await table.locator('tbody tr:not([hidden])').count(), 1);
      await table.locator('.expand-head').click({ button: 'right', modifiers: ['Control'] });
      await page.locator('#hierarchy-filter-dd input[value="parent"]').check();
      await page.locator('#hierarchy-filter-dd input[value="variations"]').uncheck();
      assert.equal(await table.locator('tbody tr:not([hidden])').count(), 1);
      assert.equal(await table.locator('.expand-cell .table-row-expand').isDisabled(), true);
      await page.locator('#hierarchy-filter-dd input[value="variations"]').check();
      await page.evaluate(() => closeFloaters());
      assert.equal(await table.locator(`tr[data-task-group="${family}"]`).count(), 1);
      await page.screenshot({ path: path.join(os.tmpdir(), `${section}-hierarchy-column.png`) });
      await page.evaluate(section => {
        closeModal(); openProductActivities('pr1'); document.querySelector(`[data-product-tab="${section}"]`).click();
      }, section);
      assert.deepEqual(await page.locator('[data-product-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.productTab)), ['objectives','goals','activities']);
      const productTable = page.locator('#product-activities-root table');
      assert.equal(await productTable.locator('.expand-cell .table-row-expand').count(), 1);
      await productTable.locator('.expand-head').click({ button: 'right', modifiers: ['Control'] });
      await page.locator('#hierarchy-filter-dd input[value="parent"]').uncheck();
      assert.equal(await productTable.locator('tbody tr:not([hidden])').count(), 2);
      await page.locator('#hierarchy-filter-dd input[value="parent"]').check();
      await page.evaluate(() => { closeFloaters(); closeModal(); });
    }
    await page.evaluate(() => {
      const objective = loadProductObjectives().find(row => row.variation_parent_id === 'of');
      window.objectiveChildId = objective.id;
      openRegistrationTemplateEditor('objectives', 'pr1', objective.id);
    });
    assert.equal(await page.locator('#po-goal-dependencies .multi-picker-option').count(), 2);
    const customized = await page.evaluate(() => {
      const objective = loadProductObjectives().find(row => row.id === objectiveChildId);
      const otherGoal = loadProductGoals().find(row => row.variation_parent_id === 'gf' && !objective.dependency_goal_template_ids.includes(row.id));
      document.querySelectorAll('#po-goal-dependencies .multi-picker-option').forEach(option => option.classList.toggle('active', option.dataset.value === otherGoal.id));
      return otherGoal.id;
    });
    await page.locator('#po-save').click(); await page.waitForFunction(() => !productObjectiveSavePending);
    assert.deepEqual(await page.evaluate(() => loadProductObjectives().find(row => row.id === objectiveChildId).dependency_goal_template_ids), [customized]);
    const status = await page.evaluate(async () => {
      const objective = loadDeliveryObjectives().find(row => row.source_template_id === objectiveChildId);
      const goal = loadDeliveryGoals().find(row => objective.dependency_goal_ids.includes(row.id));
      const blocked = deliveryObjectiveDependencyState(objective).blocked;
      const denied = await updateDeliveryObjective(objective.id, { status:'doing' });
      await updateDeliveryGoal(goal.id, { status:'done' });
      const started = await updateDeliveryObjective(objective.id, { status:'doing' });
      const reopeningDenied = await updateDeliveryGoal(goal.id, { status:'todo' });
      await updateDeliveryObjective(objective.id, { status:'todo' });
      const reopened = await updateDeliveryGoal(goal.id, { status:'todo' });
      return { blocked, denied, started, reopeningDenied, reopened, label: deliveryObjectiveDependencyLabel(objective) };
    });
    assert.equal(status.blocked,true); assert.equal(status.denied,false); assert.equal(status.started,true); assert.equal(status.reopeningDenied,false); assert.equal(status.reopened,true); assert.match(status.label,/Meta:/);
    await page.setViewportSize({ width:390,height:844 });
    await page.evaluate(() => { document.body.classList.add('mobile-list-mode'); openMainPmCatalog('objectives'); });
    const toggle = page.locator('#registrations-root .expand-cell .table-row-expand');
    assert.equal(await toggle.isVisible(),true);
    await toggle.click(); await toggle.click();
    const box = await toggle.boundingBox(); assert.ok(box.width>=44 && box.height>=44);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({ path:path.join(os.tmpdir(),'hierarchy-column-mobile.png') });
    assert.deepEqual(errors,[]); assert.deepEqual(writes,[]);
    console.log('Hierarchy/dependencies passed: navigation order, proper expand column, Ctrl+right-click multi-filter in all three catalogs/products, variation-only pagination, mobile controls, objective goal selection, blocking and reopening rules.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
