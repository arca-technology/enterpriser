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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://onboarding-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://onboarding-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin(); render();
      currentProfile = { ...cache.users[0], role: 'admin', status: 'active' };
      localStorage.setItem('crm_cfg', JSON.stringify({ url: 'https://fixture-api.localhost', anonKey: 'public-fixture' }));
      const project = { ...cache.projects[0], id: 'existing-delivery', client_name: 'D ELUS', start_date: '2026-10-01', end_date: '2027-03-31' };
      window.existingDelivery = project;
      cache.projects = []; // The duplicate exists remotely but is absent from stale local cache.
      fetchTable = async name => name === 'projects' ? [project] : [];
      window.createdDeliveries = [];
      createRow = async (table, body) => { window.createdDeliveries.push({ table, body }); return { ...body, id: 'created-delivery' }; };
      init = ensureCompanyClientType = provisionDeliveryResources = async () => {};
      openProjectBoard = id => { window.openedDelivery = id; };
      window.showDuplicateForm = () => {
        const fields = ['client_name', 'company_id', 'product_id', 'start_date', 'end_date', 'status'];
        shell('Nova entrega', '<div class="form">'+fields.map(key => '<div class="field"><input data-k="'+key+'" value="'+esc(project[key] || '')+'"></div>').join('')+'</div><div class="modal-foot"><button class="btn primary" id="save">Salvar</button></div>');
        document.getElementById('save').onclick = () => saveForm('projects', null, fields.map(k => ({ k, label: k })));
      };
      showDuplicateForm();
    });
    await page.locator('#save').click();
    await page.locator('#delivery-duplicate-open').waitFor();
    assert.equal(await page.evaluate(() => window.createdDeliveries.length), 0);
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-delivery-duplicate-desktop.png') });
    await page.locator('#delivery-duplicate-cancel').click();
    assert.equal(await page.locator('#save').isEnabled(), true);
    await page.locator('#save').click();
    await page.locator('#delivery-duplicate-open').click();
    assert.equal(await page.evaluate(() => window.openedDelivery), 'existing-delivery');
    assert.equal(await page.evaluate(() => window.createdDeliveries.length), 0);
    await page.evaluate(() => showDuplicateForm());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#save').click();
    await page.locator('#delivery-duplicate-create').waitFor();
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-delivery-duplicate-mobile.png') });
    for (const id of ['cancel', 'create', 'open']) {
      const rect = await page.locator('#delivery-duplicate-'+id).boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 391 && rect.y + rect.height <= 844, id+': '+JSON.stringify(rect));
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-delivery-duplicate-mobile.png') });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-delivery-duplicate-small-mobile.png') });
    for (const id of ['cancel', 'create', 'open']) {
      const rect = await page.locator('#delivery-duplicate-'+id).boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 321 && rect.y + rect.height <= 740, id+': '+JSON.stringify(rect));
    }
    await page.locator('#delivery-duplicate-create').click();
    await page.waitForFunction(() => window.createdDeliveries.length === 1);
    assert.equal(await page.evaluate(() => window.createdDeliveries[0].table), 'projects');
    const migration = await page.evaluate(async () => {
      const project = existingDelivery;
      cache.projectById[project.id] = project;
      cache.productActivities = [{ id: 'template', product_id: project.product_id, activity: 'ONBOARDING', category: 'Projeto', type: 'Reunião', recurrence: 'once' }];
      const original = { id: 'persisted-task', project_id: project.id, title: 'ONBOARDING', source_template_id: 'template', status: 'done' };
      cache.activityRecords = [original];
      localStorage.setItem('crm_project_tasks', JSON.stringify([{ ...original, id: 'stale-id', source_template_id: 'obsolete-template', status: 'todo' }]));
      const writesBefore = createdDeliveries.length;
      await migrateLocalOperationalData();
      const replayWrites = createdDeliveries.length - writesBefore;
      cache.activityRecords = [];
      localStorage.setItem('crm_project_tasks', JSON.stringify([{ ...original, id: 'fresh-task', source_template_id: null }]));
      await migrateLocalOperationalData();
      return { replayWrites, backup: Boolean(localStorage.getItem('crm_project_tasks_migration_backup')),
        linked: cache.activityRecords[0].source_template_id, remaining: localStorage.getItem('crm_project_tasks') };
    });
    assert.equal(migration.replayWrites, 0);
    assert.equal(migration.backup, true);
    assert.equal(migration.linked, 'template');
    assert.equal(migration.remaining, null);
    assert.deepEqual(errors, []);
    console.log('Onboarding browser passed: fresh duplicate lookup, cancel/open/explicit separate creation, responsive dialog, stale migration rejection, snapshot and recovered template link.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
