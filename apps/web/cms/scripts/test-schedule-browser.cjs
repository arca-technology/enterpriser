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
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (process.env.CMS_TEST_URL) {
      await page.route('**/legacy/app.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.CRM_CONFIG = {};\n${source}` }));
      await page.goto(`${process.env.CMS_TEST_URL}/cms`); await page.waitForFunction(() => typeof loadAll === 'function');
    } else {
      await page.route('**/*', (route) => route.request().url() === 'http://schedule.localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
      await page.goto('http://schedule.localhost/'); await page.evaluate(() => { window.CRM_CONFIG = {}; });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
      await page.addScriptTag({ content: source });
    }
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin(); setTheme(true);
      const base = { ...cache.projects[0], owner_id: cache.users[0].id, status: 'active', erp_platform: 'BLING' };
      cache.projects = [
        { ...base, id: 'spans', name: 'CLIENTE A | @START', client_name: 'CLIENTE A', start_date: '2026-07-01', end_date: '2026-12-31' },
        { ...base, id: 'october', name: 'CLIENTE B | @START', client_name: 'CLIENTE B', owner_id: cache.users[1].id, start_date: '2026-10-01', end_date: '2026-10-31' },
        { ...base, id: 'future', client_name: 'CLIENTE C', start_date: '2027-01-01', end_date: '2027-06-30' },
        { ...base, id: 'closed', client_name: 'CLIENTE D', status: 'closed', start_date: '2026-10-01', end_date: '2026-10-31' },
        { ...base, id: 'undated', client_name: 'SEM PRAZO', start_date: null, end_date: null },
      ];
      cache.projectById = Object.fromEntries(cache.projects.map((row) => [row.id, row]));
      saveProjectTasks([
        { id: 'month-task', project_id: 'spans', title: 'Mentoria mensal', recurrence: 'monthly', deadline_window: 'month', planned_start_date: '2026-10-01', due_date: '2026-10-31', status: 'todo', owner_id: cache.users[0].id, required_setup: [] },
        { id: 'week-task', project_id: 'spans', title: 'Concilia\u00e7\u00e3o na primeira semana', recurrence: 'monthly', deadline_window: 'week1', planned_start_date: '2026-10-01', due_date: '2026-10-07', status: 'doing', required_setup: [] },
      ]);
      saveDeliveryObjectives([{ id: 'objective', project_id: 'spans', name: 'Financeiro organizado', status: 'todo', due_date: '2026-10-20' }]);
      saveDeliveryGoals([{ id: 'goal', project_id: 'spans', name: 'Meta de faturamento', target_value: 100, current_value: 20, status: 'todo', due_date: '2026-10-31' }]);
      window.scheduleWrites = 0; updateRow = async () => { scheduleWrites += 1; throw new Error('Read-only view must not write'); };
      state.tab = 'projects'; state.view = 'schedule'; render();
      Object.assign(scheduleViewState('main:projects', 'projects'), { start: '2026-10-01', end: '2026-10-31', preset: 'custom' }); render();
    });
    assert.equal(await page.locator('.schedule-chart .schedule-record').count(), 3);
    assert.equal(await page.locator('.schedule-chart [data-schedule-open="spans"]').count(), 2);
    assert.equal(await page.locator('.schedule-chart [data-schedule-open="future"]').count(), 0);
    assert.doesNotMatch(await page.locator('.schedule-shell').innerText(), /undefined|NaN/);
    assert.match(await page.locator('.schedule-bar[data-schedule-open="spans"]').getAttribute('style'), /left:0%;width:100%/);
    await page.locator('[data-schedule-scale]').selectOption('months');
    assert.equal(await page.locator('.schedule-chart .schedule-record').count(), 3);
    await page.locator('[data-schedule-scale]').selectOption('days');
    await page.locator('.schedule-chart-scroll').evaluate((el) => { el.scrollLeft = 400; });
    const left = await page.locator('.schedule-timeline-row .schedule-sticky-label').first().boundingBox();
    const viewport = await page.locator('.schedule-chart-scroll').boundingBox();
    assert.ok(Math.abs(left.x - viewport.x) < 2, 'Labels stay at the chart edge during horizontal scrolling');
    await page.locator('[data-schedule-expand="spans"]').first().click();
    assert.equal(await page.locator('.schedule-chart .is-child').count(), 4);
    assert.equal(await page.locator('.schedule-bar[data-schedule-open="month-task"]').getAttribute('style'), 'left:0%;width:100%');
    const weekWidth = await page.locator('.schedule-bar[data-schedule-open="week-task"]').getAttribute('style');
    assert.match(weekWidth, /width:22\.5806/);
    await page.locator('[data-schedule-filters]').click();
    await page.locator('[data-schedule-client]').selectOption('CLIENTE B');
    assert.equal(await page.locator('.schedule-chart .schedule-record').count(), 1);
    await page.locator('[data-schedule-clear]').click();
    assert.equal(await page.locator('.schedule-chart .schedule-record:not(.is-child)').count() >= 4, true);
    await page.locator('[data-schedule-status]').selectOption('active');
    await page.locator('[data-schedule-undated]').uncheck();
    assert.equal(await page.locator('.schedule-chart .schedule-timeline-row:not(.is-child)').count(), 2);
    await page.locator('[data-schedule-owner]').selectOption(await page.evaluate(() => cache.users[1].id));
    assert.equal(await page.locator('.schedule-chart .schedule-timeline-row:not(.is-child)').count(), 1);
    await page.locator('[data-schedule-owner]').selectOption('');
    await page.locator('[data-schedule-filters]').click();
    await page.locator('[data-schedule-start]').fill('2026-11-01');
    assert.equal(await page.locator('.schedule-error').isVisible(), true);
    await page.locator('[data-schedule-end]').fill('2026-11-30');
    assert.equal(await page.locator('.schedule-chart .schedule-timeline-row:not(.is-child)').count(), 1);
    await page.locator('[data-schedule-move="-1"]').click();
    assert.equal(await page.locator('[data-schedule-start]').inputValue(), '2026-10-02');
    await page.locator('[data-schedule-preset]').selectOption('quarter');
    assert.equal(await page.locator('[data-schedule-start]').inputValue(), await page.evaluate(() => schedulePeriod('quarter', isoDay(new Date())).start));
    await page.locator('[data-schedule-today]').click();
    assert.equal(await page.locator('[data-schedule-start]').inputValue(), await page.evaluate(() => schedulePeriod('month', isoDay(new Date())).start));
    await page.evaluate(() => { const s = scheduleViewState('main:projects', 'projects'); Object.assign(s, { start: '2026-10-01', end: '2026-10-31', scale: 'weeks', preset: 'custom', undated: true }); render(); });
    for (const mode of ['top', 'sidebar']) {
      await page.evaluate((mode) => saveNavigationPreference({ mode }), mode);
      for (const width of [1920, 1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 960 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${mode} ${width}: document overflow`);
        assert.equal(await page.locator('.schedule-agenda').isVisible(), width < 768);
        assert.equal(await page.locator('.schedule-chart-scroll').isVisible(), width >= 768);
        await page.waitForFunction((presentation) => document.querySelector(`[data-schedule-presentation="${presentation}"]`)?.getAttribute('aria-pressed') === 'true', width < 768 ? 'agenda' : 'timeline');
        await page.screenshot({ path: path.join(os.tmpdir(), `schedule-${mode}-${width}.png`) });
      }
    }
    await page.locator('.schedule-agenda [data-schedule-expand="spans"]').click();
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.schedule-agenda'))), true);
    await page.locator('.schedule-agenda [data-schedule-expand="spans"]').click();
    await page.locator('[data-schedule-presentation="timeline"]').click();
    assert.equal(await page.locator('.schedule-chart-scroll').isVisible(), true);
    await page.locator('[data-schedule-presentation="agenda"]').click();
    await page.locator('.schedule-agenda [data-schedule-open="spans"]').first().click();
    assert.equal(await page.locator('#project-board-root').count(), 1);
    await page.evaluate(() => { projectBoardState.section = 'activities'; projectBoardState.view = 'schedule'; Object.assign(scheduleViewState('delivery:spans:activities'), { start: '2026-10-01', end: '2026-10-31' }); renderProjectBoard('spans'); });
    assert.equal(await page.locator('#project-board-root .schedule-shell').count(), 1);
    assert.equal(await page.locator('#project-board-root .schedule-agenda-row').count(), 2);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => setTheme(false));
    await page.screenshot({ path: path.join(os.tmpdir(), 'schedule-delivery-dark.png') });
    assert.equal(await page.evaluate(() => scheduleWrites), 0);
    assert.deepEqual(errors, []);
    console.log('Schedule browser passed: visible controls, inclusive periods, exact monthly windows, hierarchy, filters, frozen labels, mobile agenda, both navigation modes, delivery context and no data mutations.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
