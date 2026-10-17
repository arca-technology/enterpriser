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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    await page.route('**/*', route => route.request().url() === 'http://result-links.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://result-links.localhost/'); await page.evaluate(() => { window.CRM_CONFIG = {}; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/legacy/navigation-icons.js'), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true; currentProfile = { id: 'link-admin', role: 'admin', status: 'active' };
      cache.products = ['pr1', 'pr2', 'pr3'].map((id, i) => ({ id, name: `Produto ${i + 1}` }));
      cache.productById = Object.fromEntries(cache.products.map(row => [row.id, row]));
      cache.projects = []; cache.projectById = {}; saveProductActivities([]);
      saveProductGoals([]); saveProductObjectives([]); saveProjectTasks([]); saveDeliveryGoals([]); saveDeliveryObjectives([]); render();
    });
    for (const section of ['objectives', 'goals']) {
      const prefix = section === 'goals' ? 'pg' : 'po';
      await page.evaluate(section => openMainPmCatalog(section), section); await page.locator('#registration-add').click();
      await page.locator(`#${prefix}-name`).fill('CONTA ATIVA');
      await page.locator(`#${prefix}-category`).fill('ERP'); await page.locator(`#${prefix}-channel`).fill('BLING');
      await page.locator(`#${prefix}-module`).fill('Financeiro'); await page.locator(`#${prefix}-submodule`).fill('Caixas');
      if (section === 'goals') { await page.locator('#pg-metric').fill('Pedidos'); await page.locator('#pg-target').fill('1'); }
      await page.locator(`#${prefix}-products .multi-picker-control`).click();
      await page.locator(`#${prefix}-products [data-value="pr2"]`).click();
      await page.locator(`#${prefix}-name`).click(); await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(() => !productGoalSavePending && !productObjectiveSavePending);
      const originals = await page.evaluate(section => resultTemplateRows(section).map(row => ({ id: row.id, product: row.product_id, group: row.template_group_id })), section);
      assert.equal(originals.length, 2); assert.equal(new Set(originals.map(row => row.group)).size, 1);
      assert.equal(await page.locator('#registrations-root tbody tr[data-id]').count(), 1);
      assert.ok((await page.locator('#registrations-root tbody td[data-registration-key="c1"]').innerText()).includes('Produto 1, Produto 2'));
      await page.evaluate(({ section, id }) => openRegistrationTemplateEditor(section, 'pr1', id), { section, id: originals[0].id });
      assert.deepEqual(await page.evaluate(prefix => multiPickerValues(`${prefix}-products`).sort(), prefix), ['pr1', 'pr2']);
      await page.locator(`#${prefix}-name`).fill('CONTA PRONTA'); await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(() => !productGoalSavePending && !productObjectiveSavePending);
      assert.deepEqual(await page.evaluate(section => resultTemplateRows(section).map(row => row.name), section), ['CONTA PRONTA', 'CONTA PRONTA']);
      await page.evaluate(section => { openProductActivities('pr3'); productActivityState.tab = section; renderProductWorkspace(); }, section);
      assert.equal(await page.locator(`#product-activities-root .registration-toolbar-center #${prefix}-ready`).isVisible(), true);
      await page.locator(`#${prefix}-ready`).click();
      assert.equal(await page.locator('#ready-result-list input').count(), 1);
      await page.locator('#ready-result-list input').check(); await page.locator('#ready-result-search').fill('Nao existe');
      await page.locator('#ready-result-search').fill(''); assert.equal(await page.locator('#ready-result-list input').isChecked(), true);
      await page.locator('#ready-result-add').click(); await page.waitForSelector('#ready-result-add', { state: 'detached' });
      const linked = await page.evaluate(section => resultTemplateRows(section), section);
      assert.equal(linked.length, 3); assert.equal(new Set(linked.map(row => row.template_group_id)).size, 1);
      for (const row of originals) assert.ok(linked.some(item => item.id === row.id));
      await page.locator(`#${prefix}-ready`).click(); assert.equal(await page.locator('#ready-result-list input').count(), 0);
      await page.locator('#ready-result-cancel').click();
      await page.evaluate(section => {
        const rows = resultTemplateRows(section), save = section === 'goals' ? saveProductGoals : saveProductObjectives;
        save([...rows, { id: 'family-' + section, template_group_id: 'family-group-' + section, product_id: 'pr1', name: 'TREINAMENTO',
          category: 'ERP', module: 'Sistema', metric: 'Pedidos', target_value: 1, target_days: 10, variation_axes: { channel: ['BLING', 'OLIST'] } }]);
        const expanded = resultTemplateRows(section), child = expanded.find(row => row.variation_parent_id === 'family-' + section && row.channel === 'BLING');
        Object.assign(child, { comments: 'Informacao exclusiva', target_days: 4, variation_override_fields: ['comments', 'target_days'] }); save(expanded);
        renderProductWorkspace();
      }, section);
      await page.locator(`#${prefix}-ready`).click(); await page.locator(`#ready-result-list input[value="family-${section}"]`).check();
      await page.locator('#ready-result-add').click(); await page.waitForSelector('#ready-result-add', { state: 'detached' });
      const family = await page.evaluate(section => {
        const rows = resultTemplateRows(section), parent = rows.find(row => row.product_id === 'pr3' && row.name === 'TREINAMENTO' && isVariationParent(row));
        return { parent, children: rows.filter(row => row.variation_parent_id === parent.id), source: rows.filter(row => row.variation_parent_id === 'family-' + section) };
      }, section);
      assert.equal(family.children.length, 2); assert.equal(family.parent.template_group_id, 'family-group-' + section);
      const bling = family.children.find(row => row.channel === 'BLING');
      assert.equal(bling.comments, 'Informacao exclusiva'); assert.equal(bling.target_days, 4);
      assert.equal(family.children.find(row => row.channel === 'OLIST').target_days, 10);
      assert.ok(!family.source.some(row => family.children.some(child => child.id === row.id)));
      await page.evaluate(({ section, id }) => { productActivityState.tab = section; (section === 'goals' ? openProductGoalDrawer : openProductObjectiveDrawer)(id); }, { section, id: bling.id });
      assert.equal(await page.locator(`#${prefix}-products .multi-picker-control`).isDisabled(), true);
      assert.equal(await page.locator(`#${prefix}-name`).isDisabled(), true); await page.locator(`#${prefix}-cancel`).click();
      const mapping = await page.evaluate(async section => {
        saveProductActivities([
          { id: 'dependency-source', product_id: 'pr1', template_group_id: 'task-group', activity: 'Abrir conta' },
          { id: 'dependency-target', product_id: 'pr3', template_group_id: 'task-group', activity: 'Abrir conta' }
        ]);
        const source = { id: 'dependent-' + section, product_id: 'pr1', template_group_id: 'dependent-group-' + section,
          name: 'DEPENDENTE', metric: 'Pedidos', target_value: 1, dependency_activity_template_ids: ['dependency-source'] };
        const save = section === 'goals' ? saveProductGoals : saveProductObjectives;
        save([...resultTemplateRows(section), source]);
        const entry = resultTemplateLinkEntry(section, source, { ...source, id: undefined }, 'pr3', null, source.template_group_id);
        delete entry.body.id;
        await persistResultTemplateLinks(section, [entry]);
        const before = JSON.stringify(resultTemplateRows(section));
        let missing = '';
        try { remapResultDependencies({ dependency_activity_template_ids: ['dependency-source'] }, 'pr2'); } catch (error) { missing = error.message; }
        return { dependencies: resultTemplateRows(section).find(row => row.id === entry.id).dependency_activity_template_ids,
          missing, unchanged: before === JSON.stringify(resultTemplateRows(section)) };
      }, section);
      assert.deepEqual(mapping.dependencies, ['dependency-target']); assert.ok(mapping.missing.includes('ainda não vinculada')); assert.equal(mapping.unchanged, true);
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => renderProductWorkspace());
        await page.screenshot({ path: path.join(os.tmpdir(), `${section}-product-links-mobile-${width}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Result product links passed: multi-product create/edit, stable IDs, grouped catalog, linking/search, duplicate prevention, variation details, locked children, dependency remapping, missing-dependency safety and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
