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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], writes = [], nativeDialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); dialog.dismiss(); });
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://product-fixes.localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://product-fixes.localhost/'); await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true; currentProfile = { id: 'admin-test', role: 'admin', status: 'active' };
      cache.projects = []; cache.projectById = {}; saveProjectTasks([]); saveDeliveryGoals([]); saveDeliveryObjectives([]);
      saveProductActivities([
        { id: 'certificate', product_id: 'pr1', template_group_id: 'cert-group', activity: 'Certificado digital A1', category: 'Empresa' },
        { id: 'configure', product_id: 'pr1', template_group_id: 'configure-group', activity: 'Configurar conta', dependency_template_ids: ['certificate'], depends_on_template_id: 'certificate' }
      ]);
      saveProductGoals([{ id: 'goal', product_id: 'pr1', template_group_id: 'goal-group', name: 'Conta configurada', metric: 'Contas', target_value: 1, dependency_activity_template_ids: ['configure'] }]);
      saveProductObjectives([{ id: 'objective', product_id: 'pr1', template_group_id: 'objective-group', name: 'CONTA ATIVA', category: 'Canais de venda', channel: 'AMAZON', dependency_activity_template_ids: ['certificate'], dependency_goal_template_ids: ['goal'] }]);
      window.beforeSources = JSON.stringify([loadProductActivities(), loadProductGoals(), loadProductObjectives()]);
      saveNavigationPreference({ mode: 'sidebar' }); state.tab = 'contacts'; render(); openProductActivities('pr2');
    });
    await page.waitForFunction(() => document.body.classList.contains('sidebar-product-open'));
    assert.equal(await page.locator('.sidebar-module>h3').isVisible(), false);
    const layout = await page.evaluate(() => ({ x: document.querySelector('#ov').getBoundingClientRect().x,
      side: document.querySelector('#app-sidebar').getBoundingClientRect().right,
      toolbar: document.querySelector('.product-workspace-toolbar').getBoundingClientRect().top,
      workspace: document.querySelector('#ov').getBoundingClientRect().top,
      enabled: [...document.querySelectorAll('#app-sidebar .tab:not(:disabled)')].map(button => button.dataset.tab) }));
    assert.equal(layout.x, layout.side); assert.equal(layout.toolbar, layout.workspace);
    assert.deepEqual(layout.enabled, ['objectives', 'goals', 'activities']);
    await page.locator('#tabs [data-tab="objectives"]').click();
    assert.equal(await page.evaluate(() => productActivityState.tab), 'objectives');
    assert.equal(await page.locator('#tabs [data-tab="objectives"]').evaluate(button => button.classList.contains('active')), true);
    await page.locator('#po-ready').click(); await page.locator('#ready-result-list input[value="objective"]').check();
    await page.locator('#ready-result-add').click(); await page.waitForSelector('#ready-result-add', { state: 'detached' });
    const graph = await page.evaluate(() => {
      const objective = loadProductObjectives().find(row => row.product_id === 'pr2');
      const tasks = loadProductActivities().filter(row => row.product_id === 'pr2');
      const goal = loadProductGoals().find(row => row.product_id === 'pr2');
      const certificate = tasks.find(row => row.activity === 'Certificado digital A1'), configure = tasks.find(row => row.activity === 'Configurar conta');
      return { taskCount: tasks.length, rootTask: objective.dependency_activity_template_ids, certificate: certificate.id,
        goal: objective.dependency_goal_template_ids, goalId: goal.id, prerequisite: goal.dependency_activity_template_ids, configure: configure.id,
        configureDependencies: configure.dependency_template_ids, sourcesUnchanged: JSON.stringify([loadProductActivities().filter(row => row.product_id === 'pr1'),loadProductGoals().filter(row => row.product_id === 'pr1'),loadProductObjectives().filter(row => row.product_id === 'pr1')]) === beforeSources };
    });
    assert.equal(graph.taskCount, 2); assert.deepEqual(graph.rootTask, [graph.certificate]); assert.deepEqual(graph.goal, [graph.goalId]);
    assert.deepEqual(graph.prerequisite, [graph.configure]); assert.deepEqual(graph.configureDependencies, [graph.certificate]); assert.equal(graph.sourcesUnchanged, true);
    await page.locator('#tabs [data-tab="goals"]').click(); await page.locator('#pg-new').click();
    await page.locator('#pg-name').fill('Rascunho preservado'); await page.locator('#pg-cancel').click();
    assert.equal(await page.locator('.ui-confirm-dialog').isVisible(), true);
    assert.equal(await page.locator('#ui-confirm-cancel').evaluate(button => button === document.activeElement), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'product-confirm-internal-desktop.png') });
    await page.locator('#ui-confirm-cancel').click(); assert.equal(await page.locator('#pg-name').inputValue(), 'Rascunho preservado');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ui-confirm-dialog').count(), 0); assert.equal(await page.locator('#pg-name').inputValue(), 'Rascunho preservado');
    await page.locator('#pg-cancel').click(); await page.locator('#ui-confirm-accept').click();
    await page.waitForSelector('#pg-name', { state: 'detached' });
    assert.equal(await page.locator('#app-sidebar').evaluate(element => Boolean(element.closest('[inert]'))), false);
    await page.locator('#tabs [data-tab="activities"]').click();
    assert.equal(await page.evaluate(() => productActivityState.tab), 'activities');
    await page.screenshot({ path: path.join(os.tmpdir(), 'product-sidebar-no-header.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-navigation [data-mobile-tab="goals"]').click();
    assert.equal(await page.evaluate(() => productActivityState.tab), 'goals');
    assert.equal(await page.locator('#mobile-navigation [data-mobile-tab="goals"]').getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.product-workspace-back').click();
    assert.equal(await page.locator('#registrations-root').count(), 1);
    assert.equal(await page.locator('#tabs [data-tab="contacts"]').isEnabled(), true);
    await page.evaluate(() => { closeModal(); saveNavigationPreference({ mode: 'top' }); openProductActivities('pr2'); });
    assert.equal(await page.locator('#ov .modal>h3').isVisible(), true);
    assert.equal(await page.locator('.modal-header-tabs [data-product-tab]').count(), 3);
    assert.equal(await page.locator('.product-workspace-back').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-product-tab="objectives"]').click(); await page.locator('#po-new').click();
    await page.locator('#po-name').fill('Rascunho mobile'); await page.locator('#po-cancel').click();
    assert.equal(await page.locator('.ui-confirm-dialog').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'product-confirm-internal-mobile.png') });
    await page.locator('#ui-confirm-cancel').click();
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(nativeDialogs, []);
    console.log('Product fixes passed: automatic prerequisite graph, shared dependency reuse, untouched sources, sidebar-only navigation, header alignment, return navigation and internal discard dialog with focus/cancel/Escape/mobile.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
