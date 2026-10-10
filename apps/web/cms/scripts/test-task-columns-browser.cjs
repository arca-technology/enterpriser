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
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://task-test.local/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://task-test.local/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll();
      document.getElementById('boot-gate')?.remove();
      hideLogin();
      const project = cache.projects[0];
      saveProductActivities([{ id: 'column-template', product_id: project.product_id, title: 'Teste de uma tarefa com nome comprido para conferir quebra de linha', status: 'todo' }]);
      saveProjectTasks([{ id: 'column-task', project_id: project.id, title: 'Teste de uma tarefa com nome comprido para conferir quebra de linha', status: 'todo', required_setup: [], target_days: 7 }]);
      refreshActivityCache();
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const scope of ['main', 'registration', 'delivery']) {
        await page.evaluate((scope) => {
          document.querySelectorAll('.overlay,.cols-dd').forEach((item) => item.remove());
          if (scope === 'main') { state.tab = 'activities'; state.sortK = null; renderTable(cache); }
          else if (scope === 'registration') openRegistrationsModal('activities');
          else {
            projectBoardState.projectId = cache.projects[0].id;
            projectBoardState.section = 'activities';
            document.getElementById('main').innerHTML = renderTaskTable(projectTasks(projectBoardState.projectId));
            wireProjectTableColumns(document.querySelector('#main table'));
          }
        }, scope);
        const table = scope === 'registration' ? '#registrations-root table' : '#main table';
        const result = await page.locator(table).evaluate((table) => ({
          labels: [...table.querySelectorAll('thead th.task-frozen-column')].filter((cell) => !cell.hidden).map((cell) => (cell.dataset.registrationLabel || cell.dataset.projectLabel || cell.textContent).trim().toUpperCase()),
          columns: [...table.querySelectorAll('thead th.task-frozen-column')].filter((cell) => !cell.hidden).map((cell) => ({ label: (cell.dataset.registrationLabel || cell.dataset.projectLabel || cell.textContent).trim().toUpperCase(), width: cell.getBoundingClientRect().width, shadow: getComputedStyle(cell).boxShadow })),
          statusOverflow: [...table.querySelectorAll('.inline-task-status,.project-inline-task-status')].some((select) => select.getBoundingClientRect().width > select.parentElement.getBoundingClientRect().width)
        }));
        assert.deepEqual(result.labels, scope === 'registration' ? ['PRODUTO', 'TAREFA', 'STATUS'] : ['CLIENTE', 'PRODUTO', 'TAREFA', 'STATUS']);
        for (const column of result.columns) {
          assert(Math.abs(column.width - { CLIENTE: 105, PRODUTO: 70, TAREFA: 240, STATUS: 97.5 }[column.label]) < 1, `${scope}: ${column.label} width ${column.width}`);
          assert.equal(column.shadow, 'none');
        }
        assert.equal(result.statusOverflow, false);
        await page.evaluate((scope) => {
          if (scope === 'main') openColumnManager();
          else if (scope === 'registration') openRegistrationColumnManager(document.querySelector('#registrations-root table'));
          else openSecondaryColumnManager({ scope: 'delivery:activities', label: 'Tarefas', definitions: projectTableDefinitions(document.querySelector('#main table')), onChange: () => applyProjectTableColumnPreferences(document.querySelector('#main table')) });
        }, scope);
        await page.locator('.task-column-preset').selectOption('resumo');
        assert.equal(await page.locator('.column-manager-row.locked').count(), scope === 'registration' ? 3 : 4);
        await page.locator('.column-manager-close').click();
        await page.screenshot({ path: path.join(require('node:os').tmpdir(), `task-columns-${scope}-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log('All three task tables: reduced widths, no frozen shadow, status controls and presets passed at desktop/mobile widths.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
