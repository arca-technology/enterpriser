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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://audit-test.local/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://audit-test.local/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => { await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin(); render(); });

    const revenue = await page.evaluate(() => {
      const project = { marketplace_channels: ['AMAZON'], business_metrics: [
        { month: '2026-01', revenue: 500, channel_revenue: {} },
        { month: '2026-02', revenue: 200, channel_revenue: { 'NÃO INFORMADO': 200 } },
        { month: '2026-03', revenue: 999, channel_revenue: { SHEIN: 0 } },
      ] };
      const channels = projectRevenueChannels(project);
      const holder = document.createElement('div');
      holder.innerHTML = projectBusinessMetricsHtml(project.business_metrics, '2026-01-01', '2026-03-31', cache, channels);
      document.body.append(holder);
      const rows = readProjectBusinessMetrics(holder);
      holder.remove();
      return { channels, rows, zero: projectMetricRevenue(project.business_metrics[2]) };
    });
    assert.deepEqual(revenue.channels, ['AMAZON', 'NÃO INFORMADO', 'SHEIN']);
    assert.equal(revenue.rows[0].channel_revenue['NÃO INFORMADO'], 500);
    assert.equal(revenue.rows[0].channel_revenue.AMAZON, undefined);
    assert.equal(revenue.rows[1].revenue, 200);
    assert.equal(revenue.rows[2].revenue, 0);
    assert.equal(revenue.zero, 0);
    const caseVariantRevenue = await page.evaluate(() => {
      const rows = [{ month: '2026-01', channel_revenue: { AMAZON: 200, amazon: 500 } }];
      const holder = document.createElement('div');
      holder.innerHTML = projectBusinessMetricsHtml(rows, '2026-01-01', '2026-01-31', cache, ['AMAZON']);
      document.body.append(holder);
      const saved = readProjectBusinessMetrics(holder);
      holder.remove();
      return saved;
    });
    assert.deepEqual(caseVariantRevenue[0].channel_revenue, { AMAZON: 200, amazon: 500 });
    assert.equal(caseVariantRevenue[0].revenue, 700);

    const schedules = await page.evaluate(async () => {
      const names = ['loadProductActivities', 'loadProjectTasks', 'saveProjectTasks', 'projectTaskEnabled',
        'activityOccurrenceDates', 'loadDeliveryObjectives', 'recalculateDependencySchedules',
        'syncDeliveryObjectiveDependencies', 'syncDeliveryGoalDependencies'];
      const originals = Object.fromEntries(names.map((name) => [name, window[name]]));
      const projects = cache.projects;
      const tasks = ['automatic', 'manual', 'done', 'canceled'].map((id) => ({
        id, project_id: 'test-project', source_template_id: `template-${id}`, occurrence_index: 0,
        planned_start_date: '2026-01-05', planned_end_date: '2026-01-08', due_date: '2026-01-08',
        deadline_window: 'date', target_days: 7, recurrence: 'monthly', schedule_manual: id === 'manual',
        status: ['done', 'canceled'].includes(id) ? id : 'todo',
      }));
      try {
        cache.projects = [{ id: 'test-project', product_id: 'test-product', start_date: '2026-01-01' }];
        loadProductActivities = () => tasks.map((task) => ({ id: task.source_template_id, product_id: 'test-product', activity: 'Updated name', recurrence: 'monthly', deadline_window: 'month', target_days: 30 }));
        loadProjectTasks = () => tasks;
        saveProjectTasks = () => {};
        projectTaskEnabled = () => true;
        activityOccurrenceDates = () => ['2026-01-01'];
        loadDeliveryObjectives = () => [];
        recalculateDependencySchedules = syncDeliveryObjectiveDependencies = syncDeliveryGoalDependencies = async () => {};
        await syncProductActivities();
        return tasks;
      } finally {
        cache.projects = projects;
        names.forEach((name) => { window[name] = originals[name]; });
      }
    });
    assert.equal(schedules[0].due_date, '2026-01-31');
    for (const task of schedules.slice(1)) {
      assert.equal(task.planned_start_date, '2026-01-05');
      assert.equal(task.planned_end_date, '2026-01-08');
      assert.equal(task.due_date, '2026-01-08');
      assert.equal(task.deadline_window, 'date');
      assert.equal(task.title, 'Updated name');
    }

    const pipeline = await page.evaluate(async () => {
      const oldPipelines = DEMO.pipelines;
      const oldDeals = DEMO.deals;
      try {
        DEMO.pipelines = [{ id: 'safe-pipeline', name: 'Test', stages: ['Lead', 'Proposal'] }];
        DEMO.deals = [{ id: 'linked-deal', title: 'Linked deal', pipeline_id: 'safe-pipeline', stage: 'Lead', status: 'open' }];
        const outcomes = [];
        for (const action of [
          () => updateRow('pipelines', 'safe-pipeline', { stages: ['Renamed', 'Proposal'] }),
          () => updateRow('pipelines', 'safe-pipeline', { stages: null }),
          () => deleteRow('pipelines', 'safe-pipeline'),
          () => createRow('pipelines', { name: 'Invalid', stages: ['Lead', 'lead'] }),
          () => createRow('pipelines', { name: 'Invalid', stages: ['Ganho'] }),
        ]) {
          try { await action(); outcomes.push('allowed'); } catch (error) { outcomes.push(error.message); }
        }
        await updateRow('pipelines', 'safe-pipeline', { stages: ['Proposal', 'Lead', 'New stage'] });
        DEMO.deals[0].stage = 'Old removed stage';
        const c = { ...cache, deals: DEMO.deals, pipelines: DEMO.pipelines, pipelineById: { 'safe-pipeline': DEMO.pipelines[0] } };
        state.kanbanPipelineId = 'safe-pipeline';
        state.filters.deals = {};
        state.q = '';
        renderKanban(c);
        return { outcomes, visible: Boolean(document.querySelector('.kanban .card[data-id="linked-deal"]')), text: document.querySelector('.kanban').textContent };
      } finally {
        DEMO.pipelines = oldPipelines;
        DEMO.deals = oldDeals;
      }
    });
    assert.ok(pipeline.outcomes.every((outcome) => outcome !== 'allowed'));
    assert.equal(pipeline.visible, true);
    assert.match(pipeline.text, /Etapa n\u00e3o encontrada/);

    await page.evaluate(() => {
      window.mergeWrites = [];
      const contact = { id: 'merge-person', name: 'Pessoa Teste', phone: '+55 (11) 99999-1234',
        email: 'old@example.com', job_title: 'Manager', notes: 'Preserve notes',
        tags: ['old'], groups: 'Old group', contact_type: 'Cliente', company_ids: ['old-company'], company_id: 'old-company' };
      cache.contacts = [contact, { id: 'other-person', name: 'Other', tags: ['new'], groups: 'New group' }];
      cache.contactById = { [contact.id]: contact };
      cache.contactCompanies = [{ contact_id: contact.id, company_id: 'old-company' }];
      cache.companies = [{ tax_id: 'old-company', legal_name: 'Old Company' }, { tax_id: 'new-company', legal_name: 'New Company' }];
      cache.companyById = Object.fromEntries(cache.companies.map((item) => [item.tax_id, item]));
      updateRow = async (table, id, body) => { mergeWrites.push({ table, id, body }); return { ...contact, ...body }; };
      createRow = async () => { throw new Error('A duplicate must never be created'); };
      replaceContactCompanyLinks = async (payload) => { mergeWrites.push({ links: payload }); };
      init = async () => {};
      window.openMergeTest = () => openForm('contacts', null, { defaults: {
        name: contact.name, phone: contact.phone, email: '', notes: '', job_title: 'Director',
        company_ids: ['new-company'], tags: ['new'], groups: ['New group'], contact_type: ['Parceiro'],
      } });
      openMergeTest();
    });
    await page.locator('#save').click();
    await page.locator('#contact-merge-confirm').waitFor();
    assert.equal(await page.evaluate(() => mergeWrites.length), 0);
    assert.equal(await page.locator('[data-contact-merge-field="job_title"]').isChecked(), false);
    assert.equal(await page.locator('[data-contact-merge-preview="job_title"]').textContent(), 'Manager');
    await page.locator('#contact-merge-confirm').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.contact-merge-modal .nested-modal-close').evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.equal(await page.evaluate(() => mergeWrites.length), 0);
    await page.locator('#save').click();
    await page.locator('#contact-merge-confirm').click();
    await page.waitForFunction(() => mergeWrites.length === 2);
    let writes = await page.evaluate(() => mergeWrites);
    assert.equal(writes[0].id, 'merge-person');
    assert.equal(writes[0].body.job_title, undefined);
    assert.equal(writes[0].body.email, undefined);
    assert.equal(writes[0].body.notes, undefined);
    assert.deepEqual(writes[0].body.tags, ['old', 'new']);
    assert.equal(writes[0].body.contact_type, 'Cliente; Parceiro');
    assert.deepEqual(writes[1].links.relatedIds, ['old-company', 'new-company']);

    await page.evaluate(() => { mergeWrites = []; openMergeTest(); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#save').click();
    await page.locator('[data-contact-merge-field="job_title"]').check();
    assert.equal(await page.locator('[data-contact-merge-preview="job_title"]').textContent(), 'Director');
    await page.screenshot({ path: path.join(os.tmpdir(), 'audit-contact-review-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 390, height: 520 });
    const confirmButton = await page.locator('#contact-merge-confirm').boundingBox();
    const navigation = await page.locator('#mobile-navigation').boundingBox();
    assert.ok(confirmButton.y >= 0 && confirmButton.y + confirmButton.height <= navigation.y);
    await page.locator('#contact-merge-confirm').click();
    await page.waitForFunction(() => mergeWrites.length === 2);
    writes = await page.evaluate(() => mergeWrites);
    assert.equal(writes[0].body.job_title, 'Director');
    await page.evaluate(() => {
      mergeWrites = [];
      const permission = requireCurrentUserPermission;
      window.restoreTestPermissions = () => { requireCurrentUserPermission = permission; };
      requireCurrentUserPermission = (module, action, label) => action !== 'edit' && permission(module, action, label);
      openMergeTest();
    });
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.equal(await page.evaluate(() => mergeWrites.length), 0);
    assert.equal(await page.locator('#contact-merge-confirm').count(), 0);
    await page.evaluate(() => restoreTestPermissions());
    assert.deepEqual(errors, []);
    console.log('Audit safety checks passed: historical revenue, zero totals, manual schedules, pipelines and reviewed contact merge (desktop/mobile).');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
