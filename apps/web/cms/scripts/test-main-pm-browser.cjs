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
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://pm-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://pm-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      window.pmTestAdmin = true;
      currentUserIsAdmin = () => pmTestAdmin;
      currentProfile = { id: 'test-profile', status: 'active', role: 'collaborator', permissions: defaultUserPermissions() };
      render();
    });
    assert.deepEqual(await page.locator('#tabs .nav-label').allTextContents(), ['Pessoas', 'Empresas', 'Interações', 'Negócios', 'Entregas', 'Tarefas', 'Metas', 'Objetivos']);
    assert.equal(await page.locator('#tabs .nav-module-divider').count(), 1);
    await page.evaluate(() => openRegistrationsModal());
    assert.deepEqual(await page.locator('[data-registration-tab]').allTextContents(), ['Produtos', 'Pipeline', 'Usuários']);
    await page.evaluate(() => closeModal());
    await page.locator('#tabs [data-tab="activities"]').click();
    await page.locator('#new').click();
    assert.equal(await page.locator('#task-delivery-picker').count(), 0);
    assert.equal(await page.locator('#pa-activity').count(), 1);
    assert.equal(await page.locator('.activity-form-drawer input[readonly]').inputValue(), 'Projeto');
    await page.locator('#pa-activity').fill('Modelo de projeto principal');
    await page.locator('#pa-save').click();
    await page.waitForFunction(() => !document.getElementById('pa-save'));
    assert.equal(await page.evaluate(() => loadProductActivities().some((item) => item.activity === 'Modelo de projeto principal' && item.product_id === 'pr1')), true);
    await page.waitForFunction(() => loadProjectTasks().some((item) => item.source_template_id));
    assert.equal(await page.locator('#main #registrations-root table').count(), 1);
    await page.evaluate(() => {
      const item = loadProductActivities().find((item) => item.activity === 'Modelo de projeto principal');
      openRegistrationTemplateEditor('activities', item.product_id, item.id);
    });
    assert.equal(await page.locator('#pa-activity').inputValue(), 'Modelo de projeto principal');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { registrationTableState().view = 'mindmap'; renderRegistrationsSection(); });
    assert.equal(await page.locator('#main .registration-toolbar-title').innerText(), 'Tarefas');
    assert.ok(await page.locator('#main').innerText().then((text) => text.includes('Modelo de projeto principal')));
    await page.evaluate(() => { registrationTableState().view = 'table'; renderRegistrationsSection(); });
    await page.locator('[data-pm-scope="deliveries"]').click();
    assert.equal(await page.locator('#main .data-table[data-tab="activities"]').count(), 1);
    for (const [section, prefix] of [['goals', 'pg'], ['objectives', 'po']]) {
      await page.locator(`#tabs [data-tab="${section}"]`).click();
      await page.locator('#new').click();
      assert.equal(await page.locator('#task-delivery-picker').count(), 0);
      assert.equal(await page.locator('#registration-product-picker').count(), 0);
      await page.locator(`#${prefix}-name`).fill(`Cadastro principal ${section}`);
      await page.locator(`#${prefix}-product`).selectOption('pr2');
      assert.equal(await page.locator(`#${prefix}-name`).inputValue(), `Cadastro principal ${section}`);
      if (section === 'goals') { await page.locator('#pg-metric').fill('Pedidos'); await page.locator('#pg-target').fill('10'); }
      await page.locator(`#${prefix}-target-days`).fill('7');
      await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction((prefix) => !document.getElementById(`${prefix}-save`), prefix);
      await page.waitForFunction((section) => (section === 'goals' ? loadDeliveryGoals() : loadDeliveryObjectives()).some((item) => item.name === `Cadastro principal ${section}`), section);
      assert.equal(await page.evaluate((section) => (section === 'goals' ? loadProductGoals() : loadProductObjectives()).find((item) => item.name === `Cadastro principal ${section}`).product_id, section), 'pr2');
      await page.locator('[data-pm-scope="deliveries"]').click();
      assert.equal(await page.locator('#main .record-primary-cell').count(), 1);
      await page.locator('#main .record-primary-cell').click();
      assert.equal(await page.evaluate(() => projectBoardState.section), section);
      assert.equal(await page.evaluate(() => projectBoardState.projectId), 'pj2');
      await page.evaluate(() => closeModal());
      for (const view of ['calendar', 'gantt', 'schedule']) {
        await page.evaluate((view) => { state.view = view; render(); }, view);
        assert.equal(await page.locator('#main').innerText().then((text) => text.includes('undefined')), false);
      }
      await page.evaluate(() => { state.view = 'table'; render(); });
    }
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => saveNavigationPreference({ mode: 'top' }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.evaluate(() => saveNavigationPreference({ mode: 'sidebar' }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (width >= 768) {
        assert.equal(await page.locator('#app-sidebar #tabs .nav-icon svg').count(), 8);
        assert.deepEqual(await page.evaluate(() => sidebarSubmodules('registrations').map((item) => item.id)), ['products', 'pipelines', 'users']);
        await page.locator('#new:visible,#registration-add:visible').click();
        assert.equal(await page.locator('.activity-form-drawer').evaluate((el) => el.getBoundingClientRect().left), 64);
        await page.keyboard.press('Escape');
      } else {
        await page.locator('#mobile-more').click();
        assert.equal(await page.locator('#mobile-navigation-menu').getByRole('button', { name: 'Metas', exact: true }).count(), 1);
        await page.locator('#mobile-navigation-menu').getByRole('button', { name: 'Tarefas', exact: true }).click();
        await page.locator('#new').click();
        await page.locator('#pa-activity').waitFor();
        const nav = await page.locator('#mobile-navigation').boundingBox();
        const save = await page.locator('#pa-save').boundingBox();
        assert.ok(save && save.y + save.height <= nav.y);
        const close = await page.locator('#pa-close').boundingBox();
        assert.ok(close && close.x >= width - 60);
        await page.waitForFunction(() => !document.querySelector('#toast .toast'));
        await page.screenshot({ path: path.join(os.tmpdir(), 'pm-admin-mobile.png') });
        await page.keyboard.press('Escape');
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { pmTestAdmin = false; state.pmScopes = {}; state.tab = 'activities'; render(); });
    assert.equal(await page.locator('#pm-scope').isVisible(), false);
    assert.equal(await page.locator('#tabs [data-tab="goals"]').isVisible(), true);
    await page.locator('#new').click();
    assert.equal(await page.locator('#task-delivery-picker').isVisible(), true);
    await page.locator('#task-delivery-picker').selectOption('pj1');
    await page.locator('#task-delivery-next').click();
    await page.locator('#project-task-title').fill('Tarefa dia a dia do funcionario');
    await page.locator('#project-task-save').click();
    await page.waitForFunction(() => !document.getElementById('project-task-save'));
    assert.equal(await page.evaluate(() => { const task = loadProjectTasks().find((item) => item.title === 'Tarefa dia a dia do funcionario'); return task.project_id === 'pj1' && !task.source_template_id && task.status === 'todo'; }), true);
    await page.evaluate(() => { closeModal(); state.tab = 'activities'; render(); });
    assert.equal(await page.locator('#main table').innerText().then((text) => text.includes('Dia a dia')), true);
    await page.locator('#tabs [data-tab="goals"]').click();
    assert.equal(await page.locator('#new').isDisabled(), true);
    await page.evaluate(() => { currentProfile.permissions.projects.view = false; currentProfile.permissions.activities.view = false; render(); });
    assert.equal(await page.locator('#tabs [data-tab="goals"]').isVisible(), false);
    assert.equal(await page.locator('#tabs [data-tab="objectives"]').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Main PM modules passed: navigation, single catalog, admin creation, product bindings, delivery sync, employee daily tasks, permissions and mobile actions.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
