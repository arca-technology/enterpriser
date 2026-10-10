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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url() === 'http://navigation-test.local/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://navigation-test.local/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll();
      document.getElementById('boot-gate')?.remove();
      hideLogin();
      loadNavigationPreference();
      render();
    });
    assert.equal(await page.locator('#app-header #tabs').count(), 1);
    await page.evaluate(() => openSettings());
    await page.locator('input[name="navigation-mode"][value="sidebar"]').check();
    await page.locator('#save').click();
    assert.equal(await page.locator('#app-sidebar #tabs').count(), 1);
    assert.equal(await page.locator('#app-header').isVisible(), false);
    assert.equal(await page.locator('#app-sidebar .sidebar-bottom .actions').count(), 1);
    assert.equal(await page.locator('#app-sidebar .nav-icon svg').count(), 6);
    assert.equal(await page.locator('#app-sidebar #brand-home').count(), 1);
    await page.locator('#tabs [data-tab="contacts"]').click();
    assert.equal(await page.evaluate(() => state.tab), 'contacts');
    for (const light of [false, true]) {
      await page.evaluate((light) => setTheme(light), light);
      for (const width of [1440, 1024, 390]) {
        const height = width < 761 ? 600 : 900;
        await page.setViewportSize({ width, height });
        if (width < 761) await page.locator('#sidebar-toggle').click();
        const geometry = await page.locator('#app-sidebar').evaluate((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width }));
        assert.equal(geometry.x, 0);
        assert.equal(geometry.width, 208);
        assert.equal(await page.locator('#main').evaluate((el) => el.getBoundingClientRect().x), width < 761 ? 0 : 208);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator('#app-header').isVisible(), false);
        const actions = await page.locator('#app-sidebar .actions').evaluate((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
        const tabsBottom = await page.locator('#tabs').evaluate((el) => el.getBoundingClientRect().bottom);
        assert(actions.top > tabsBottom);
        assert(actions.bottom <= height);
        assert.equal(await page.locator('#app-sidebar [data-action="settings"]').isVisible(), true);
        assert.equal(await page.locator('#app-sidebar [data-action="notifications"]').isVisible(), true);
        await page.screenshot({ path: path.join(require('node:os').tmpdir(), `navigation-${light ? 'light' : 'dark'}-${width}.png`) });
        if (width < 761) {
          await page.locator('#tabs [data-tab="companies"]').click();
          assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
          await page.locator('#sidebar-toggle').click();
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#sidebar-collapse').click();
    assert.equal(await page.locator('#app-sidebar').evaluate((el) => el.getBoundingClientRect().width), 64);
    assert.equal(await page.locator('#main').evaluate((el) => el.getBoundingClientRect().x), 64);
    assert.equal(await page.locator('#app-sidebar .nav-icon svg').count(), 6);
    assert.equal(await page.locator('#app-sidebar [data-action="settings"]').isVisible(), true);
    await page.setViewportSize({ width: 1024, height: 600 });
    assert(await page.locator('#app-sidebar .actions').evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight));
    await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'navigation-collapsed-short.png') });
    await page.evaluate(() => loadNavigationPreference());
    assert.equal(await page.evaluate(() => navigationPreference.collapsed), true);
    await page.evaluate(() => { currentProfile = { id: 'second-user' }; loadNavigationPreference(); });
    assert.equal(await page.locator('#app-header #tabs').count(), 1);
    await page.evaluate(() => { currentProfile = null; loadNavigationPreference(); });
    assert.equal(await page.locator('#app-sidebar #tabs').count(), 1);
    await page.evaluate(async () => {
      currentProfile = { id: 'remote-user' };
      loadNavigationPreference();
      const oldApi = api;
      const oldConfig = window.CRM_CONFIG;
      api = async () => [{ column_preferences: { __navigation: { mode: 'sidebar', collapsed: true } } }];
      window.CRM_CONFIG = { url: 'https://test.invalid', anonKey: 'test-key' };
      try { await loadRemoteColumnPreferences(); }
      finally { api = oldApi; window.CRM_CONFIG = oldConfig; }
    });
    assert.equal(await page.evaluate(() => navigationPreference.mode), 'sidebar');
    assert.equal(await page.evaluate(() => navigationPreference.collapsed), true);
    await page.evaluate(() => saveNavigationPreference({ mode: 'top' }));
    assert.equal(await page.locator('#app-header #tabs').count(), 1);
    assert.equal(await page.locator('#app-sidebar').isVisible(), false);
    assert.equal(await page.locator('#app-header .actions').count(), 1);
    assert.equal(await page.locator('#app-header #brand-home').count(), 1);
    assert.equal(await page.locator('#app-header').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('Navigation settings, existing module actions, desktop/mobile layout, collapse, per-user isolation and remote preferences passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
