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
    await page.route('**/*', route => route.request().url() === 'http://access-test.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://access-test.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    const employeeId = await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentProfile = { ...cache.users[0], role: 'admin', status: 'active' };
      const employee = { ...cache.users[1], role: 'collaborator', full_name: 'Mateus fixture', email: 'mateus@example.test',
        status: 'active', auth_user_id: 'fixture-auth', permissions: defaultPermissionsForRole('collaborator'), access_profile: 'custom' };
      upsertCachedEntity('users', employee);
      cache.productActivities.push(...['Financeiro', 'Fiscal'].map((category, index) => ({ id: 'rule-'+index,
        category, channel: 'Bling', module: 'Contas', submodule: index ? 'Receber' : 'Pagar' })));
      localStorage.setItem('crm_cfg', JSON.stringify({ url: 'https://access-api.localhost', anonKey: 'fixture-public' }));
      callUserAdmin = async (action, body) => { window.savedAccess = { action, body }; return { profile: { ...employee, ...body } }; };
      init = async () => {};
      render(); openRegistrationsModal('users'); openUsersModal(employee.id, true);
      return employee.id;
    });
    assert.equal(await page.locator('#u-role').inputValue(), 'collaborator');
    assert.equal(await page.locator('#u-access-profile').inputValue(), 'custom');
    const choose = async (field, values) => {
      await page.locator(`#u-auto-${field} .multi-picker-control`).click();
      for (const value of values) await page.locator(`#u-auto-${field} .multi-picker-option`).filter({ hasText: value }).click();
      await page.keyboard.press('Escape');
    };
    await choose('category', ['Financeiro', 'Fiscal']);
    await choose('channel', ['Bling']);
    await choose('module', ['Contas']);
    await choose('submodule', ['Pagar', 'Receber']);
    await page.locator('#u-nickname').fill('Gestor');
    await page.locator('#u-job-title').fill('Gerente de Projetos');
    await page.locator('#u-access-profile').selectOption('project_manager');
    assert.equal(await page.locator('#u-role').inputValue(), 'collaborator');
    assert.equal(await page.locator('#u-nickname').inputValue(), 'Gestor');
    assert.equal(await page.locator('#u-job-title').inputValue(), 'Gerente de Projetos');
    assert.equal(await page.locator('#u-auto-category .multi-picker-chip').count(), 2);
    assert.equal(await page.locator('#u-auto-submodule .multi-picker-chip').count(), 2);
    assert.equal(await page.locator('[data-permission-module="activities"] [data-permission-action="edit"]').isChecked(), true);
    assert.equal(await page.locator('[data-permission-module="users"] [data-permission-action="edit"]').isDisabled(), true);
    assert.equal(await page.locator('[data-permission-module="users"] [data-permission-action="view"]').isChecked(), true);
    const desktopSave = await page.locator('#save-user').boundingBox();
    assert.ok(desktopSave.y + desktopSave.height <= 900);
    assert.equal(await page.locator('#save-user').evaluate(el => {
      const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-access-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const save = page.locator('#save-user');
    assert.equal(await save.isVisible(), true);
    const bounds = await save.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 844);
    await page.locator('#u-auto-category').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'cms-access-mobile.png') });
    await save.click();
    await page.waitForFunction(() => Boolean(window.savedAccess));
    const saved = await page.evaluate(() => window.savedAccess);
    assert.equal(saved.action, 'save-user');
    assert.equal(saved.body.role, 'collaborator');
    assert.equal(saved.body.access_profile, 'project_manager');
    assert.deepEqual(saved.body.auto_assignment_categories, ['Financeiro', 'Fiscal']);
    assert.deepEqual(saved.body.auto_assignment_submodules, ['Pagar', 'Receber']);
    assert.equal(saved.body.permissions.users.edit, false);
    assert.equal(saved.body.password, '');
    await page.evaluate(id => {
      currentProfile = cache.users.find(user => user.id === id); closeModal(); openRegistrationsModal('users');
    }, employeeId);
    assert.equal(await page.locator('#registration-add').count(), 0);
    assert.equal(await page.locator('.reg-user-edit').count(), 0);
    const headers = await page.locator('#registrations-root th').allTextContents();
    for (const label of ['Tipo de usuário', 'Perfil de acesso', 'Categoria', 'Canal', 'Módulo', 'Submódulo']) assert.ok(headers.includes(label));
    assert.equal(await page.evaluate(() => currentProfile.role), 'collaborator');
    assert.deepEqual(errors, []);
    console.log('Access browser passed: multi-select persistence, manager preset without type change, captured save payload, admin-only account editing, table columns and desktop/mobile screenshots.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
