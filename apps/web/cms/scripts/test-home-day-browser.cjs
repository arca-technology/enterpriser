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
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', hasTouch: true });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (process.env.CMS_TEST_URL) {
      await page.route('**/legacy/app.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.CRM_CONFIG = {};\n${source}` }));
      await page.goto(`${process.env.CMS_TEST_URL}/cms`);
      await page.waitForFunction(() => typeof loadAll === 'function');
    } else {
      await page.route('**/*', (route) => route.request().url() === 'http://home-day.localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
      await page.goto('http://home-day.localhost/');
      await page.evaluate(() => { window.CRM_CONFIG = {}; });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
      await page.addScriptTag({ content: source });
    }
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      window.seedHome = () => {
        const today = isoDay(new Date());
        const me = cache.users[0].id;
        cache.users[0].full_name = 'Ulisses Ferreira'; cache.users[0].nickname = 'Ulisses'; cache.users[0].role = 'admin';
        currentProfile = cache.users[0];
        const companyId = cache.companies[0][pk('companies')];
        const productId = cache.products[0].id;
        const base = { ...cache.projects[0], status: 'active', owner_id: me, erp_platform: 'BLING', start_date: addDays(today, -60), end_date: addDays(today, 120), company_id: companyId, product_id: productId };
        cache.projects = [{ ...base, id: 'home-a', name: 'EC365 | JAD FONSECA | @START', client_name: 'JAD FONSECA' }, { ...base, id: 'home-b', name: 'CLIENTE B | @START', client_name: 'Cliente B' }, { ...base, id: 'home-closed', status: 'closed', client_name: 'Encerrado' }];
        cache.projectById = Object.fromEntries(cache.projects.map((row) => [row.id, row]));
        const task = (id, shift, extra = {}) => ({ id, title: `Tarefa ${id}`, project_id: 'home-a', status: 'todo', owner_id: me, assignee_ids: [me], due_date: shift == null ? null : addDays(today, shift), channel: 'BLING', module: 'Financeiro', recurrence: 'once', ...extra });
        saveProjectTasks([task('old-a', -100, { title: 'Importar OFX e fazer concilia\u00e7\u00e3o financeira', recurrence: 'monthly' }), task('old-b', -80, { title: 'Arrumar categorias financeiras', recurrence: 'monthly', project_id: 'home-b' }), task('late', -2, { title: 'Abrir conta' }), task('today', 0, { title: 'Conferir lan\u00e7amentos' }), task('future', 2), task('parent', -5), task('child', -1, { parent_activity_id: 'parent', title: 'Certificado Digital' }), task('done', -1, { status: 'done', actual_end_date: today }), task('closed', -100, { project_id: 'home-closed', recurrence: 'monthly' }), task('undated', null)]);
        saveDeliveryGoals([{ id: 'home-goal', project_id: 'home-a', name: 'Faturamento do Mercado Livre', current_value: 10, target_value: 100, comparison: 'at_least', status: 'todo', due_date: addDays(today, 30), unit: '%' }]);
        saveDeliveryObjectives([{ id: 'home-objective', project_id: 'home-a', name: 'Financeiro estruturado', status: 'todo', due_date: addDays(today, 15) }]);
        const pipeline = cache.pipelines[0];
        cache.deals = [{ id: 'home-won', owner_id: me, status: 'won', amount: 1500, title: 'Produto ganho' }, { id: 'home-open', owner_id: me, status: 'open', amount: 1200, title: 'Produto aberto', pipeline_id: pipeline.id, stage: pipeline.stages[0] }];
        cache.conversations = [{ id: 'home-incoming', owner_id: me, contact_name: 'Pessoa Teste', messages: [{ author: 'Pessoa Teste', at: `${addDays(today, -4)}T10:00:00-03:00` }] }];
        homeDayState.scope = 'mine'; homeDayState.taskTab = 'late'; homeDayState.limit = 12; homeDayState.selected.clear();
        state.tab = 'home'; render();
      };
      seedHome(); setTheme(true); saveNavigationPreference({ mode: 'top' });
    });
    assert.match(await page.locator('.home-day h1').innerText(), /Ulisses/);
    assert.equal(await page.locator('.home-day-alert').count(), 4);
    assert.equal(await page.locator('.home-day-summary').count(), 4);
    assert.equal(await page.locator('.home-day-alert').first().locator('strong').innerText(), '4');
    assert.equal(await page.locator('[data-home-task="parent"]').count(), 0);
    assert.equal(await page.locator('[data-home-task="closed"]').count(), 0);
    await page.locator('.home-day-bottom').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.home-day-bottom [role="progressbar"]').count());
    await page.screenshot({ path: path.join(os.tmpdir(), 'home-day-bottom.png') });
    await page.locator('.home-day-heading').scrollIntoViewIfNeeded();
    const touch = await page.context().newCDPSession(page);
    for (const mode of ['top', 'sidebar']) {
      await page.evaluate((mode) => saveNavigationPreference({ mode }), mode);
      for (const width of [1920, 1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width < 600 ? 844 : 1080 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${mode} ${width}: document overflow`);
        const overflow = await page.locator('.home-day-panel,.home-day-alert,.home-day-summary,.home-day-task,.home-day-panel-head').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
        assert.deepEqual(overflow, [], `${mode} ${width}: internal overflow`);
        assert.equal(await page.locator('.home-help-button').isVisible(), true);
        if (width < 768) {
          assert.equal(await page.locator('#floating-log').isVisible(), false);
          await page.locator('#main').evaluate((main) => { main.scrollTop = 0; });
          assert.equal(await page.locator('#main').evaluate((main) => getComputedStyle(main).overflowY), 'auto');
          const bounds = await page.locator('#main').boundingBox();
          const x = bounds.x + 24, startY = bounds.y + bounds.height - 80;
          await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
          for (let y = startY - 20; y > bounds.y + 120; y -= 30) {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
          }
          await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.waitForFunction(() => document.getElementById('main').scrollTop > 100);
          await page.locator('#main').evaluate((main) => { main.scrollTop = main.scrollHeight; });
          assert.equal(await page.locator('.home-day-bottom').evaluate((bottom) => {
            const main = document.getElementById('main').getBoundingClientRect();
            return bottom.getBoundingClientRect().bottom <= main.bottom + 1;
          }), true, `${mode} ${width}: final Home section is reachable`);
          await page.screenshot({ path: path.join(os.tmpdir(), `home-scroll-bottom-${mode}-${width}.png`) });
          await page.locator('#main').evaluate((main) => { main.scrollTop = 0; });
          await page.locator('.home-help-button').click();
          assert.equal(await page.evaluate(() => helpContextId), 'home');
          await page.locator('#help-close').click();
        }
        await page.screenshot({ path: path.join(os.tmpdir(), `home-day-${mode}-${width}.png`), fullPage: false });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => setTheme(false));
    await page.screenshot({ path: path.join(os.tmpdir(), 'home-day-dark.png') });
    await page.evaluate(() => setTheme(true));
    await page.locator('[data-home-period="today"]').click();
    assert.equal(await page.locator('[data-home-task="today"]').count(), 1);
    assert.equal(await page.locator('[data-home-task="old-a"]').count(), 0);
    await page.locator('[data-home-period="today"]').press('ArrowLeft');
    assert.equal(await page.locator('[data-home-period="late"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-home-period="undated"]').click();
    assert.equal(await page.locator('[data-home-task="undated"]').count(), 1);
    await page.locator('[data-home-period="late"]').click();
    await page.locator('[data-home-task="late"]').click();
    assert.equal(await page.locator('#project-board-root').count(), 1);
    await page.locator('#project-task-drawer-overlay').waitFor();
    await page.locator('#project-task-close').click();
    await page.evaluate(() => closeModal());
    await page.locator('[data-home-action="goals"]').first().click();
    assert.equal(await page.evaluate(() => state.tab), 'goals');
    assert.equal(await page.evaluate(() => mainPmCatalogActive()), false);
    assert.deepEqual(await page.evaluate(() => rowsFor('goals', cache).map((row) => row.id)), ['home-goal']);
    await page.evaluate(() => { state.tab = 'home'; render(); });
    await page.locator('[data-home-select="old-a"]').check();
    assert.equal(await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'old-a').status), 'todo');
    await page.locator('[data-home-bulk="archive"]').click();
    await page.locator('#home-bulk-cancel').click();
    assert.equal(await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'old-a').status), 'todo');
    await page.locator('[data-home-bulk="reschedule"]').click();
    await page.locator('#home-bulk-date').fill('2000-01-01');
    await page.locator('#home-bulk-confirm').click();
    assert.match(await page.locator('#home-bulk-error').innerText(), /Escolha/);
    const date = await page.evaluate(() => addDays(isoDay(new Date()), 10));
    await page.locator('#home-bulk-date').fill(date);
    await page.locator('#home-bulk-confirm').click();
    await page.waitForFunction(() => !document.getElementById('home-bulk-confirm'));
    const rescheduled = await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'old-a'));
    assert.equal(rescheduled.due_date, date);
    assert.equal(rescheduled.planned_end_date, date);
    assert.equal(rescheduled.schedule_manual, true);
    assert.equal(rescheduled.deadline_window, 'date');
    assert.equal(rescheduled.recurrence, 'monthly');
    assert.equal(rescheduled.status, 'todo');
    await page.locator('[data-home-select="old-b"]').check();
    await page.locator('[data-home-bulk="archive"]').click();
    await page.locator('#home-bulk-confirm').click();
    await page.waitForFunction(() => !document.getElementById('home-bulk-confirm'));
    assert.equal(await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'old-b').status), 'canceled');
    assert.equal(await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'done').status), 'done');
    assert.equal(await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'closed').status), 'todo');
    assert.equal(await page.evaluate(() => loadProjectTasks().find((row) => row.id === 'future').status), 'todo');
    await page.locator('[data-home-scope="team"]').click();
    assert.equal(await page.evaluate(() => homeDayState.scope), 'team');
    assert.equal(await page.locator('.home-day-scope [aria-pressed="true"]').innerText(), 'Equipe');
    await page.evaluate(() => { homeNavigate('activities', []); });
    assert.equal(await page.evaluate(() => rowsFor('activities', cache).length), 0);
    await page.evaluate(() => {
      currentUserIsAdmin = () => false;
      currentUserCan = () => false;
      state.tab = 'home'; render();
    });
    assert.equal(await page.locator('[data-home-scope="team"]').count(), 0);
    assert.equal(await page.locator('.home-day-alert,.home-day-summary,.home-day-panel').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Home browser passed: responsive themes/navigation, real filters, task drawer, selection, confirmation, persisted scheduling, safe cancellation and permissions.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
