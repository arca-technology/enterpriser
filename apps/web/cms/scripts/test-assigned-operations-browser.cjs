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
    await page.route('**/*', (route) => route.request().url() === 'http://assigned-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://assigned-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentProfile = { id: 'me', auth_user_id: 'auth-me', full_name: 'Ulisses', email: 'ulisses.ferreira@ecommerce365.com.br', role: 'collaborator', status: 'active', permissions: defaultUserPermissions() };
      cache.users.push(currentProfile); cache.userById.me = currentProfile;
      cache.activityRecords = Array.from({ length: 60 }, (_, i) => ({ id: `own-${i}`, title: `My task ${i}`, owner_id: 'me', assignee_ids: ['me'], project_id: 'pj1', status: i === 0 ? 'done' : 'todo', planned_start_date: '2026-10-01', planned_end_date: '2026-10-20', recurrence: 'once', checklist: [], sort_order: i, schedule_manual: true }));
      cache.activityRecords[1].dependency_ids = ['prerequisite'];
      cache.activityRecords.push({ id: 'prerequisite', title: 'Other prerequisite', owner_id: 'other', project_id: 'pj1', status: 'todo', checklist: [{ id: 'check', text: 'Read only', checked: false }] }, { id: 'unrelated', title: 'Hidden task', owner_id: 'other', project_id: 'pj1', status: 'todo' });
      cache.deliveryGoals = [{ id: 'own-goal', name: 'Own goal', owner_id: 'me', project_id: 'pj1', status: 'todo', current_value: 0, target_value: 10, metric: 'Orders' }, { id: 'other-goal', name: 'Other goal', owner_id: 'other', project_id: 'pj1', status: 'todo', current_value: 0, target_value: 10, metric: 'Orders' }];
      cache.deliveryObjectives = [{ id: 'own-objective', name: 'Own objective', owner_id: 'me', project_id: 'pj1', status: 'todo' }, { id: 'other-objective', name: 'Other objective', owner_id: 'other', project_id: 'pj1', status: 'todo' }];
      window.CRM_CONFIG = { url: 'https://fixture.localhost', anonKey: 'fixture-public' };
      storeAuthSession({ user: { id: 'auth-me' }, access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
      workspaceIdentity.task_date_migration_enabled = true;
      window.testWrites = [];
      api = async (resource, options = {}) => {
        if (options.method === 'PATCH') {
          const id = new URLSearchParams(resource.split('?')[1]).get('id')?.slice(3);
          const body = JSON.parse(options.body);
          testWrites.push({ id, body });
          const row = cache.activityRecords.find((item) => item.id === id);
          return [{ ...row, ...body, delivery_id: row?.project_id }];
        }
        return [];
      };
      refreshActivityCache(); state.tab = 'activities'; render();
    });
    const ids = await page.evaluate(() => operationalProjectTasks().map((task) => task.id));
    assert(ids.includes('prerequisite')); assert(!ids.includes('unrelated')); assert.equal(ids.length, 61);
    assert.equal(await page.evaluate(() => updateProjectTask('prerequisite', { status: 'doing' })), false);
    await page.evaluate(() => openActivityChecklist('prerequisite'));
    assert.equal(await page.locator('.activity-check-toggle').isEnabled(), false);
    assert.equal(await page.locator('#activity-check-add').count(), 0);
    await page.evaluate(() => { closeModal(); openProjectBoard('pj1'); projectBoardState.section = 'activities'; projectBoardState.view = 'table'; projectBoardState.page = 2; renderProjectBoard('pj1'); });
    await page.evaluate(() => openDeliveryTaskDrawer('pj1', 'own-0'));
    assert.equal(await page.locator('#project-task-planned-end').isEnabled(), true);
    await page.locator('#project-task-planned-end').fill('2026-10-25');
    await page.locator('#project-task-actual-end').fill('2026-10-13');
    await page.locator('#project-task-save').click();
    await page.waitForFunction(() => !document.getElementById('project-task-save'));
    assert.equal(await page.evaluate(() => projectBoardState.page), 2);
    const saved = await page.evaluate(() => cache.activityRecords.find((task) => task.id === 'own-0'));
    assert.equal(saved.planned_end_date, '2026-10-25'); assert.equal(saved.actual_end_date, '2026-10-13'); assert.equal(saved.status, 'done'); assert.equal(saved.schedule_manual, true);
    await page.evaluate(() => { closeModal(); state.pages.activities = 2; render(); });
    await page.evaluate(() => openDeliveryTaskDrawer('pj1', 'own-0'));
    assert.equal(await page.locator('#project-task-save').count(), 1, 'Main-list editing mounts the drawer');
    await page.locator('#project-task-save').click();
    await page.waitForFunction(() => !document.getElementById('project-task-save'));
    await page.evaluate(() => { closeModal(); render(); });
    assert.equal(await page.evaluate(() => state.pages.activities), 2, 'Main task-list pagination is retained');
    await page.evaluate(() => { openProjectBoard('pj1'); projectBoardState.section = 'activities'; projectBoardState.view = 'table'; renderProjectBoard('pj1'); });
    await page.evaluate(() => { workspaceIdentity.task_date_migration_enabled = false; openDeliveryTaskDrawer('pj1', 'own-0'); });
    for (const suffix of ['planned-start', 'planned-end', 'actual-start', 'actual-end']) assert.equal(await page.locator(`#project-task-${suffix}`).isEnabled(), false);
    await page.locator('#project-task-cancel').click();
    for (const [section, prefix] of [['goals', 'goal'], ['objectives', 'objective']]) {
      await page.evaluate((section) => { projectBoardState.section = section; projectBoardState.page = 1; renderProjectBoard('pj1'); }, section);
      assert.equal(await page.locator(`[data-${prefix}-id]`).count(), 2);
      assert.equal(await page.locator(`[data-${prefix}-id="other-${prefix}"] select`).isEnabled(), false);
      assert.equal(await page.locator(`[data-${prefix}-id="own-${prefix}"] select`).isEnabled(), true);
      assert.equal(await page.evaluate((prefix) => prefix === 'goal' ? updateDeliveryGoal('other-goal', { current_value: 5 }) : updateDeliveryObjective('other-objective', { status: 'doing' }), prefix), false);
    }
    await page.evaluate(() => { closeModal(); render(); });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => openAccountSwitcher());
      assert.equal(await page.locator('#account-add-form').count(), 1);
      await page.waitForFunction(() => {
        const box = document.getElementById('account-add').getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      });
      const box = await page.locator('#account-add').boundingBox();
      await page.screenshot({ path: path.join(os.tmpdir(), `account-switcher-${width}.png`) });
      assert(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 844, `${width}: ${JSON.stringify(box)}`);
      await page.evaluate(() => closeModal());
    }
    assert.deepEqual(errors, []);
    console.log('Browser passed: collaborator task scope, read-only prerequisites, completed-task date correction, preserved pagination, date flag, result ownership, mobile/desktop account controls.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
