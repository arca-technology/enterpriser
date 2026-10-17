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
    await page.route('**/*', route => route.request().url() === 'http://map.localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://map.localhost/');
    await page.evaluate(() => { window.CRM_CONFIG = {}; });
    for (const file of ['public/legacy/navigation-icons.js', 'vendor/d3-hierarchy.min.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
    await page.addScriptTag({ content: source });
    await page.evaluate(async () => {
      await loadAll(); document.getElementById('boot-gate')?.remove(); hideLogin();
      currentUserIsAdmin = () => true; currentProfile = { id: 'map-admin', role: 'admin', status: 'active' };
      const models = [
        { id: 'base', name: 'MERCADO ENVIOS' },
        { id: 'places', name: 'PLACES', structure_type: 'alternatives', structure_group: 'Modalidade' },
        { id: 'coletas', name: 'COLETAS', structure_type: 'alternatives', structure_group: 'Modalidade' },
        { id: 'gold', name: 'GOLD', structure_type: 'progression', structure_group: 'Mercado Lider', structure_order: 2 },
        { id: 'silver', name: 'SILVER', structure_type: 'progression', structure_group: 'Mercado Lider', structure_order: 1 },
        { id: 'platinum', name: 'PLATINUM', structure_type: 'progression', structure_group: 'Mercado Lider', structure_order: 3 }
      ].map(item => ({ product_id: 'pr1', category: 'Canais de venda', channel: 'MERCADO LIVRE', activity: item.name, metric: 'Pedidos', target_value: 1,
        dependency_template_ids: ['places','coletas'].includes(item.id) ? ['base'] : [],
        dependency_goal_template_ids: ['places','coletas'].includes(item.id) ? ['base'] : [],
        dependency_objective_template_ids: ['places','coletas'].includes(item.id) ? ['base'] : [], ...item }));
      saveProductActivities(models); saveProductGoals(models); saveProductObjectives(models);
      saveProjectTasks([]); saveDeliveryGoals([]); saveDeliveryObjectives([]);
      window.modelSnapshot = JSON.stringify([loadProductActivities(), loadProductGoals(), loadProductObjectives()]);
      render();
    });
    for (const section of ['activities', 'goals', 'objectives']) {
      await page.evaluate(section => { registrationMindMapLayout = 'organogram'; registrationMindMapZoom = 1; openMainPmCatalog(section); }, section);
      await page.locator('#registration-view-menu-btn').click();
      assert.deepEqual(await page.locator('#registration-view-dd [data-view]').evaluateAll(options => options.map(option => option.dataset.view)), ['table', 'list', 'mindmap']);
      assert.equal(await page.locator('#registration-view-dd [data-view="mindmap"]').innerText().then(s => s.includes('Mapa mental')), false);
      await page.locator('#registration-view-dd [data-view="list"]').click();
      assert.equal(await page.locator('table.explicit-list-view').count(), 1);
      assert.ok(await page.locator('table .mobile-record-title').first().isVisible());
      assert.equal(await page.locator('.list-view-controls select').isVisible(), true);
      await page.locator('#registration-view-menu-btn').click(); await page.locator('#registration-view-dd [data-view="mindmap"]').click();
      assert.equal(await page.locator('.structure-alternatives .registration-mind-task').count(), 2);
      assert.equal(await page.locator('.structure-progression .registration-mind-task').count(), 3);
      const progression = await page.locator('.structure-progression .registration-mind-task-copy strong').allTextContents();
      assert.ok(progression[0].includes('SILVER') && progression[1].includes('GOLD') && progression[2].includes('PLATINUM'));
      assert.equal(await page.locator('.structure-progression [aria-label="Progressão reversível"]').count(), 2);
      await page.screenshot({ path: path.join(os.tmpdir(), `map-organogram-${section}.png`) });
      await page.locator('.registration-mind-layout').click();
      await page.waitForSelector('.registration-mindmap-shell[data-radial-ready="true"]');
      assert.ok(await page.locator('.radial-hierarchy-link').count() >= 6);
      assert.equal(await page.locator('.radial-progression-link').count(), 2);
      const boxes = await page.locator('.radial-map-node').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,text:node.textContent }; }));
      for (let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
        const a=boxes[i],b=boxes[j]; assert.ok(a.right<=b.left+1 || b.right<=a.left+1 || a.bottom<=b.top+1 || b.bottom<=a.top+1, `Radial collision: ${a.text} / ${b.text}`);
      }
      await page.locator('.registration-mind-fit').click();
      await page.screenshot({ path: path.join(os.tmpdir(), `map-radial-${section}.png`) });
      for (const width of [390,360]) {
        await page.setViewportSize({ width, height:844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth>innerWidth), false);
        await page.locator('.registration-mind-fit').click();
        const controls=await page.locator('.registration-mind-controls').boundingBox();
        assert.ok(controls.x>=0 && controls.x+controls.width<=width);
        await page.screenshot({ path: path.join(os.tmpdir(), `map-radial-${section}-${width}.png`) });
      }
      await page.setViewportSize({ width:1440,height:1000 });
      await page.locator('.registration-mind-layout').click();
      assert.equal(await page.locator('.registration-mindmap-shell.is-radial').count(),0);
    }
    assert.equal(await page.evaluate(() => JSON.stringify([loadProductActivities(),loadProductGoals(),loadProductObjectives()])===modelSnapshot),true);
    // Old saved Flow choices resolve to Map, without preserving a second view.
    await page.evaluate(() => { registrationTableState().view='flow'; renderRegistrationsSection(); });
    assert.equal(await page.locator('.registration-mindmap-shell').count(),1);
    for (const section of ['activities','goals','objectives']) {
      const prefix=section==='activities'?'pa':section==='goals'?'pg':'po';
      await page.evaluate(section => openRegistrationTemplateEditor(section,'pr1','gold'),section);
      assert.equal(await page.locator(`#${prefix}-structure-type`).inputValue(),'progression');
      assert.equal(await page.locator(`#${prefix}-structure-order`).inputValue(),'2');
      await page.locator(`#${prefix}-structure-type`).selectOption('alternatives');
      assert.equal(await page.locator(`#${prefix}-structure-order`).isVisible(),false);
      await page.locator(`#${prefix}-structure-group`).fill('Outro grupo');
      await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(() => !productActivitySavePending && !productGoalSavePending && !productObjectiveSavePending);
      assert.deepEqual(await page.evaluate(section => { const row=(section==='activities'?loadProductActivities():section==='goals'?loadProductGoals():loadProductObjectives()).find(row=>row.id==='gold');return [row.structure_type,row.structure_group,row.structure_order]; },section),['alternatives','Outro grupo',0]);
    }
    await page.evaluate(() => { state.tab='contacts';state.view='list';render(); });
    assert.equal(await page.locator('table.explicit-list-view').count(),1);
    await page.locator('#view-menu-btn').click();
    assert.deepEqual((await page.locator('#view-dd [data-view]').evaluateAll(options=>options.map(option=>option.dataset.view))).slice(0,2),['table','list']);
    await page.evaluate(() => closeFloaters());
    for (const tab of ['contacts','companies','conversations','deals','projects','activities','goals','objectives']) {
      await page.evaluate(tab => { state.tab=tab;state.pmScopes[tab]='execution';state.view='list';render(); },tab);
      assert.equal(await page.locator('#main table.explicit-list-view').count(),1,`${tab}: execution list`);
    }
    await page.evaluate(() => openProductActivities('pr1'));
    for (const section of ['activities','goals','objectives']) {
      await page.locator(`[data-product-tab="${section}"]`).click();
      await page.locator('.product-view-menu-btn').click();
      await page.locator('#product-view-dd [data-view="list"]').click();
      assert.equal(await page.locator('#product-activities-root table.explicit-list-view').count(),1);
    }
    await page.evaluate(() => openToolsModal('files'));
    await page.locator('#tools-root .view-menu-trigger').click();
    await page.locator('#view-dd [data-view="list"]').click();
    assert.equal(await page.locator('#tools-root table.explicit-list-view').count(),1);
    await page.screenshot({ path:path.join(os.tmpdir(),'map-list-tools-desktop.png') });
    assert.deepEqual(errors,[]); assert.deepEqual(writes,[]);
    console.log('Map/list passed: three catalogs, explicit alternative groups, ordered reversible levels, radial geometry without overlaps, desktop/mobile controls, persisted structure fields, legacy Flow fallback, unchanged source data and no network writes.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
