const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/^startApp\(\);/m, '');
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requests = [];
let savedProfile;
let branding = { company_name: 'ECOMMERCE365', logo_path: null };
let imageBytes;
let failPhoto = false;
let failBranding = false;
let signature = 0;
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === 'identity-test.localhost') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.hostname !== 'identity-api.localhost') return route.abort();
      const method = request.method();
      const data = request.postDataJSON && request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null;
      requests.push({ path: url.pathname, method, data, contentType: request.headers()['content-type'], search: url.search });
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname.startsWith('/rest/v1/profiles')) {
        if (method === 'PATCH') savedProfile = { ...savedProfile, ...data };
        return json([savedProfile]);
      }
      if (url.pathname.startsWith('/rest/v1/crm_workspace_settings')) {
        if (method === 'PATCH' && failBranding) return json({ message: 'Empresa indisponível' }, 403);
        if (method === 'PATCH') branding = { ...branding, ...data };
        return json([branding]);
      }
      if (url.pathname.startsWith('/storage/v1/object/sign/')) {
        if (method === 'POST') return json({ signedURL: url.pathname.replace('/storage/v1', '') + '?token=fixture-' + (++signature) });
        if (failPhoto && url.pathname.includes('/users/')) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'image/png', body: imageBytes });
      }
      if (method === 'POST' && url.pathname.startsWith('/storage/v1/object/crm-identity-assets/')) {
        return json({ Key: url.pathname });
      }
      if (method === 'DELETE') return json([]);
      return json([]);
    });
    await page.goto('http://identity-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll();
      document.getElementById('boot-gate')?.remove();
      hideLogin(); loadNavigationPreference(); render();
    });
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 72;
      const context = canvas.getContext('2d'); context.fillStyle = '#2b73d9'; context.fillRect(0, 0, 72, 72);
      context.fillStyle = '#ffffff'; context.fillRect(18, 18, 36, 36);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    imageBytes = Buffer.from(base64, 'base64');
    savedProfile = await page.evaluate((uid) => {
      const profile = { ...cache.users[0], auth_user_id: uid, full_name: 'Ulisses Ferreira', nickname: 'Ulisses', email: 'ulisses@example.test', job_title: 'Gestor', role: 'admin', status: 'active', avatar_path: null };
      currentProfile = profile; cache.users[0] = profile; cache.userById[profile.id] = profile; cache.userByAuthId[uid] = profile;
      localStorage.setItem('crm_cfg', JSON.stringify({ url: 'https://identity-api.localhost', anonKey: 'public-fixture', myName: 'Ulisses', myRedditUsername: 'ulisses' }));
      storeAuthSession({ user: { id: uid }, access_token: 'fixture', refresh_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      workspaceIdentityReady = true; render(); return profile;
    }, uid);
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
    assert.equal(await page.locator('[data-action="updates"] .nav-label').textContent(), `Versão: ${version}`);
    assert.equal(await page.locator('#app-sidebar [data-action="help"],#app-footer [data-action="help"]').count(), 0);
    const footerCenter = await page.locator('#app-footer .foot-right').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
    assert.ok(Math.abs(footerCenter - 720) < 2);
    const log = await page.locator('#floating-log').boundingBox();
    assert.ok(log);
    assert.equal(await page.locator('#floating-help').count(), 0);
    await page.locator('.home-help-button').click();
    assert.equal(await page.locator('#help-panel').count(), 1);
    await page.evaluate(() => closeHelpPanel());
    await page.evaluate(() => openSettings());
    assert.equal(await page.locator('#settings-full-name').inputValue(), savedProfile.full_name);
    assert.equal(await page.locator('#settings-email').inputValue(), savedProfile.email);
    assert.equal(await page.locator('#settings-email').getAttribute('readonly'), '');
    assert.equal(await page.locator('#settings-job').inputValue(), 'Gestor');
    assert.equal(await page.locator('#modal-root [data-k="url"],#modal-root [data-k="anonKey"]').count(), 0);
    assert.ok(!/Supabase|anon public key|Salvar e conectar/.test(await page.locator('#modal-root').innerText()));
    const file = { name: 'photo.png', mimeType: 'image/png', buffer: imageBytes };
    await page.locator('#settings-photo').setInputFiles(file);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-photo-control="photo"] img')));
    assert.equal(requests.filter((r) => r.method === 'POST' && r.path.includes('/object/crm-identity-assets/')).length, 0);
    await page.locator('#settings-cancel').click();
    assert.equal(requests.filter((r) => r.method === 'PATCH').length, 0);
    await page.evaluate(() => openSettings());
    await page.locator('#settings-photo').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await page.waitForFunction(() => !document.getElementById('settings-error').hidden);
    assert.match(await page.locator('#settings-error').textContent(), /PNG, JPG ou WebP/);
    await page.locator('#settings-photo').setInputFiles({ ...file, buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await page.waitForFunction(() => document.getElementById('settings-error').textContent.includes('5 MB'));
    await page.locator('#settings-photo').setInputFiles(file);
    await page.locator('#settings-logo').setInputFiles(file);
    await page.waitForFunction(() => !document.getElementById('save').disabled && document.querySelector('[data-photo-control="logo"] img'));
    await page.locator('#settings-nickname').fill('Uli');
    await page.locator('input[name="navigation-mode"][value="sidebar"]').check();
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.getElementById('save'));
    const profileWrite = requests.find((r) => r.method === 'PATCH' && r.path.endsWith('/profiles'));
    assert.deepEqual(Object.keys(profileWrite.data).sort(), ['avatar_path', 'full_name', 'nickname', 'phone']);
    assert.match(profileWrite.search, new RegExp(`auth_user_id=eq.${uid}`));
    assert.match(savedProfile.avatar_path, new RegExp(`^users/${uid}/[0-9a-f-]{36}\\.webp$`));
    assert.match(branding.logo_path, /^workspace\/[0-9a-f-]{36}\.webp$/);
    const uploads = requests.filter((r) => r.method === 'POST' && r.path.includes('/object/crm-identity-assets/'));
    assert.equal(uploads.length, 2);
    assert.ok(uploads.every((r) => r.contentType === 'image/webp'));
    assert.equal(await page.evaluate(() => getCfg().url), 'https://identity-api.localhost');
    assert.equal(await page.evaluate(() => getCfg().anonKey), 'public-fixture');
    assert.equal(await page.locator('#app-sidebar .sidebar-support .foot-btn').count(), 1);
    assert.equal(await page.locator('#app-header').isVisible(), false);
    await page.evaluate(() => {
      const root = document.createElement('div'); root.id = 'identity-fixture';
      root.innerHTML = assigneeCellHtml([currentProfile.id]) + identityPersonHtml('missing', 'Sem foto');
      document.getElementById('main').appendChild(root);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#identity-fixture img')].filter((img) => img.complete && img.naturalWidth > 0).length === 2);
    assert.equal(await page.locator('#identity-fixture .identity-logo').count(), 1);
    failPhoto = true;
    await page.evaluate(() => {
      identityUrls.clear(); document.querySelector('#identity-fixture').remove();
      const root = document.createElement('div'); root.id = 'identity-fixture'; root.innerHTML = identityPersonHtml(currentProfile.id); document.getElementById('main').appendChild(root);
    });
    await page.waitForFunction(() => document.querySelector('#identity-fixture .identity-logo')?.naturalWidth > 0);
    failPhoto = false;
    await page.evaluate(() => { workspaceIdentity.logo_path = null; currentProfile.avatar_path = null; cache.userById[currentProfile.id].avatar_path = null; queueIdentityAvatars(); });
    await page.waitForFunction(() => !document.querySelector('#identity-fixture img'));
    assert.equal(await page.locator('#identity-fixture .identity-avatar svg').count(), 1);
    await page.evaluate(() => { workspaceIdentity.logo_path = 'workspace/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'; currentProfile.avatar_path = null; });
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 740 });
      await page.evaluate(() => openSettings());
      const geometry = await page.locator('#save').evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, scroll: document.documentElement.scrollWidth }; });
      assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.bottom <= 740, `${width}: visible save button`);
      assert.ok(geometry.scroll <= width, `${width}: no page overflow`);
      await page.screenshot({ path: path.join(os.tmpdir(), `profile-settings-${width}.png`) });
      await page.locator('#settings-cancel').click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { currentProfile.role = 'collaborator'; openSettings(); });
    assert.equal(await page.locator('#settings-workspace,#settings-logo').count(), 0);
    await page.locator('#settings-cancel').click();
    await page.evaluate(() => { currentProfile.role = 'client'; openSettings(); });
    await page.locator('#settings-nickname').fill('Cliente');
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.getElementById('save'));
    assert.equal(savedProfile.nickname, 'Cliente');
    assert.equal(savedProfile.role, 'admin', 'self-profile request never writes the role');
    await page.evaluate(() => { currentProfile.role = 'admin'; openSettings(); });
    failBranding = true;
    await page.locator('#settings-photo').setInputFiles(file);
    await page.locator('#settings-logo').setInputFiles(file);
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.getElementById('save').disabled && !document.getElementById('settings-error').hidden);
    assert.match(await page.locator('#settings-error').textContent(), /perfil foi salvo/);
    const deletes = requests.filter((r) => r.method === 'DELETE').flatMap((r) => r.data.prefixes);
    assert.ok(!deletes.includes(savedProfile.avatar_path), 'never delete the committed personal photo');
    assert.ok(deletes.some((value) => value.startsWith('workspace/')), 'clean up uncommitted logo');
    await page.locator('#settings-cancel').click();
    assert.deepEqual(errors, []);
    console.log('Profile identity passed: safe field whitelist, upload validation, cancel, partial failure cleanup, private URLs, avatar fallbacks, version, floating help and responsive settings.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
