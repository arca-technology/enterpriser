const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/^startApp\(\);/m, '');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/legacy/app.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.CRM_CONFIG = {};\n${source}` }));
    await page.goto(`${process.env.CMS_TEST_URL || 'http://localhost:4387'}/cms`);
    await page.waitForFunction(() => typeof loadAll === 'function');
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      loadNavigationPreference(); setTheme(true); state.tab = 'contacts'; state.view = 'table'; render();
      await document.fonts.ready;
    });
    for (const selector of ['body', '#search', '#new', '#tabs .tab']) {
      assert.match(await page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily), /Inter/i);
    }
    assert.match(await page.locator('#brand-home').evaluate((el) => getComputedStyle(el).fontFamily), /Urbanist/i);
    assert.equal(await page.locator('#brand-home').evaluate((el) => getComputedStyle(el).fontWeight), '800');
    assert.equal(await page.locator('#count').innerText(), `${await page.evaluate(() => cache.contacts.length)} Pessoas`);
    await page.evaluate(() => saveNavigationPreference({ mode: 'sidebar' }));
    const brand = await page.locator('#brand-home').boundingBox();
    const system = await page.locator('.sidebar-system').boundingBox();
    assert.ok(system && brand && system.y >= brand.y + brand.height);
    assert.equal(await page.locator('#app-sidebar').evaluate((el) => el.getBoundingClientRect().width), 64);
    await page.evaluate(() => {
      const project = cache.projects[0];
      saveDeliveryGoals([{ id: 'font-goal', project_id: project.id, name: 'Meta de acompanhamento', status: 'todo', target_value: 100 }]);
      state.tab = 'goals'; render();
    });
    const columns = await page.locator('#main thead th').evaluateAll((cells) => cells.slice(0, 3).map((cell) => ({ x: cell.getBoundingClientRect().x, width: cell.getBoundingClientRect().width })));
    assert.equal(columns[0].width, 42);
    assert.equal(columns[1].width, 30);
    assert.equal(columns[2].x, columns[1].x + columns[1].width);
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-inter-desktop.png') });
    await page.evaluate(() => openRegistrationsModal('emails'));
    assert.equal(await page.locator('#registrations-root #tools-root').count(), 1);
    assert.equal(await page.locator('#tools-root .tools-pagination > span').innerText(), '0 Emails');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-emails-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('Built app passed: real Inter/Urbanist fonts, CMS mark, result column geometry, counters and mobile Emails.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
