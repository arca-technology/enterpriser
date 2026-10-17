const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'');
const source=fs.readFileSync(path.join(root,'app.js'),'utf8').replace(/^startApp\(\);/m,'');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()!=='GET')writes.push(request.url());});
    await page.route('**/*',route=>route.request().url()==='http://result-modules.localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
    await page.goto('http://result-modules.localhost/');await page.evaluate(()=>{window.CRM_CONFIG={};});
    for(const file of ['public/legacy/navigation-icons.js','vendor/d3-hierarchy.min.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:source});
    await page.evaluate(async()=>{
      await loadAll();document.getElementById('boot-gate')?.remove();hideLogin();currentUserIsAdmin=()=>true;
      currentProfile={id:'module-admin',role:'admin',status:'active'};
      saveProductObjectives([]);saveProductGoals([]);saveDeliveryObjectives([]);saveDeliveryGoals([]);saveProjectTasks([]);
      saveProductActivities([{id:'mod1',product_id:'pr1',activity:'Referencia 1',module:'Financeiro',submodule:'Contas a pagar'},
        {id:'mod2',product_id:'pr1',activity:'Referencia 2',module:'Sistema',submodule:'Caixas e Bancos'}]);
      cache.projects=[{id:'delivery',product_id:'pr1',start_date:'2026-10-01',end_date:'2026-10-31'}];
      cache.projectById=Object.fromEntries(cache.projects.map(row=>[row.id,row]));render();
    });
    for(const section of ['objectives','goals']) {
      const prefix=section==='goals'?'pg':'po';
      await page.evaluate(section=>openMainPmCatalog(section),section);await page.locator('#registration-add').click();
      await page.locator(`#${prefix}-category`).fill('ERP');await page.locator(`#${prefix}-channel`).fill('BLING');
      await page.locator(`#${prefix}-module`).fill('Financeiro');await page.locator(`#${prefix}-submodule`).fill('Contas a pagar');
      await page.locator(`#${prefix}-name`).fill('CONTA ATIVA');
      if(section==='goals'){await page.locator('#pg-metric').fill('Pedidos');await page.locator('#pg-target').fill('1');}
      for(const width of [1440,390,360]) {
        await page.setViewportSize({width,height:1000});
        const boxes={};for(const key of ['category','channel','module','submodule','name'])boxes[key]=await page.locator(`#${prefix}-${key}`).boundingBox();
        assert.equal(boxes.category.y,boxes.channel.y);assert.equal(boxes.module.y,boxes.submodule.y);
        assert.ok(boxes.category.y<boxes.module.y&&boxes.module.y<boxes.name.y);
        const radios=await page.locator(`#${prefix}-structure-type label`).evaluateAll(labels=>labels.map(label=>label.getBoundingClientRect().top));
        assert.ok(radios.every(y=>Math.abs(y-radios[0])<1),'Structure choices must be on one line');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.screenshot({path:path.join(os.tmpdir(),`${section}-module-form-${width}.png`)});
      }
      await page.locator(`#${prefix}-structure-type input[value="alternatives"]`).check();
      await page.locator(`#${prefix}-structure-group`).fill('Abertura de conta');
      await page.locator(`#${prefix}-save`).click();await page.waitForFunction(()=>!productGoalSavePending&&!productObjectiveSavePending);
      const saved=await page.evaluate(section=>{
        const row=(section==='goals'?loadProductGoals():loadProductObjectives())[0];
        const execution=(section==='goals'?loadDeliveryGoals():loadDeliveryObjectives()).find(item=>item.source_template_id===row.id);
        execution.status='done';execution.schedule_manual=true;execution.due_date='2026-10-08';
        if(section==='goals')saveDeliveryGoals([execution]);else saveDeliveryObjectives([execution]);
        return {id:row.id,fields:[row.module,row.submodule,execution.module,execution.submodule],remote:toRemoteBody(section==='goals'?'productGoals':'productObjectives',{module:row.module,submodule:row.submodule})};
      },section);
      assert.deepEqual(saved.fields,['Financeiro','Contas a pagar','Financeiro','Contas a pagar']);
      assert.deepEqual(saved.remote,{module_name:'Financeiro',submodule_name:'Contas a pagar'});
      await page.evaluate(({section,id})=>openRegistrationTemplateEditor(section,'pr1',id),{section,id:saved.id});
      assert.equal(await page.locator(`#${prefix}-module`).inputValue(),'Financeiro');
      await page.locator(`#${prefix}-submodule`).fill('Caixas e Bancos');await page.locator(`#${prefix}-save`).click();
      await page.waitForFunction(()=>!productGoalSavePending&&!productObjectiveSavePending);
      assert.deepEqual(await page.evaluate(section=>{const item=(section==='goals'?loadDeliveryGoals():loadDeliveryObjectives())[0];return [item.submodule,item.status,item.due_date];},section),['Caixas e Bancos','done','2026-10-08']);
      await page.evaluate(()=>{registrationMindMapLayout='organogram';registrationTableState().view='mindmap';renderRegistrationsSection();});
      const labels=await page.locator('.registration-mind-toggle strong').allTextContents();
      for(const label of ['ERP','BLING','Financeiro','Caixas e Bancos'])assert.ok(labels.includes(label),`Map group ${label}`);
      await page.locator('.registration-mind-layout').click();await page.waitForSelector('[data-radial-ready="true"]');
      assert.deepEqual(await page.locator('.registration-mind-task-copy strong .radial-title-segment').allTextContents(),['ERP','BLING','Financeiro','Caixas e Bancos','CONTA ATIVA']);
      await page.setViewportSize({width:1440,height:1000});
      await page.evaluate(()=>{registrationTableState().view='table';renderRegistrationsSection();});await page.locator('#registration-add').click();
      await page.locator(`#${prefix}-name`).fill('TREINAMENTO');await page.locator(`#${prefix}-category`).fill('ERP');await page.locator(`#${prefix}-channel`).fill('BLING');
      if(section==='goals'){await page.locator('#pg-metric').fill('Pedidos');await page.locator('#pg-target').fill('1');}
      for(const [key,values]of [['module',['Financeiro','Sistema']],['submodule',['Contas a pagar','Caixas e Bancos']]]){
        await page.locator(`#${prefix}-vary-${key}`).check();await page.locator(`#${prefix}-variants-${key} .multi-picker-control`).click();
        for(const value of values)await page.locator(`#${prefix}-variants-${key} [data-value="${value}"]`).click();
        await page.locator(`#${prefix}-name`).click();
      }
      assert.equal(await page.locator(`#${prefix}-variation-preview .task-variation-preview-list>div`).count(),4);
      await page.locator(`#${prefix}-save`).click();await page.waitForFunction(()=>!productGoalSavePending&&!productObjectiveSavePending);
      const children=await page.evaluate(section=>(section==='goals'?loadProductGoals():loadProductObjectives()).filter(row=>row.variation_parent_id).map(row=>({id:row.id,module:row.module,submodule:row.submodule})),section);
      assert.equal(children.length,4);assert.equal(new Set(children.map(child=>`${child.module}|${child.submodule}`)).size,4);
      await page.evaluate(({section,id})=>openRegistrationTemplateEditor(section,'pr1',id),{section,id:children[0].id});
      for(const key of ['module','submodule'])assert.equal(await page.locator(`#${prefix}-${key}`).isDisabled(),true);
      await page.locator(`#${prefix}-cancel`).click();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    console.log('Result modules passed: ordered paired fields, inline structure choices, responsive drawers, persistence/remapping, locked variation fields, module/submodule combinations, map groups and execution history preservation.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
