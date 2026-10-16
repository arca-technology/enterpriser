const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['taskWithCurrentTemplate', 'taskDateRangeError', 'productTemplateGroupMembers',
  'productTemplateGroupAmbiguous', 'productTemplateGroupKey', 'copiedTemplateGroupId', 'productTemplateRemovalError',
  'productActivityIdentity', 'normalizeIdList']);
const code = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.text === 'activityDisplayName'))
  .map(node => node.getText(tree)).join('\n');
let templates = [], tasks = [], objectives = [], goals = [];
const context = vm.createContext({
  loadProductActivities: () => templates, loadProjectTasks: () => tasks,
  loadProductObjectives: () => objectives, loadProductGoals: () => goals,
  taskSetupRequirements: row => row.required_setup || [],
  normalizeSetupConfiguration: value => value || {}, setupProductTypes: value => value || [],
  crypto: { randomUUID: () => 'new-group' }
});
vm.runInContext(code + '\nglobalThis.activityDisplayName = activityDisplayName;', context);
const plain = value => JSON.parse(JSON.stringify(value));
const model = { id: 'model', activity: '', category: 'ERP', channel: 'BLING', module: 'Vendas', type: 'Treinamento',
  required_setup: ['BLING'], requires_retroactive: true };
templates = [model];
const raw = { id: 'execution', source_template_id: model.id, title: 'Obsolete title', activity: 'Obsolete alias',
  category: 'Obsolete category', status: 'doing', assignee_ids: ['owner'], due_date: '2026-10-01',
  planned_start_date: '2026-09-01', priority: 'high', notes: 'History', checklist: [{ id: 'step', checked: true }],
  dependency_ids: ['other-task'] };
const snapshot = plain(raw);
const projected = context.taskWithCurrentTemplate(raw);
assert.equal(projected.title, '');
assert.equal(projected.activity, '');
assert.equal(context.activityDisplayName(raw), 'ERP | BLING | Vendas | Treinamento');
for (const key of ['status', 'assignee_ids', 'due_date', 'planned_start_date', 'priority', 'notes', 'checklist', 'dependency_ids']) {
  assert.deepEqual(plain(projected[key]), snapshot[key], `Operational field ${key} must remain untouched`);
}
assert.deepEqual(raw, snapshot, 'Reading must never mutate the stored execution');
model.activity = 'Current name';
assert.equal(context.taskWithCurrentTemplate(raw).title, 'Current name');
model.activity = null;
assert.equal(context.taskWithCurrentTemplate(raw).title, '', 'Null names must not resurrect old titles');
const manual = { title: 'Manual', category: 'Custom' };
assert.equal(context.taskWithCurrentTemplate(manual), manual);
const orphan = { ...raw, source_template_id: 'missing' };
assert.equal(context.taskWithCurrentTemplate(orphan), orphan);
const a = { id: 'a', product_id: 'p1', template_group_id: 'broken', activity: 'Vendas' };
const b = { id: 'b', product_id: 'p1', template_group_id: 'broken', activity: '', module: 'Vendas' };
const childA = { id: 'ca', product_id: 'p1', template_group_id: 'children', activity: 'Frente de Caixa', parent_template_id: 'a' };
const childB = { id: 'cb', product_id: 'p1', template_group_id: 'children', activity: 'Frente de Caixa', parent_template_id: 'b' };
templates = [a, b, childA, childB];
assert.notEqual(context.productTemplateGroupKey(a), context.productTemplateGroupKey(b));
assert.notEqual(context.productTemplateGroupKey(childA), context.productTemplateGroupKey(childB));
assert.notEqual(context.productActivityIdentity(childA), context.productActivityIdentity(childB), 'Different parents are not duplicates');
const counterpart = { ...a, id: 'a2', product_id: 'p2' };
const childCounterpart = { ...childA, id: 'ca2', product_id: 'p2', parent_template_id: 'a2' };
templates = [a, childA, counterpart, childCounterpart];
assert.equal(context.productTemplateGroupKey(a), context.productTemplateGroupKey(counterpart));
assert.equal(context.productActivityIdentity(childA), context.productActivityIdentity(childCounterpart));
assert.equal(context.copiedTemplateGroupId(a, []), 'broken');
assert.equal(context.copiedTemplateGroupId(a, [b]), 'new-group');
templates = [{ ...a, parent_template_id: 'a' }];
assert.doesNotThrow(() => context.productActivityIdentity(templates[0]), 'Malformed cycles must not overflow');
templates = [a, b];
assert.equal(context.productTemplateRemovalError(['a']), '');
tasks = [{ source_template_id: 'a', status: 'done' }];
assert.ok(context.productTemplateRemovalError(['a']));
tasks = [];
templates.push({ id: 'dependency', dependency_template_ids: ['a'] });
assert.ok(context.productTemplateRemovalError(['a']));
templates.pop();
objectives = [{ dependency_activity_template_ids: ['a'] }];
assert.ok(context.productTemplateRemovalError(['a']));
objectives = [];
goals = [{ dependency_activity_template_ids: ['a'] }];
assert.ok(context.productTemplateRemovalError(['a']));
const dates = { planned_start_date: '2026-10-10', planned_end_date: '2026-10-20', actual_start_date: '2026-10-01' };
assert.ok(context.taskDateRangeError(dates, { planned_end_date: '2026-10-09' }));
assert.ok(context.taskDateRangeError(dates, { actual_end_date: '2026-09-30' }));
assert.ok(context.taskDateRangeError({ due_date: '2026-09-01' }, { planned_start_date: '2026-10-01' }));
assert.equal(context.taskDateRangeError(dates, { planned_end_date: '2026-10-10', actual_end_date: '2026-10-01' }), '');
assert.equal(context.taskDateRangeError({ ...dates, planned_end_date: '2026-01-01' }, { priority: 'high' }), '');
assert.equal(context.taskDateRangeError(dates, { planned_start_date: null }), '');
console.log('Template integrity passed: canonical structural labels, operational isolation, parent-aware identity, group collision safety, relationship guards and chronological validation.');
