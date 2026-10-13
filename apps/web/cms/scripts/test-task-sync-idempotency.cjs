const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['syncProductActivities', 'syncProductActivitiesOnce', 'upsertTaskRecord', 'uniqueTaskRecords',
  'normalizeIdList', 'normalizeTextList', 'activityOccurrenceSort', 'isGenericOnboardingTask', 'findDeliveryDuplicate']);
const code = tree.statements.filter(node => (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.text === 'productActivitySyncQueue')))
  .map(node => node.getText(tree)).join('\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function scenario({ conflict = false, failure = false } = {}) {
  const template = { id: 'template', product_id: 'product', activity: 'ONBOARDING', category: 'Projeto', type: 'Reuniao', recurrence: 'once' };
  let creates = 0;
  const stored = new Map();
  const context = vm.createContext({ accountEpoch: 0, cache: { projects: [{ id: 'delivery', product_id: 'product', start_date: '2026-10-13' }], activityRecords: [] },
    crypto: { randomUUID: () => 'draft-'+creates }, loadProductActivities: () => [template],
    loadProjectTasks: () => context.cache.activityRecords, projectTaskEnabled: () => true, loadDeliveryObjectives: () => [],
    activityOccurrenceDates: () => [null], monthlyDeadlineRange: () => null, taskSetupRequirements: () => [],
    mergeTemplateChecklist: () => [], normalizeChecklist: () => [], isLive: () => true,
    updateRow: async (_table, id, body) => Object.assign(stored.get(id) || {}, body),
    createActivityOrLoadExisting: async body => {
      creates++;
      await sleep(10);
      if (failure && creates === 1) throw new Error('fixture failure');
      const saved = { ...body, id: 'persisted', assignee_ids: ['owner'] };
      stored.set(saved.id, saved);
      if (conflict) context.cache.activityRecords.push(saved);
      return saved;
    }, recalculateDependencySchedules: async () => {}, syncDeliveryObjectiveDependencies: async () => {}, syncDeliveryGoalDependencies: async () => {} });
  vm.runInContext(code, context);
  if (failure) {
    await assert.rejects(context.syncProductActivities(), /fixture failure/);
    await context.syncProductActivities();
  } else {
    await Promise.all([context.syncProductActivities(), context.syncProductActivities(), context.syncProductActivities()]);
    assert.equal(creates, 1, 'Concurrent synchronization must only create one task');
  }
  assert.equal(context.cache.activityRecords.length, 1, 'A recovered existing task must not be appended twice');
  assert.equal(stored.size, 1);
  assert.equal(context.cache.activityRecords[0].assignee_ids[0], 'owner');
  await context.syncProductActivities();
  assert.equal(context.cache.activityRecords.length, 1);
}
(async () => {
  const helpers = vm.createContext({});
  vm.runInContext(code, helpers);
  const onboarding = { title: ' ONBOARDING ', category: 'Projeto', type: 'Reunião' };
  assert.equal(helpers.isGenericOnboardingTask(onboarding), true);
  for (const changed of [{ title: 'Onboarding fiscal' }, { module: 'ERP' }, { category: 'Financeiro' },
    { recurrence: 'monthly' }, { parent_activity_id: 'parent' }, { parent_template_id: 'parent' }]) {
    assert.equal(helpers.isGenericOnboardingTask({ ...onboarding, ...changed }), false);
  }
  const old = { id: 'old', company_id: '12.345.678/0001-90', product_id: 'product', client_name: 'Cliente', start_date: '2026-10-01', end_date: '2027-03-31' };
  assert.equal(helpers.findDeliveryDuplicate([old], { ...old, id: undefined, company_id: '12345678000190', client_name: ' cliente ' }).id, 'old');
  for (const changed of [{ start_date: '2027-04-01' }, { end_date: '2027-09-30' }, { product_id: 'other' },
    { client_name: 'Other' }, { company_id: '99999999000100' }, { continuation_of_id: 'old' }]) {
    assert.equal(helpers.findDeliveryDuplicate([old], { ...old, id: undefined, ...changed }), null);
  }
  assert.equal(helpers.findDeliveryDuplicate([old], old), null);
  const duplicateIds = [{ id: 'a', status: 'todo' }, { id: 'a', status: 'done' }, { id: 'b', status: 'todo' }];
  assert.equal(helpers.uniqueTaskRecords(duplicateIds).length, 2);
  assert.equal(helpers.uniqueTaskRecords(duplicateIds)[0].status, 'done');
  await scenario();
  await scenario({ conflict: true });
  await scenario({ failure: true });
  console.log('Task sync passed: concurrent calls, replayed existing responses, preserved assignments, repeated refresh and recovery after failure.');
})().catch(error => { console.error(error); process.exitCode = 1; });
