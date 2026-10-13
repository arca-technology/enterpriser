const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['resultDisplayName', 'compareLabels', 'alphabeticalOptions', 'fieldChoiceOptions', 'mainRowLabel', 'operationalSortKey', 'compareDefaultRows', 'dateOnly', 'isoDay', 'homeMessageTime', 'deliveryGoalReached', 'projectTasks']);
const code = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(tree)).join('\n');
const context = vm.createContext({ Date, activityDisplayName: (row) => row.title || '', taskPlannedEnd: (row) => row.planned_end_date || row.due_date });
vm.runInContext(code, context);
const today = '2026-10-13';
const sort = (tab, rows) => [...rows].sort((a, b) => context.compareDefaultRows(tab, a, b, today)).map((row) => row.id);
const creation = [
  { id: 'old', name: 'Ana', created_at: '2026-10-01T13:00:00Z' },
  { id: 'new', name: 'Zoe', created_at: '2026-10-13T13:00:00Z' },
  { id: 'invalid', name: 'First', created_at: 'invalid' },
];
for (const tab of ['contacts', 'companies', 'conversations', 'deals']) assert.deepEqual(sort(tab, creation), ['new', 'old', 'invalid']);
const deadlines = [
  { id: 'future', name: 'A', status: 'todo', due_date: '2026-10-20' },
  { id: 'closed', name: 'Closed', status: 'done', due_date: '2025-01-01' },
  { id: 'yesterday', name: 'Yesterday', status: 'doing', due_date: '2026-10-12' },
  { id: 'none', name: 'No date', status: 'todo' },
  { id: 'oldest', name: 'Old', status: 'todo', due_date: '2026-09-01' },
  { id: 'today', name: 'Today', status: 'todo', due_date: today },
  { id: 'invalid', name: 'Invalid', status: 'todo', due_date: 'invalid' },
];
for (const tab of ['projects', 'activities', 'goals', 'objectives']) {
  const rows = deadlines.map((row) => ({ ...row, title: row.name, ...(tab === 'projects' ? { end_date: row.due_date, status: row.status === 'done' ? 'closed' : 'active' } : {}) }));
  assert.deepEqual(sort(tab, rows), ['oldest', 'yesterday', 'today', 'future', 'invalid', 'none', 'closed']);
  assert.equal(rows[0].id, 'future', 'Sorting never mutates the source array');
}
assert.equal(context.operationalSortKey('goals', { status: 'todo', due_date: '2026-01-01', current_value: 20, target_value: 10 }, today).rank, 3);
assert.equal(context.resultDisplayName({ category: ' EMPRESA ', channel: ' Mercado Livre ', name: 'Vender mais' }), 'EMPRESA | Mercado Livre | Vender mais');
assert.equal(context.resultDisplayName({ name: 'Sem estrutura' }), 'Sem estrutura');
assert.equal(context.resultDisplayName({ category: 'Empresa', channel: '', name: 'Sem canal' }), 'Empresa | Sem canal');
const options = [{ value: 'z', label: 'Zebra' }, { value: '2', label: 'Álbum 2' }, { value: '10', label: 'Album 10' }];
assert.deepEqual(Array.from(context.alphabeticalOptions(options), (option) => option.value), ['2', '10', 'z']);
assert.equal(options[0].value, 'z');
assert.deepEqual(Array.from(context.fieldChoiceOptions({ k: 'channel', options }), (option) => option.value), ['2', '10', 'z']);
assert.deepEqual(Array.from(context.fieldChoiceOptions({ k: 'stage', options }), (option) => option.value), ['z', '2', '10'], 'Pipeline stages keep their business sequence');
const tasks = [
  { id: 'parent', title: 'Parent', planned_end_date: '2026-10-20' },
  { id: 'child', title: 'Child', parent_activity_id: 'parent', planned_end_date: '2026-09-01' },
  { id: 'other', title: 'Other', planned_end_date: '2026-10-10' },
];
context.operationalProjectTasks = () => tasks;
assert.deepEqual(Array.from(context.projectTasks('project'), (row) => row.id), ['parent', 'child', 'other'], 'The most urgent family stays together');
console.log('Module defaults passed: newest CRM records, oldest overdue PM records, future/undated/terminal ordering, attained goals, task hierarchy, structured result names, numeric/accent-aware alphabetical choices and immutable source arrays.');
