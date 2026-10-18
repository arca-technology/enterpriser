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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://mobile-table.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://mobile-table.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true; currentProfile = { id: 'mobile-admin', role: 'admin', status: 'active' };
      const project = cache.projects[0];
      window.mobileProjectId = project.id;
      saveProductActivities([{ id: 'model-task', product_id: project.product_id, activity: 'Importar extrato', category: 'Banco', channel: 'ITAU', module: 'Financeiro' }]);
      saveProductGoals([{ id: 'model-goal', product_id: project.product_id, name: 'Primeira venda', category: 'Canais de venda', channel: 'AMAZON', metric: 'Pedidos', target_value: 1 }]);
      saveProductObjectives([{ id: 'model-objective', product_id: project.product_id, name: 'Conta ativa', category: 'Canais de venda', channel: 'MERCADO LIVRE' }]);
      saveProjectTasks([{ id: 'execution-task', project_id: project.id, title: 'Importar extrato', status: 'todo' }]);
      saveDeliveryGoals([{ id: 'execution-goal', project_id: project.id, name: 'Primeira venda', category: 'Canais de venda', channel: 'AMAZON', status: 'todo', metric: 'Pedidos', target_value: 1 }]);
      saveDeliveryObjectives([{ id: 'execution-objective', project_id: project.id, name: 'Conta ativa', category: 'Canais de venda', channel: 'MERCADO LIVRE', status: 'todo' }]);
      window.mobileSnapshot = JSON.stringify([loadProductActivities(), loadProductGoals(), loadProductObjectives(), loadProjectTasks(), loadDeliveryGoals(), loadDeliveryObjectives()]);
      // A stale body class must no longer override the selected view.
      document.body.classList.add('light', 'mobile-list-mode'); render();
    });
    const checkView = async (table, view, label) => {
      assert.equal(await table.count(), 1, label);
      const layout = await table.evaluate((element, view) => {
        const first = element.querySelector('tbody tr[data-id],tbody tr.mobile-record-row');
        let scroller = element.parentElement;
        while (scroller && !(scroller.scrollWidth > scroller.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowX))) scroller = scroller.parentElement;
        if (scroller && view === 'table') scroller.scrollLeft = 120;
        return { display: getComputedStyle(element).display, header: getComputedStyle(element.tHead).display,
          row: first && getComputedStyle(first).display,
          cells: first && [...first.cells].filter(cell => getComputedStyle(cell).display === 'table-cell').length,
          cellDisplays: first && [...first.cells].map(cell => [cell.textContent.slice(0, 40), getComputedStyle(cell).display, cell.className, cell.getAttribute('style'), cell.hidden]),
          scroll: scroller?.scrollLeft || 0,
          controls: element.parentElement.querySelectorAll(':scope>.list-view-controls').length };
      }, view);
      if (view === 'table') {
        assert.equal(layout.display, 'table', `${label}: real table layout`);
        assert.equal(layout.header, 'table-header-group', `${label}: column headers visible`);
        assert.equal(layout.row, 'table-row', `${label}: records remain rows`);
        assert.ok(layout.cells >= 2, `${label}: multiple columns visible: ${JSON.stringify(layout)}`);
        assert.ok(layout.scroll > 0, `${label}: table scrolls horizontally inside its container`);
        assert.equal(layout.controls, 0);
        for (const cell of await table.locator('.select-head,.expand-head').all()) assert.equal(await cell.isVisible(), true, `${label}: selection and expansion columns remain available`);
      } else {
        assert.equal(layout.header, 'none', `${label}: List hides table headers`);
        assert.equal(layout.row, 'grid', `${label}: List shows cards`);
        assert.equal(layout.controls, 1, `${label}: List has sorting/filter controls`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: no page overflow`);
    };
    const choose = async (trigger, panel, view) => {
      await page.locator(trigger).click(); await page.locator(`${panel} [data-view="${view}"]`).click();
    };
    for (const navigation of ['top', 'sidebar']) {
      await page.evaluate(mode => saveNavigationPreference({ mode }), navigation);
      for (const section of ['activities', 'goals', 'objectives']) {
        await page.locator(`#tabs [data-tab="${section}"]`).evaluate(button => button.click());
        if (await page.evaluate(() => mainPmCatalogActive())) await page.locator('#main [data-pm-mode]').click();
        for (const view of ['table', 'list', 'table']) {
          await choose('#view-menu-btn', '#view-dd', view);
          for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await checkView(page.locator('#main table'), view, `${navigation}/${section}/execution/${width}/${view}`);
          }
          if (navigation === 'top' && section === 'objectives') {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator('#main .table-scroll').evaluate(element => { element.scrollLeft = 0; });
            await page.screenshot({ path: path.join(os.tmpdir(), `mobile-real-${view}.png`) });
          }
        }
        await page.locator('#pm-mode-button').click();
        for (const view of ['table', 'list']) {
          await choose('#registration-view-menu-btn', '#registration-view-dd', view);
          await checkView(page.locator('#main table'), view, `${navigation}/${section}/catalog/${view}`);
        }
      }
      await page.evaluate(() => openProductActivities(cache.projects[0].product_id));
      for (const section of ['activities', 'goals', 'objectives']) {
        await page.locator(`[data-product-tab="${section}"]`).evaluate(button => button.click());
        for (const view of ['table', 'list']) {
          await choose('.product-view-menu-btn', '#product-view-dd', view);
          await checkView(page.locator('#product-activities-root table'), view, `${navigation}/${section}/product/${view}`);
        }
      }
      await page.evaluate(() => { closeModal(); openProjectBoard(mobileProjectId); });
      for (const section of ['activities', 'goals', 'objectives']) {
        await page.locator(`[data-project-section="${section}"]`).evaluate(button => button.click());
        for (const view of ['table', 'list']) {
          await choose('#project-view-menu-btn', '#project-view-dd', view);
          await checkView(page.locator('#project-board-root table'), view, `${navigation}/${section}/delivery/${view}`);
        }
      }
      await page.evaluate(() => closeModal());
    }
    assert.equal(await page.evaluate(() => JSON.stringify([loadProductActivities(), loadProductGoals(), loadProductObjectives(), loadProjectTasks(), loadDeliveryGoals(), loadDeliveryObjectives()]) === mobileSnapshot), true);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Mobile Table/List passed: real headers, rows, columns, contained horizontal scrolling, distinct List cards, repeated switches, all three PM modules in execution/catalog/product/delivery, top/sidebar, 320/390px and unchanged data.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
