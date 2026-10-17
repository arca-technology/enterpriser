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
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://result-columns.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://result-columns.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'column-admin', role: 'admin', status: 'active' };
      const item = { product_id: 'pr1', name: 'CONTA ATIVA', category: 'ERP', channel: 'BLING',
        module: 'Financeiro', submodule: 'Caixas e Bancos', metric: 'Pedidos', target_value: 1,
        completion_criteria: 'Conta pronta', comments: 'Detalhes preservados' };
      saveProductObjectives([{ ...item, id: 'objective' }]);
      saveProductGoals([{ ...item, id: 'goal' }]);
      saveDeliveryObjectives([{ ...item, id: 'do', project_id: 'delivery' }]);
      saveDeliveryGoals([{ ...item, id: 'dg', project_id: 'delivery' }]);
      saveProductActivities([]); saveProjectTasks([]); render();
    });
    for (const section of ['objectives', 'goals']) {
      // Old saved numeric keys must still hide the original field, not a new column.
      await page.evaluate(section => {
        secondaryColPrefs[`registrations:${section}`] = { c4: false, __order: Array.from({ length: 11 }, (_, i) => `c${i}`) };
        openMainPmCatalog(section);
      }, section);
      const registration = page.locator('#registrations-root table');
      const headers = await registration.locator('th[data-registration-key]').evaluateAll(nodes => nodes.map(node => ({ label: node.dataset.registrationLabel, key: node.dataset.registrationKey, hidden: node.hidden })));
      const channel = headers.findIndex(node => node.label === 'Canal');
      assert.deepEqual(headers.slice(channel + 1, channel + 3).map(node => [node.label, node.hidden]), [['Módulo', false], ['Submódulo', false]]);
      assert.equal(headers.find(node => node.key === 'c4').label, section === 'goals' ? 'Indicador' : 'Critério de conclusão');
      assert.equal(headers.find(node => node.key === 'c4').hidden, true);
      assert.equal(await registration.locator('td[data-registration-key="c_module"]').innerText(), 'Financeiro');
      assert.equal(await registration.locator('td[data-registration-key="c_submodule"]').innerText(), 'Caixas e Bancos');
      await page.locator('.registration-cols-btn').click();
      assert.equal(await page.locator('#cols-dd [data-k="c_module"] [role="switch"]').getAttribute('aria-checked'), 'true');
      await page.locator('#cols-dd [data-k="c_module"] [role="switch"]').click();
      assert.equal(await registration.locator('th[data-registration-key="c_module"]').evaluate(node => node.hidden), true);
      await page.locator('#cols-dd [data-k="c_module"] [role="switch"]').click();
      await page.locator('#cols-dd .column-manager-close').click();
      await page.evaluate(() => {
        registrationTableState().filters = { c_module: new Set(['Financeiro']) };
        applyRegistrationTableState(document.querySelector('#registrations-root table'));
      });
      assert.equal(await registration.locator('tbody tr[data-id]:not([hidden])').count(), 1);
      assert.deepEqual(await page.evaluate(section => registrationMindMapFilteredItems(document.getElementById('registrations-root'), section === 'goals' ? loadProductGoals() : loadProductObjectives(), section)[0].map(item => item.id), section), [section === 'goals' ? 'goal' : 'objective']);
      await page.screenshot({ path: path.join(os.tmpdir(), `${section}-visible-module-columns.png`) });
      await page.evaluate(section => {
        secondaryColPrefs[`product:pr1:${section}`] = { c1: false, __order: Array.from({ length: 7 }, (_, i) => `c${i}`) };
        openProductActivities('pr1'); productActivityState.tab = section; renderProductWorkspace();
      }, section);
      const product = page.locator('#product-activities-root table');
      assert.deepEqual(await product.locator('th[data-product-column]').evaluateAll(nodes => nodes.slice(1, 5).map(node => node.dataset.productLabel)), ['Categoria', 'Canal', 'Módulo', 'Submódulo']);
      assert.equal(await product.locator('th[data-product-column="c1"]').evaluate(node => node.hidden), true);
      assert.equal(await product.locator('td[data-product-column="c_module"]').innerText(), 'Financeiro');
      await page.locator('.product-cols-btn').click();
      assert.equal(await page.locator('#cols-dd [data-k="c_submodule"] [role="switch"]').getAttribute('aria-checked'), 'true');
      await page.locator('#cols-dd .column-manager-close').click();
      const delivery = await page.evaluate(section => {
        projectBoardState.section = section; projectBoardState.sortKey = null;
        secondaryColPrefs[`delivery:${section}`] = { d3: false, __order: Array.from({ length: 13 }, (_, i) => `d${i}`) };
        const host = document.createElement('div'); document.body.appendChild(host);
        host.innerHTML = section === 'goals' ? renderDeliveryGoals('delivery') : renderDeliveryObjectives('delivery', []);
        const table = host.querySelector('table'); wireProjectTableColumns(table);
        const headers = [...table.querySelectorAll('th[data-project-column]')];
        const channel = headers.findIndex(header => header.dataset.projectLabel === 'Canal');
        const row = table.querySelector('tbody tr');
        const item = section === 'goals' ? loadDeliveryGoals()[0] : loadDeliveryObjectives()[0];
        const result = {
          fields: headers.slice(channel + 1, channel + 3).map(header => [header.dataset.projectLabel, header.hidden]),
          original: headers.find(header => header.dataset.projectColumn === 'd3').dataset.projectLabel,
          hidden: headers.find(header => header.dataset.projectColumn === 'd3').hidden,
          value: row.querySelector('[data-project-column="d_submodule"]').textContent,
          filterValue: projectRowValue(item, 'd_module', []),
          cells: row.cells.length, headers: table.tHead.rows[0].cells.length
        };
        host.remove(); return result;
      }, section);
      assert.deepEqual(delivery.fields, [['Módulo', false], ['Submódulo', false]]);
      assert.equal(delivery.original, section === 'goals' ? 'Indicador' : 'Critério de conclusão');
      assert.equal(delivery.hidden, true); assert.equal(delivery.value, 'Caixas e Bancos');
      assert.equal(delivery.filterValue, 'Financeiro'); assert.equal(delivery.cells, delivery.headers);
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Result columns passed: visible after Canal, aligned values, column chooser, hide/show, filters, map filters and old saved preferences across registrations, products and deliveries.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
