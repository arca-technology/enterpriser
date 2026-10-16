const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Set(['normalizeIdList', 'normalizeTextList', 'dateOnly', 'isoDay', 'addMonthsClamped', 'activityOccurrenceDates',
  'activityTemplateOccurrences', 'monthlyDeadlineRange', 'deliveryRetroactiveStart', 'taskSetupRequirements', 'projectTaskEnabled',
  'activatedDeliveryChannels', 'projectStoreList', 'deliveryAutoSetups', 'normalizeDeliveryChannel', 'syncProductActivitiesOnce',
  'activityOccurrenceSort', 'uniqueTaskRecords', 'upsertTaskRecord', 'mergeTemplateChecklist', 'normalizeChecklist',
  'operationalProjectTasks', 'productErpChannel', 'activityRemoteBody', 'productActivityRemoteBody', 'recalculateDependencySchedules',
  'normalizeSetupConfiguration', 'setupProductTypes', 'compareLabels', 'mergeDeliveryLogistics', 'taskWithCurrentTemplate', 'taskDateRangeError']);
const constants = new Set(['DELIVERY_CHANNEL_OPTIONS', 'DELIVERY_AUTO_SETUPS', 'DELIVERY_LOGISTICS_EXCLUSIVE_GROUPS', 'MANAGED_DELIVERY_CHANNELS', 'SETUP_PRODUCT_TYPES', 'TASK_TEMPLATE_IDENTIFICATION_FIELDS', 'addDays', 'addBusinessDays']);
const code = tree.statements.filter((node) => ts.isFunctionDeclaration(node) ? functions.has(node.name?.text)
  : ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => constants.has(d.name.text)))
  .map((node) => node.getText(tree)).join('\n');
const context = vm.createContext({ crypto: require('node:crypto').webcrypto,
  cache: { projects: [], projectById: {}, productById: {}, productActivities: [], activityRecords: [] },
  loadProductActivities: () => context.cache.productActivities,
  loadProjectTasks: () => context.cache.activityRecords, visibleOperationalTasks: (rows) => rows,
  loadDeliveryObjectives: () => [], isLive: () => false,
  saveProjectTasks: (rows) => { context.cache.activityRecords = rows; },
  canEditOperational: () => true, taskPlannedEnd: (task) => task.planned_end_date || task.due_date, refreshActivityCache: () => {},
  syncDeliveryObjectiveDependencies: async () => {}, syncDeliveryGoalDependencies: async () => {}
});
vm.runInContext(code, context);
(async () => {
  const delivery = { id: 'project', product_id: 'product', start_date: '2026-10-01', end_date: '2026-12-31', erp_platform: 'BLING' };
  const template = { id: 'retro', product_id: 'product', activity: 'Importacao historica', recurrence: 'monthly', deadline_window: 'month', requires_retroactive: true, required_setup: ['BLING'] };
  context.cache.projects = [delivery]; context.cache.projectById.project = delivery;
  context.cache.productActivities = [template, { ...template, id: 'regular', activity: 'Operacao mensal', requires_retroactive: false }];
  await context.syncProductActivitiesOnce();
  assert.equal(context.cache.activityRecords.filter((task) => task.source_template_id === 'retro').length, 0);
  const regularIds = context.cache.activityRecords.map((task) => task.id);
  Object.assign(delivery, { retroactive_enabled: true, retroactive_start_date: '2026-01-01' });
  await context.syncProductActivitiesOnce();
  const historical = context.cache.activityRecords.filter((task) => task.source_template_id === 'retro');
  assert.equal(historical.length, 9);
  assert.equal(historical[0].planned_start_date, '2026-01-01');
  assert.equal(historical[0].due_date, '2026-01-31');
  assert.equal(historical[1].due_date, '2026-02-28');
  assert.equal(historical.at(-1).due_date, '2026-09-30');
  assert.ok(historical.every((task) => task.occurrence_index < 0 && task.requires_retroactive && task.retroactive_reference_date));
  assert.equal(context.cache.activityRecords.filter((task) => regularIds.includes(task.id)).length, regularIds.length);
  const done = historical[0]; Object.assign(done, { status: 'done', actual_end_date: '2026-10-12', notes: 'Preservar', assignee_ids: ['user'] });
  const manual = historical[1]; Object.assign(manual, { schedule_manual: true, planned_start_date: '2026-10-05', due_date: '2026-10-20', planned_end_date: '2026-10-20' });
  const ids = context.cache.activityRecords.map((task) => task.id);
  await context.syncProductActivitiesOnce(); await context.syncProductActivitiesOnce();
  assert.deepEqual(context.cache.activityRecords.map((task) => task.id), ids);
  delivery.retroactive_start_date = '2025-12-01'; await context.syncProductActivitiesOnce();
  assert.equal(context.cache.activityRecords.filter((task) => task.source_template_id === 'retro').length, 10);
  assert.equal(done.status, 'done'); assert.equal(done.actual_end_date, '2026-10-12'); assert.equal(done.notes, 'Preservar');
  assert.equal(manual.due_date, '2026-10-20'); assert.equal(manual.planned_start_date, '2026-10-05');
  delivery.retroactive_start_date = '2026-02-01';
  assert.equal(context.operationalProjectTasks('project').filter((task) => task.source_template_id === 'retro').length, 8);
  delivery.retroactive_enabled = false;
  assert.equal(context.operationalProjectTasks('project').filter((task) => task.source_template_id === 'retro').length, 0);
  assert.equal(context.cache.activityRecords.filter((task) => task.source_template_id === 'retro').length, 10, 'No historical records deleted');
  for (const date of ['2026-10-01', '2026-11-01', '2026-02-30', '', null]) assert.equal(context.deliveryRetroactiveStart({ ...delivery, retroactive_enabled: true, retroactive_start_date: date }), null);
  const retro = { ...delivery, retroactive_enabled: true, retroactive_start_date: '2026-01-01' };
  assert.equal(context.activityTemplateOccurrences(retro, { ...template, recurrence: 'once' })[0].index, -1);
  assert.equal(context.activityTemplateOccurrences(retro, { ...template, recurrence: 'once' })[0].date, '2026-01-01');
  assert.equal(context.activityTemplateOccurrences({ ...retro, start_date: '2028-03-01', retroactive_start_date: '2028-02-01' }, template).length, 1);
  assert.equal(context.monthlyDeadlineRange('2028-02-01', 'month').end, '2028-02-29');
  assert.ok(context.activityTemplateOccurrences({ ...retro, start_date: '2026-01-05' }, { ...template, recurrence: 'daily', consider_business_days: true }).every((o) => ![0, 6].includes(new Date(o.date+'T12:00:00').getDay())));
  const monthKeys = context.activityTemplateOccurrences(retro, template).map((o) => o.index);
  assert.deepEqual(context.activityTemplateOccurrences({ ...retro, retroactive_start_date: '2026-01-10' }, template).map((o) => o.index), monthKeys, 'Monthly identity must not change with the day in the same month');
  context.cache.productById = { b: { name: 'BLING UP' }, o: { name: 'Olist IN' }, x: { name: '@START' }, fake: { name: 'BLINGSTON' } };
  assert.equal(context.productErpChannel(['b']), 'BLING'); assert.equal(context.productErpChannel(['o']), 'OLIST');
  assert.equal(context.productErpChannel(['b', 'o']), ''); assert.equal(context.productErpChannel(['x', 'fake']), '');
  assert.equal(context.productActivityRemoteBody(template).requires_retroactive, true);
  assert.equal(context.activityRemoteBody(done).retroactive_reference_date, done.retroactive_reference_date);
  Object.assign(manual, { schedule_manual: false, deadline_window: 'date', start_after_days: 0, dependency_ids: [context.cache.activityRecords.find((task) => task.source_template_id === 'regular').id] });
  const oldDue = manual.due_date;
  await context.recalculateDependencySchedules();
  assert.equal(manual.due_date, oldDue, 'Dependencies may block a historical task but must not move its service period into the present');
  console.log('Retroactive checks passed: opt-in gating, historical monthly dates, unchanged regular identities, replay safety, completed/manual preservation, range changes, once/business days/leap years, ERP inference and API round trips.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
