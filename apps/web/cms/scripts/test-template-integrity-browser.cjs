const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    await page.route('**/*', route => route.request().url() === 'http://integrity-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://integrity-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'integrity-admin', role: 'admin', status: 'active' };
      // All edits below use local fixtures; synchronization is tested separately.
      syncProductActivities = async () => {};
      Object.assign(cache.projects.find(project => project.id === 'pj1'), { erp_platform: 'BLING' });
      Object.assign(cache.projectById.pj1, { erp_platform: 'BLING' });
      saveProductActivities([
        { id: 'root-a', product_id: 'pr1', template_group_id: 'roots', activity: 'Vendas', channel: 'BLING', type: 'Treinamento', recurrence: 'once' },
        { id: 'root-b', product_id: 'pr1', template_group_id: 'roots', activity: '', category: 'ERP', channel: 'BLING', module: 'Vendas', type: 'Treinamento', recurrence: 'once' },
        { id: 'child-a', product_id: 'pr1', template_group_id: 'children', activity: 'Frente de Caixa', parent_template_id: 'root-a' },
        { id: 'child-b', product_id: 'pr1', template_group_id: 'children', activity: 'Frente de Caixa', parent_template_id: 'root-b' }
      ]);
      cache.productActivities = loadProductActivities();
      saveProjectTasks([{ id: 'execution', project_id: 'pj1', source_template_id: 'root-b',
        title: 'Obsolete name', category: 'Obsolete category', channel: 'Old channel', module: '', type: 'Old type',
        status: 'doing', priority: 'normal', notes: 'Preserved history', assignee_ids: [], checklist: [], dependency_ids: [],
        planned_start_date: '2026-10-01', planned_end_date: '2026-10-20', due_date: '2026-10-20', actual_start_date: '2026-10-02' }]);
      refreshActivityCache(); render(); openMainPmCatalog('activities');
    });
    assert.equal(await page.locator('#registrations-root tbody tr[data-task-group]').count(), 2, 'Both conflicting roots remain visible');
    await page.locator('#registrations-root .table-row-expand').first().click();
    await page.locator('#registrations-root .table-row-expand').last().click();
    assert.equal(await page.locator('.registration-subtask-row:not([hidden])').count(), 2, 'Each root keeps its own child');
    await page.evaluate(() => { registrationTableState().view = 'mindmap'; renderRegistrationsSection(); });
    assert.equal(await page.locator('#registrations-root').innerText().then(text => text.includes('Vendas')), true);
    const hierarchy = await page.evaluate(() => registrationTaskHierarchy(loadProductActivities(), REGISTRATION_MIND_MAP_TEMPLATE_ADAPTER).nodeById.size);
    assert.equal(hierarchy, 4, 'The mind map must not collapse colliding groups');
    await page.evaluate(() => {
      registrationTableState().view = 'table'; renderRegistrationsSection();
      openRegistrationTemplateEditor('activities', 'pr1', 'root-a');
    });
    assert.equal(await page.evaluate(() => productActivityRelatedIds.length), 1);
    await page.locator('#pa-activity').fill('Vendas revisadas');
    await page.locator('#pa-save').click();
    await page.waitForFunction(() => !productActivitySavePending && !document.getElementById('pa-save'));
    assert.deepEqual(await page.evaluate(() => loadProductActivities().map(row => [row.id, row.activity, row.template_group_id])), [
      ['root-a', 'Vendas revisadas', 'roots'], ['root-b', '', 'roots'],
      ['child-a', 'Frente de Caixa', 'children'], ['child-b', 'Frente de Caixa', 'children']
    ]);
    const consumers = await page.evaluate(() => {
      const raw = loadProjectTasks()[0];
      state.tab = 'activities'; state.q = 'ERP'; state.sortK = null; state.filters = {};
      projectBoardState.section = 'activities';
      return {
        search: rowsFor('activities', cache).map(row => row.id),
        card: taskCardHtml(raw), exportValues: projectSectionValues(raw, [raw]),
        schedule: scheduleItem('activities', raw, cache).title,
        raw: { title: raw.title, category: raw.category, status: raw.status, notes: raw.notes }
      };
    });
    assert.deepEqual(consumers.search, ['execution']);
    assert.ok(consumers.card.includes('ERP | BLING | Vendas | Treinamento'));
    assert.ok(!consumers.card.includes('Obsolete name'));
    assert.ok(consumers.exportValues.some(value => String(value).includes('ERP | BLING | Vendas | Treinamento')));
    assert.ok(!consumers.schedule.includes('Obsolete name'));
    assert.deepEqual(consumers.raw, { title: 'Obsolete name', category: 'Obsolete category', status: 'doing', notes: 'Preserved history' });
    await page.evaluate(() => openDeliveryTaskDrawer('pj1', 'execution'));
    assert.equal(await page.locator('#project-task-title').inputValue(), '');
    assert.equal(await page.locator('#project-task-category').inputValue(), 'ERP');
    assert.equal(await page.locator('#project-task-category').getAttribute('readonly'), '');
    assert.equal(await page.locator('#project-task-type').getAttribute('readonly'), '');
    await page.locator('#project-task-priority').selectOption('high');
    await page.locator('#project-task-save').click();
    await page.waitForFunction(() => !document.getElementById('project-task-save'));
    const saved = await page.evaluate(() => loadProjectTasks()[0]);
    assert.equal(saved.priority, 'high');
    assert.equal(saved.title, 'Obsolete name', 'Operational saves must not persist projected identification');
    assert.equal(saved.category, 'Obsolete category');
    assert.equal(saved.source_template_id, 'root-b');
    assert.equal(saved.notes, 'Preserved history');
    await page.evaluate(() => { closeModal(); openProductActivities('pr1'); cloneProductActivity('root-a'); });
    await page.locator('#pa-activity').fill('Clone local');
    await page.locator('#pa-save').click();
    await page.waitForFunction(() => !productActivitySavePending && !document.getElementById('pa-save'));
    assert.equal(await page.evaluate(() => loadProductActivities().find(row => row.activity === 'Clone local').template_group_id === 'roots'), false);
    await page.evaluate(() => {
      const rows = loadProductActivities();
      rows.push({ id: 'source-parent', product_id: 'pr2', template_group_id: 'roots', activity: 'Outro pai', recurrence: 'once' },
        { id: 'source-child', product_id: 'pr2', template_group_id: 'children', activity: 'Frente de Caixa', parent_template_id: 'source-parent', recurrence: 'once' });
      saveProductActivities(rows); cache.productActivities = rows;
      openReadyActivityPicker();
    });
    await page.locator('#ready-activity-list input[value="source-child"]').check();
    await page.locator('#ready-add').click();
    await page.waitForFunction(() => !document.getElementById('ready-add'));
    const copied = await page.evaluate(() => {
      const rows = loadProductActivities();
      const parent = rows.find(row => row.product_id === 'pr1' && row.activity === 'Outro pai');
      const child = rows.find(row => row.parent_template_id === parent?.id);
      return { parent: parent?.template_group_id, child: child?.template_group_id, name: child?.activity };
    });
    assert.ok(copied.parent && copied.parent !== 'roots');
    assert.ok(copied.child && copied.child !== 'children');
    assert.equal(copied.name, 'Frente de Caixa', 'A same-name child with another parent must be copied, not silently conflated');
    for (const view of ['table', 'calendar', 'gantt', 'schedule']) {
      await page.evaluate(view => { closeModal(); state.tab = 'activities'; state.pmScopes.activities = 'deliveries'; state.q = ''; state.view = view; refreshActivityCache(); render(); }, view);
      assert.ok(!(await page.locator('#main').innerText()).includes('Obsolete name'), `${view} must use canonical identification`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { state.view = 'table'; render(); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], 'Browser fixtures must never write to a live service');
    console.log('Template integrity browser passed: table/mindmap collisions, isolated edits, safe cloning/import with parent links, canonical search/cards/export/schedule, read-only identification and operational saves, desktop/mobile.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
