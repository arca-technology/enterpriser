const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/^startApp\(\);/m, '');
const profiles = {
  admin: { id: 'test-admin', auth_user_id: 'admin', email: 'upgferreira@gmail.com', full_name: 'Ulisses Admin', role: 'admin', status: 'active' },
  user: { id: 'test-user', auth_user_id: 'user', email: 'ulisses.ferreira@ecommerce365.com.br', full_name: 'Ulisses Ferreira', role: 'collaborator', status: 'active' },
  dev: { id: 'test-dev', auth_user_id: 'dev', email: 'dev@enterpriser.com.br', full_name: 'Dev', role: 'developer', status: 'active' }
};
const session = (id) => ({ user: { id }, access_token: `fixture-${id}`, refresh_token: `refresh-${id}`, expires_in: 3600 });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === 'settings-test.localhost') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.hostname !== 'accounts-api.localhost') return route.abort();
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      requests.push({ path: url.pathname, method: request.method() });
      if (url.pathname === '/auth/v1/token') {
        const data = request.postDataJSON();
        if (data.password === 'bad-fixture') return json({ msg: 'Senha incorreta' }, 400);
        const id = data.refresh_token?.replace('refresh-', '') || Object.keys(profiles).find((id) => profiles[id].email === data.email);
        return json(session(id));
      }
      if (url.pathname === '/rest/v1/profiles') {
        const id = url.searchParams.get('auth_user_id')?.replace('eq.', '');
        assert.equal(request.headers().authorization, `Bearer fixture-${id}`);
        return json([profiles[id]]);
      }
      return json([]);
    });
    await page.goto('http://settings-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async ({ profiles, sessions }) => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      window.fixtureCache = cache;
      currentProfile = profiles.admin;
      localStorage.setItem('crm_cfg', JSON.stringify({ url: 'https://accounts-api.localhost', anonKey: 'public-fixture' }));
      storeAuthSession(sessions.admin);
      rememberAccountSession(profiles.admin, sessions.admin); rememberAccountSession(profiles.user, sessions.user);
      init = async () => { cache = fixtureCache; render(); };
      loadNavigationPreference(); saveNavigationPreference({ mode: 'sidebar' });
      state.tab = 'contacts'; state.view = 'table'; render();
    }, { profiles, sessions: { admin: session('admin'), user: session('user') } });
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const tab of ['contacts', 'companies', 'conversations', 'deals', 'projects', 'activities', 'goals', 'objectives']) {
      await page.evaluate((tab) => { state.tab = tab; state.view = 'table'; render(); }, tab); await settle();
      const heights = await page.evaluate(() => ({ toolbar: document.querySelector('.subbar').getBoundingClientRect().height,
        header: document.querySelector('#main thead th').getBoundingClientRect().height,
        logo: document.querySelector('.sidebar-company-slot').getBoundingClientRect().height }));
      assert.deepEqual(heights, { toolbar: 40, header: 40, logo: 40 });
    }
    assert.equal(await page.locator('.sidebar-system svg,.sidebar-system-icon,[data-action="accounts"]').count(), 0);
    await page.evaluate(() => openSettings());
    assert.deepEqual(await page.locator('[data-settings-tab]').allTextContents(), ['Perfil', 'Contas']);
    assert.equal(await page.locator('#settings-conversation-name,#settings-reddit,#settings-switch-account').count(), 0);
    await page.locator('#settings-nickname').fill('Perfil em preenchimento');
    await page.locator('#settings-accounts-tab').click();
    assert.equal(await page.locator('#save').isVisible(), false);
    assert.equal(await page.locator('#settings-accounts-panel [data-account-use]').count(), 2);
    await page.locator('#settings-profile-tab').click();
    assert.equal(await page.locator('#settings-nickname').inputValue(), 'Perfil em preenchimento');
    await page.locator('#settings-profile-tab').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#settings-accounts-tab').getAttribute('aria-selected'), 'true');
    const dismiss = (dialog) => dialog.dismiss();
    page.on('dialog', dismiss);
    await page.locator('[data-account-use="user"]').click();
    assert.equal(await page.evaluate(() => currentProfile.role), 'admin');
    assert.equal(requests.filter((request) => request.path === '/auth/v1/token').length, 0, 'Declining discard must not initiate authentication');
    page.off('dialog', dismiss);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-account-use="user"]').click();
    await page.waitForFunction(() => currentProfile.role === 'collaborator');
    assert.equal(await page.locator('#settings-profile-panel').count(), 0);
    await page.evaluate(() => openSettings()); await page.locator('#settings-accounts-tab').click();
    await page.locator('#account-email').fill('dev@enterpriser.com.br');
    await page.locator('#account-password').fill('bad-fixture'); await page.locator('#account-add').click();
    await page.waitForFunction(() => !document.getElementById('account-error').hidden);
    assert.match(await page.locator('#account-error').innerText(), /Senha incorreta/);
    assert.equal(await page.evaluate(() => currentProfile.role), 'collaborator');
    assert.equal(await page.locator('#account-add').isEnabled(), true);
    await page.locator('#account-password').fill('good-fixture'); await page.locator('#account-add').click();
    await page.waitForFunction(() => currentProfile.role === 'developer');
    assert.equal(await page.evaluate(() => quickAccountSessions.has('dev')), true);
    assert.equal(await page.evaluate(() => [...Array(localStorage.length)].map((_, i) => localStorage.key(i)).filter((key) => /auth|account/i.test(key)).join(',')), 'crm_auth_session');
    await page.evaluate(() => openSettings()); await page.locator('#settings-accounts-tab').click();
    await page.locator('[data-account-forget="user"]').click();
    assert.equal(await page.evaluate(() => quickAccountSessions.has('user')), false);
    assert.equal(await page.locator('[data-account-use="dev"]').isDisabled(), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'settings-accounts-desktop.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 740 });
      for (const tab of ['profile', 'accounts']) {
        await page.locator(`#settings-${tab}-tab`).click();
        const footer = await page.locator('#settings-cancel').boundingBox();
        const nav = await page.locator('#mobile-navigation').boundingBox();
        assert.ok(footer && nav && footer.y + footer.height <= nav.y + 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.screenshot({ path: path.join(os.tmpdir(), `settings-accounts-${width}.png`) });
    }
    await page.evaluate(() => { closeModal(); currentProfile = { ...currentProfile, email: 'colaborador@example.test' }; openSettings(); });
    assert.equal(await page.locator('#settings-accounts-tab,#settings-accounts-panel').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Settings passed: profile/accounts tabs, preserved drafts, authorized switches, rejected discard, add/error/remove flows, memory-only extra accounts, no navigation account/CMS icons, 40px table/branding headers, mobile footer and access gating.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
