const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['currentUserOwnsOperational', 'visibleOperationalTasks', 'canEditOperational', 'requireOperationalOwnership', 'canCorrectTaskDates', 'normalizeIdList', 'normalizeTextList']);
const code = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(tree)).join('\n');
const profile = { id: 'me', role: 'collaborator', status: 'active', job_title: 'Gestor' };
const tasks = [
  { id: 'mine', project_id: 'p1', owner_id: 'me', dependency_ids: ['prerequisite'], parent_activity_id: 'parent' },
  { id: 'prerequisite', project_id: 'p1', owner_id: 'other', dependency_ids: ['ancestor', 'foreign'] },
  { id: 'ancestor', project_id: 'p1', owner_id: 'other', dependency_ids: ['prerequisite'] },
  { id: 'parent', project_id: 'p1', owner_id: 'other' },
  { id: 'foreign', project_id: 'p2', owner_id: 'other' },
  { id: 'unrelated', project_id: 'p1', owner_id: 'other' },
  { id: 'shared', project_id: 'p1', owner_id: 'other', assignee_ids: ['me', 'other'] },
  { id: 'job', project_id: 'p1', assignee_job_titles: ['GESTOR'] },
];
const context = vm.createContext({ currentProfile: profile, isLive: () => true, currentUserIsAdmin: () => context.currentProfile.role === 'admin',
  currentUserCan: (_module, action) => context.currentProfile.role !== 'developer' || action === 'view',
  workspaceIdentity: { task_date_migration_enabled: true }, cache: { activityRecords: tasks, deliveryGoals: [{ id: 'other-goal', owner_id: 'other' }] } });
vm.runInContext(code, context);
assert.deepEqual(Array.from(context.visibleOperationalTasks(tasks), (task) => task.id), ['mine', 'prerequisite', 'ancestor', 'parent', 'shared', 'job']);
assert.equal(context.canEditOperational('activities', tasks[0]), true);
assert.equal(context.currentUserOwnsOperational({ owner_id: 'me', assignee_ids: ['other'] }), true);
assert.equal(context.canEditOperational('activities', tasks[1]), false);
assert.throws(() => context.requireOperationalOwnership('activities', 'prerequisite'), /somente para consulta/);
assert.throws(() => context.requireOperationalOwnership('deliveryGoals', 'other-goal'), /somente para consulta/);
assert.throws(() => context.requireOperationalOwnership('activities', 'mine', { owner_id: 'other', assignee_ids: [] }), /Mantenha/);
assert.equal(context.canCorrectTaskDates(tasks[0]), true);
context.workspaceIdentity.task_date_migration_enabled = false;
assert.equal(context.canCorrectTaskDates(tasks[0]), false);
context.currentProfile = { ...profile, role: 'admin' };
assert.equal(context.canCorrectTaskDates(tasks[1]), true);
assert.equal(context.visibleOperationalTasks(tasks).length, tasks.length);
context.currentProfile = { ...profile, role: 'developer' };
assert.equal(context.canEditOperational('activities', tasks[0]), false);
assert.equal(context.visibleOperationalTasks(tasks).length, tasks.length);
console.log('Ownership passed: own/shared/job assignments, prerequisite/parent closure, cycles, cross-delivery isolation, read-only dependencies/results, retained responsibility, migration flag, admin and developer scopes.');
