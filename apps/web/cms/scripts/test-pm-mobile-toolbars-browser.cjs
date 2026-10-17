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
    let fixtureHtml = html;
    if (process.env.CMS_TEST_DEPLOYED_STYLES === '1') {
      const response = await fetch('https://app.enterpriser.com.br/cms');
      assert.ok(response.ok);
      const stylesheetPaths = await page.evaluate(markup => [...new DOMParser().parseFromString(markup, 'text/html').querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute('href')), await response.text());
      let styles = '';
      for (const href of stylesheetPaths) {
        const css = await fetch(new URL(href, 'https://app.enterpriser.com.br'));
        assert.ok(css.ok); styles += await css.text();
      }
      fixtureHtml = html.replace(/<style>[\s\S]*?<\/style>/, `<style>${styles}</style>`);
    }
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://pm-mobile.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: fixtureHtml }) : route.abort());
    await page.goto('http://pm-mobile.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    for (const file of ['public/legacy/navigation-icons.js', 'vendor/dagre.min.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true;
      currentProfile = { id: 'pm-mobile-admin', role: 'admin', status: 'active' };
      saveProductActivities([{ id: 'task', product_id: 'pr1', activity: 'Extrato de banco', category: 'Banco', channel: 'C6 BANK' }]);
      saveProductGoals([{ id: 'goal', product_id: 'pr1', name: 'Primeira venda', category: 'Canais de venda', channel: 'AMAZON' }]);
      saveProductObjectives([{ id: 'objective', product_id: 'pr1', name: 'Conta ativa', category: 'Canais de venda', channel: 'MERCADO LIVRE' }]);
      window.recordSnapshot = JSON.stringify([loadProductActivities(), loadProductGoals(), loadProductObjectives(), loadProjectTasks()]);
      document.body.classList.add('light'); render();
    });
    for (const navigation of ['top', 'sidebar']) {
      await page.evaluate(mode => saveNavigationPreference({ mode }), navigation);
      for (const [section, label] of [['activities', 'Tarefas'], ['goals', 'Metas'], ['objectives', 'Objetivos']]) {
        await page.locator(`#mobile-module-track [data-mobile-tab="${section}"]`).evaluate(button => button.click());
        if (await page.evaluate(() => mainPmCatalogActive())) await page.locator('#main [data-pm-mode]').click();
        assert.equal(await page.evaluate(() => state.view), 'list', 'Mobile execution starts in the actual List view');
        assert.equal(await page.locator('#main table.explicit-list-view').count(), 1);
        const execution = await page.locator('.subbar').boundingBox();
        assert.ok(execution);
        await page.locator('#pm-mode-button').click();
        assert.equal(await page.locator('#main .registration-toolbar-title').innerText(), label);
        if (navigation === 'top') {
          assert.equal(await page.evaluate(() => registrationTableState().view), 'list', 'Mobile catalogs default to List');
          assert.equal(await page.locator('#main .list-view-controls').count(), 1);
          if (section === 'objectives') await page.screenshot({ path: path.join(os.tmpdir(), 'pm-mobile-default-list.png') });
        }
        for (const view of ['table', 'list', 'mindmap']) {
          await page.locator('#registration-view-menu-btn').click();
          await page.locator(`#registration-view-dd [data-view="${view}"]`).click();
          await page.evaluate(() => renderRegistrationsSection());
          assert.equal(await page.evaluate(() => registrationTableState().view), view, 'Rerender preserves a manually selected view');
          for (const width of [390, 360]) {
            await page.setViewportSize({ width, height: 844 });
            const toolbar = page.locator('#main .registration-toolbar');
            const title = await toolbar.locator('.registration-toolbar-title').boundingBox();
            const count = await toolbar.locator('.registration-toolbar-left .muted').boundingBox();
            const tools = await toolbar.locator('.registration-toolbar-right').boundingBox();
            const search = await toolbar.locator('.search').boundingBox();
            const mode = await toolbar.locator('[data-pm-mode]').boundingBox();
            const add = await toolbar.locator('#registration-add').boundingBox();
            assert.ok(title && count && tools && search && mode && add, `${navigation}/${section}/${view}: all toolbar parts visible`);
            assert.ok(title.y < count.y && count.y < search.y && tools.y < search.y, 'Title/count/tools above search');
            assert.ok(mode.x + mode.width <= search.x && search.x + search.width <= add.x && add.x + add.width <= width, 'Search row must fit');
            assert.ok(Math.abs((await toolbar.boundingBox()).height - execution.height) <= 8, 'Catalog and execution toolbars must have equal height');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          }
          if (view === 'table') {
            await page.locator('.registration-cols-btn').click();
            assert.equal(await page.locator('#cols-dd').isVisible(), true);
            await page.locator('#cols-dd .column-manager-close').click();
            await page.screenshot({ path: path.join(os.tmpdir(), `pm-mobile-${navigation}-${section}.png`) });
          }
        }
        await page.locator('#main [data-pm-mode]').click();
        assert.equal(await page.locator('#mobile-module-caption').innerText(), label);
        assert.equal(await page.locator('#pm-mode-button').isVisible(), true);
      }
    }
    await page.evaluate(() => { closeModal(); openProductActivities('pr1'); });
    for (const section of ['activities', 'goals', 'objectives']) {
      await page.locator(`[data-product-tab="${section}"]`).evaluate(button => button.click());
      assert.equal(await page.evaluate(() => productWorkspaceTableState().view), 'list', 'Mobile product tabs default to List');
      assert.equal(await page.locator('#product-activities-root .list-view-controls').count(), 1);
    }
    await page.evaluate(() => { closeModal(); openProjectBoard(cache.projects[0].id); });
    assert.equal(await page.evaluate(() => projectBoardState.view), 'dashboard', 'Delivery overview remains a dashboard');
    for (const section of ['activities', 'goals', 'objectives']) {
      await page.locator(`[data-project-section="${section}"]`).evaluate(button => button.click());
      assert.equal(await page.evaluate(() => projectBoardState.view), 'list', 'Mobile delivery sections default to List');
    }
    await page.evaluate(() => { closeModal(); saveNavigationPreference({ mode: 'top' }); });
    for (const section of ['contacts', 'companies', 'conversations', 'deals', 'projects']) {
      await page.locator(`#tabs [data-tab="${section}"]`).evaluate(button => button.click());
      assert.equal(await page.evaluate(() => state.view), 'list', `${section}: mobile default is List`);
    }
    await page.locator('#view-menu-btn').click();
    await page.locator('#view-dd [data-view="table"]').click();
    await page.evaluate(() => render());
    assert.equal(await page.evaluate(() => state.view), 'table', 'Explicit Table choice remains available on mobile');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#tabs [data-tab="contacts"]').click();
    assert.equal(await page.evaluate(() => state.view), 'table', 'Desktop still defaults to Table');
    await page.evaluate(() => { registrationsState.tables = {}; openMainPmCatalog('objectives'); });
    assert.equal(await page.evaluate(() => registrationTableState().view), 'table', 'Desktop catalogs still default to Table');
    assert.equal(await page.evaluate(() => JSON.stringify([loadProductActivities(), loadProductGoals(), loadProductObjectives(), loadProjectTasks()]) === recordSnapshot), true);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Mobile List defaults passed: execution, catalogs, products, delivery sections and main modules; manual Table/Map preserved; desktop Table and delivery dashboard unchanged; 360/390px toolbars, top/sidebar navigation and zero data writes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
