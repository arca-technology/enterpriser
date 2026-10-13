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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://collaborator-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://collaborator-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      const admin = { ...cache.users[0], id: 'admin', role: 'admin', status: 'active', job_title: 'Diretor de operações' };
      const titles = [...OPERATIONS_JOB_HIERARCHY, ' GERENTE DE OPERACOES ', 'Gerente de Projetos', ''];
      cache.users = [admin, ...titles.map((job_title, index) => ({ id: 'staff-'+index, full_name: 'Colaborador '+index,
        nickname: index === 1 ? 'Bruno' : 'Ana '+index, email: 'colaborador'+index+'@example.test', role: 'collaborator',
        job_title, status: index === 2 ? 'inactive' : 'active', auth_user_id: 'auth-'+index, access_profile: 'project_manager',
        permissions: accessProfilePermissions('project_manager') })),
        { id: 'client', full_name: 'Cliente excluido', role: 'client', job_title: 'Diretor de operações' },
        { id: 'developer', full_name: 'Dev excluido', role: 'developer', job_title: 'Diretor de operações' }];
      cache.userById = Object.fromEntries(cache.users.map(user => [user.id, user]));
      currentProfile = admin;
      localStorage.setItem('crm_cfg', JSON.stringify({ url: 'https://fixture-api.localhost', anonKey: 'public-fixture' }));
      window.initialUsers = JSON.stringify(cache.users);
      render(); openRegistrationsModal('users');
    });
    const enterMap = async () => {
      await page.locator('#registration-view-menu-btn').click();
      await page.locator('#registration-view-dd [data-view="mindmap"]').click();
    };
    await enterMap();
    assert.equal(await page.locator('.collaborator-mind-card').count(), 8);
    assert.equal(await page.locator('.collaborator-inactive').count(), 1);
    assert.equal(await page.locator('.collaborator-mind-card[data-user-id="admin"],.collaborator-mind-card[data-user-id="client"],.collaborator-mind-card[data-user-id="developer"]').count(), 0);
    for (let rank = 1; rank < 5; rank++) {
      assert.equal(await page.locator(`[data-job-level="operations-${rank}"]`).evaluate(el => el.parentElement.closest('[data-job-level]').dataset.jobLevel), 'operations-'+(rank-1));
    }
    assert.equal(await page.locator('[data-job-level="operations-1"] > .registration-mind-toggle small').textContent(), '2');
    assert.equal(await page.locator('[data-job-level="other"] .collaborator-mind-card').count(), 1);
    assert.equal(await page.locator('[data-job-level="unassigned"] .collaborator-mind-card').count(), 1);
    assert.equal(await page.locator('.registration-mindmap-root span').textContent(), '8');
    await page.locator('[data-job-level="operations-0"] > .registration-mind-toggle').click();
    assert.equal(await page.locator('[data-job-level="operations-0"] > .registration-mind-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('[data-job-level="operations-0"] > .registration-mind-toggle').click();
    await page.locator('.registration-mind-search').fill('Bruno');
    assert.equal(await page.locator('.collaborator-mind-card').count(), 1);
    await page.locator('.registration-mind-search').fill('not found');
    assert.equal(await page.locator('.collaborator-mind-card').count(), 0);
    await page.locator('.registration-mind-search').fill('');
    await page.locator('.collaborator-user-edit[data-id="staff-1"]').click();
    assert.equal(await page.locator('#u-access-profile option:checked').textContent(), 'Gerente');
    assert.equal(await page.locator('#user-job-titles option').count() >= 5, true);
    await page.locator('#cancel-form').click();
    await page.locator('[data-orientation="vertical"]').click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-collaborators-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.collaborator-user-edit[data-id="staff-0"]').isVisible(), true);
    await page.locator('.registration-mind-hand').click();
    assert.equal(await page.locator('.registration-mind-hand').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-collaborators-mobile.png') });
    assert.ok(await page.locator('.registration-mindmap-scroll').evaluate(el => el.clientHeight > 150 && el.scrollHeight > el.clientHeight));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => {
      const st = registrationTableState(); st.view = 'table'; renderRegistrationsSection();
      const header = [...document.querySelectorAll('#registrations-root th')].find(el => el.dataset.registrationLabel === 'Status');
      st.filters = { [header.dataset.registrationKey]: new Set(['Ativo']) }; st.view = 'mindmap'; renderRegistrationsSection();
    });
    assert.equal(await page.locator('.collaborator-mind-card').count(), 7);
    await page.locator('.mind-filter-badge').click();
    assert.equal(await page.locator('.collaborator-mind-card').count(), 8);
    assert.equal(await page.evaluate(() => JSON.stringify(cache.users) === initialUsers), true);
    await page.evaluate(() => { closeModal(); currentProfile = cache.users.find(user => user.id === 'staff-1'); openRegistrationsModal('users'); });
    await enterMap();
    assert.equal(await page.locator('#registration-add,.reg-user-edit,.collaborator-user-edit').count(), 0);
    assert.equal(await page.locator('.collaborator-mind-card').count(), 8);
    await page.evaluate(() => { closeModal(); currentProfile = { ...currentProfile, permissions: emptyUserPermissions() }; openRegistrationsModal('users'); });
    assert.equal(await page.locator('#registrations-root').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Collaborator map browser passed: role hierarchy, unknown/unassigned groups, collaborator-only scope, search/filters, expand/collapse, editor labels, mobile scrolling, readonly permissions and unchanged user records.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
