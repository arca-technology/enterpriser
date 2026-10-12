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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
    if (process.env.CMS_TEST_URL) {
      await page.route('**/legacy/app.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.CRM_CONFIG = {};\n${source}` }));
      await page.goto(`${process.env.CMS_TEST_URL}/cms`);
      await page.waitForFunction(() => typeof loadAll === 'function');
      await page.evaluate(() => document.fonts.ready);
    } else {
      await page.route('**/*', (route) => route.request().url() === 'http://sidebar-fit.localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
      await page.goto('http://sidebar-fit.localhost/');
      await page.evaluate(() => { window.CRM_CONFIG = {}; });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
      await page.addScriptTag({ content: source });
    }
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      loadNavigationPreference(); saveNavigationPreference({ mode: 'sidebar' }); render();
    });
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const width of [1440, 1024, 768]) {
      for (const height of [1200, 1000, 900, 800, 720, 640, 560, 480, 360, 240]) {
        await page.setViewportSize({ width, height });
        await settle();
        const geometry = await page.locator('#app-sidebar').evaluate((sidebar) => {
          const modules = sidebar.querySelector('.sidebar-modules');
          const version = sidebar.querySelector('[data-action="updates"]').getBoundingClientRect();
          return { height: sidebar.clientHeight, scroll: sidebar.scrollHeight, width: sidebar.clientWidth, scrollWidth: sidebar.scrollWidth,
            modulesHeight: modules.clientHeight, modulesScroll: modules.scrollHeight, versionBottom: version.bottom };
        });
        assert.ok(geometry.scroll <= geometry.height + 1, `${width}x${height}: sidebar overflow ${JSON.stringify(geometry)}`);
        assert.ok(geometry.modulesScroll <= geometry.modulesHeight + 1, `${width}x${height}: module overflow`);
        assert.ok(geometry.scrollWidth <= geometry.width + 1, `${width}x${height}: horizontal sidebar overflow`);
        assert.ok(geometry.versionBottom <= height && geometry.versionBottom >= height - 12, `${width}x${height}: bottom version`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1200 }); await settle();
    assert.equal(await page.locator('#tabs [data-tab="contacts"] .nav-label').isVisible(), true);
    assert.equal(await page.locator('#sidebar-utility-more').isVisible(), false);
    assert.equal(await page.locator('#app-sidebar .version-button .nav-icon').count(), 0);
    assert.ok(await page.locator('#app-sidebar .version-button').evaluate((el) => el.getBoundingClientRect().height <= 16));
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
    await page.locator('#app-sidebar [data-action="automation"]').hover();
    await page.waitForSelector('#sidebar-submodules[data-parent="automation"]');
    assert.deepEqual(await page.locator('#sidebar-submodules .sidebar-submodule').allTextContents(), ['E-mails', 'WhatsApp', 'Instagram', 'SMS']);
    assert.equal(await page.locator('#sidebar-submodules .brand-icon').count(), 2);
    for (const [id, label] of [['automation-emails', 'E-mails'], ['automation-whatsapp', 'WhatsApp'], ['automation-instagram', 'Instagram'], ['automation-sms', 'SMS']]) {
      await page.evaluate(() => openSidebarSubmodules(document.querySelector('#app-sidebar [data-action="automation"]'), true));
      await page.locator(`#sidebar-submodules [data-section="${id}"]`).click();
      assert.equal(await page.locator('#automation-root h2').innerText(), `Automação · ${label}`);
      assert.equal(await page.locator('#sidebar-module-context').count(), 0);
      assert.equal(await page.locator('#app-sidebar .modal-close-x:visible').count(), 0);
      assert.equal(await page.locator('#app-header').isVisible(), false);
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-automation-desktop.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1024, height: 640 }); await settle();
    assert.equal(await page.locator('#tabs [data-tab="contacts"] .nav-label').isVisible(), false);
    await page.locator('#sidebar-utility-more').click();
    const menuLabels = await page.locator('#sidebar-submodules .sidebar-submodule').allTextContents();
    assert.ok(menuLabels.includes('Configurações') && menuLabels.includes('Tema claro/escuro') && menuLabels.includes('Sair'));
    await page.locator('#sidebar-submodules .sidebar-submodule').filter({ hasText: 'Tema claro/escuro' }).click();
    assert.equal(await page.evaluate(() => document.body.classList.contains('light')), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-compact-desktop.png') });
    await page.setViewportSize({ width: 1024, height: 240 }); await settle();
    await page.locator('#sidebar-nav-more').click();
    assert.equal(await page.locator('#sidebar-submodules .sidebar-submodule').count(), 12);
    await page.locator('#sidebar-submodules .sidebar-submodule').filter({ hasText: /^Pessoas$/ }).click();
    assert.equal(await page.evaluate(() => state.tab), 'contacts');
    await page.setViewportSize({ width: 390, height: 740 }); await settle();
    await page.locator('#mobile-more').click();
    await page.locator('#mobile-navigation-menu summary').filter({ hasText: 'Automação' }).click();
    await page.locator('#mobile-navigation-menu .mobile-menu-item').filter({ hasText: /^WhatsApp$/ }).click();
    assert.equal(await page.locator('#automation-root h2').innerText(), 'Automação · WhatsApp');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'sidebar-automation-mobile.png') });
    await page.evaluate(() => { closeModal(); saveNavigationPreference({ mode: 'top' }); });
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
    assert.equal(await page.locator('#sidebar-utility-more').isVisible(), false);
    await page.locator('#app-footer [data-action="automation"]').click();
    assert.equal(await page.locator('#modal-root [data-automation-tab]').count(), 4);
    assert.equal(await page.locator('#shell-close').isVisible(), true);
    await page.locator('[data-automation-tab="automation-sms"]').click();
    assert.equal(await page.locator('#automation-root h2').innerText(), 'Automação · SMS');
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    console.log('Sidebar passed: no overflow at 30 viewport sizes, compact labels, grouped utilities, preserved actions, unobtrusive bottom version, no sidebar X and automation navigation on desktop/mobile/header.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
