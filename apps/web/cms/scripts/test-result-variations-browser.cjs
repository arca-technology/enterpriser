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
    for (const section of ['goals', 'objectives']) {
      const prefix = section === 'goals' ? 'pg' : 'po';
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
      await page.route('**/*', route => route.request().url() === 'http://results.localhost/'
        ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
      await page.goto('http://results.localhost/');
      await page.evaluate(() => { window.CRM_CONFIG = {}; });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
      await page.addScriptTag({ content: source });
      await page.evaluate(async section => {
        await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
        currentUserIsAdmin = () => true;
        currentProfile = { id: 'result-admin', role: 'admin', status: 'active' };
        saveProductActivities([]); saveProductObjectives([]); saveProductGoals([]);
        const legacy = { id: 'legacy', product_id: 'pr1', name: 'Modelo existente', category: 'Empresa', channel: '', metric: 'Pedidos', target_value: 1 };
        if (section === 'goals') saveProductGoals([legacy]); else saveProductObjectives([legacy]);
        window.legacySnapshot = JSON.stringify(legacy);
        cache.projects = [{ id: 'delivery', product_id: 'pr1', name: 'Entrega', start_date: '2026-10-01', end_date: '2026-10-31' }];
        cache.projectById = Object.fromEntries(cache.projects.map(row => [row.id, row]));
        saveProjectTasks([]); saveDeliveryGoals([]); saveDeliveryObjectives([]);
        render(); openMainPmCatalog(section);
      }, section);
      await page.locator('#registration-add').click();
      await page.locator(`#${prefix}-name`).fill('Primeira venda');
      await page.locator(`#${prefix}-category`).fill('Canais de venda');
      if (section === 'goals') {
        await page.locator('#pg-metric').fill('Pedidos');
        await page.locator('#pg-target').fill('1');
      }
      assert.equal(await page.locator('.task-variation-toggle input').count(), 2);
      await page.locator(`#${prefix}-vary-channel`).check();
      await page.locator(`#${prefix}-variants-channel .multi-picker-control`).click();
      for (const value of ['AMAZON', 'SHOPEE']) await page.locator(`#${prefix}-variants-channel [data-value="${value}"]`).click();
      await page.locator(`#${prefix}-name`).click();
      assert.equal(await page.locator(`#${prefix}-variation-preview .task-variation-preview-list>div`).count(), 2);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(os.tmpdir(), `${section}-variations-mobile.png`) });
      await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(() => !productGoalSavePending && !productObjectiveSavePending);
      const initial = await page.evaluate(section => {
        const rows = section === 'goals' ? loadProductGoals() : loadProductObjectives();
        const family = rows.find(isVariationParent), children = rows.filter(row => row.variation_parent_id === family.id);
        window.familyId = family.id; window.childIds = children.map(row => row.id).sort();
        const executions = section === 'goals' ? loadDeliveryGoals() : loadDeliveryObjectives();
        const historical = executions.find(row => row.source_template_id === childIds[0]);
        historical.status = 'done'; historical.schedule_manual = true;
        if (section === 'goals') historical.current_value = 1;
        if (section === 'goals') saveDeliveryGoals(executions); else saveDeliveryObjectives(executions);
        window.executionHistory = JSON.stringify(executions.map(row => [row.id,row.status,row.current_value,row.schedule_manual ? row.due_date : null]));
        return { channels: children.map(row => row.channel).sort(), legacy: JSON.stringify(rows.find(row => row.id === 'legacy')) === legacySnapshot,
          parentExecuted: executions.some(row => row.source_template_id === family.id), childExecutions: executions.filter(row => childIds.includes(row.source_template_id)).length };
      }, section);
      assert.deepEqual(initial, { channels: ['AMAZON', 'SHOPEE'], legacy: true, parentExecuted: false, childExecutions: 2 });
      await page.locator('.registration-task-toggle').click();
      assert.equal(await page.locator('.registration-subtask-row:not([hidden])').count(), 2);
      await page.evaluate(section => openRegistrationTemplateEditor(section, 'pr1', childIds[0]), section);
      for (const key of ['name','category','channel']) assert.equal(await page.locator(`#${prefix}-${key}`).isDisabled(), true);
      await page.locator(`#${prefix}-notes`).fill('Informacao exclusiva');
      await page.locator(`#${prefix}-target-days`).fill('5');
      if (section === 'goals') await page.locator('#pg-target').fill('100');
      else await page.locator('#po-criteria').fill('Criterio exclusivo');
      await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(() => !productGoalSavePending && !productObjectiveSavePending);
      await page.evaluate(section => openRegistrationTemplateEditor(section, 'pr1', familyId), section);
      await page.locator(`#${prefix}-name`).fill('Primeira venda revisada');
      await page.locator(`#${prefix}-notes`).fill('Novo padrao');
      await page.locator(`#${prefix}-target-days`).fill('20');
      await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(() => !productGoalSavePending && !productObjectiveSavePending);
      const saved = await page.evaluate(section => {
        const rows = section === 'goals' ? loadProductGoals() : loadProductObjectives();
        const child = rows.find(row => row.id === childIds[0]), sibling = rows.find(row => row.id === childIds[1]);
        const executions = section === 'goals' ? loadDeliveryGoals() : loadDeliveryObjectives();
        const adapter = section === 'goals' ? REGISTRATION_MIND_MAP_GOAL_ADAPTER : REGISTRATION_MIND_MAP_OBJECTIVE_ADAPTER;
        const hierarchy = registrationTaskHierarchy(rows,adapter);
        return { child: [child.name,child.notes,child.target_days,section === 'goals' ? child.target_value : child.completion_criteria],
          sibling: [sibling.notes,sibling.target_days], ids: rows.filter(row => row.variation_parent_id === familyId).map(row => row.id).sort(),
          history: JSON.stringify(executions.map(row => [row.id,row.status,row.current_value,row.schedule_manual ? row.due_date : null])) === executionHistory,
          nested: hierarchy.children.get(familyId)?.length };
      }, section);
      assert.deepEqual(saved.child, ['Primeira venda revisada','Informacao exclusiva',5,section === 'goals' ? 100 : 'Criterio exclusivo']);
      assert.deepEqual(saved.sibling, ['Novo padrao',20]);
      assert.deepEqual(saved.ids, await page.evaluate(() => childIds));
      assert.equal(saved.history,true); assert.equal(saved.nested,2);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(section => {
        openProductActivities('pr1'); productActivityState.tab=section;
        if (section === 'goals') renderProductGoals(); else renderProductObjectives();
      },section);
      assert.equal(await page.locator('#product-activities-root tr[data-parent-id]').count(),2);
      await page.screenshot({ path: path.join(os.tmpdir(), `${section}-variations-desktop.png`) });
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      await page.close();
    }
    console.log('Goal/objective variations passed: two axes, preview, catalog nesting, product nesting, child-only executions, editable child details, selective inheritance, stable IDs, unchanged legacy and operational history, mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
