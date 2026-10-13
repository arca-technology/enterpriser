const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['currentUserIsPmManager', 'accessProfileLabel', 'accessProfilePermissions', 'userAccessDraft',
  'automaticTaskRuleMatches', 'automaticTaskAssignees', 'automaticallyAssignTask', 'normalizeTextList', 'normalizeIdList',
  'defaultPermissionsForRole', 'emptyUserPermissions', 'normalizeUserPermissions', 'compareLabels']);
const constants = new Set(['ACCESS_PROFILE_LABEL', 'AUTO_ASSIGNMENT_FIELDS', 'PERMISSION_GROUPS', 'PERMISSION_ACTIONS']);
const code = tree.statements.filter(n => (ts.isFunctionDeclaration(n) && names.has(n.name?.text)) ||
  (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => constants.has(d.name.text))))
  .map(n => n.getText(tree)).join('\n');
const permissions = { activities: { view: true, operate: true } };
const user = { id: 'b', full_name: 'Bruno', role: 'collaborator', status: 'active', permissions,
  auto_assignment_categories: ['Financeiro', 'Fiscal'], auto_assignment_channels: ['Bling'],
  auto_assignment_modules: ['Contas'], auto_assignment_submodules: ['Pagar', 'Receber'] };
const task = { category: ' fiscal ', channel: 'bling', module: 'Contas', submodule: 'Receber' };
const context = vm.createContext({ currentProfile: user, cache: { users: [user] } });
vm.runInContext(code, context);
assert.equal(context.automaticTaskRuleMatches(user, task), true);
for (const field of ['category', 'channel', 'module', 'submodule']) {
  assert.equal(context.automaticTaskRuleMatches(user, { ...task, [field]: 'Other' }), false);
}
assert.equal(context.automaticTaskRuleMatches({}, task), false);
assert.equal(context.automaticTaskRuleMatches({ auto_assignment_categories: ['Fiscal'] }, task), true);
const ana = { ...user, id: 'a', full_name: 'Ana' };
assert.deepEqual(Array.from(context.automaticTaskAssignees(task, [user, ana])), ['a', 'b']);
for (const excluded of [{ ...user, status: 'inactive' }, { ...user, role: 'developer' },
  { ...user, permissions: { activities: { view: true } } }, { ...user, permissions: { activities: { operate: true } } }]) {
  assert.equal(context.automaticTaskAssignees(task, [excluded]).length, 0);
}
assert.equal(context.automaticTaskAssignees(task, [{ ...user, role: 'admin', permissions: {} }]).length, 1);
assert.equal(context.automaticallyAssignTask(task).owner_id, 'b');
for (const manual of [{ owner_id: 'manual' }, { assignee_ids: ['manual'] }, { assignee_job_titles: ['Gestor'] }, { assign_to_client: true }]) {
  const original = { ...task, ...manual };
  assert.equal(context.automaticallyAssignTask(original), original);
}
context.currentProfile = { ...user, access_profile: 'project_manager' };
assert.equal(context.currentUserIsPmManager(), true);
for (const role of ['admin', 'developer', 'client', 'supplier']) {
  assert.equal(context.currentUserIsPmManager({ ...context.currentProfile, role }), false);
}
assert.equal(context.currentUserIsPmManager({ ...context.currentProfile, status: 'inactive' }), false);
const manager = context.accessProfilePermissions('project_manager');
assert.equal(manager.activities.edit, true);
assert.equal(manager.projects.operate, true);
assert.equal(manager.users.view, true);
assert.equal(manager.users.edit, false);
assert.equal(manager.activities.delete, false);
assert.equal(manager.conversations.edit, false);
console.log('Access profiles passed: multi-select OR/AND, wildcard/inactive rules, multiple owners, preserved explicit assignment, manager role isolation and least privilege.');
