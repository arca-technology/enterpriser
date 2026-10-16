const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const statusCode = source.match(/const TASK_STATUS = \[[^]*?\];/)[0];
const flowCode = source.slice(source.indexOf('function taskStatusTransitionError('), source.indexOf('function taskDependencies('));
const context = vm.createContext({ currentUserIsAdmin: () => false });
vm.runInContext(statusCode + '\n' + flowCode + '\nthis.isLocked = taskStatusLocked;', context);
for (const admin of [false, true]) {
  context.currentUserIsAdmin = () => admin;
  for (const [from, allowed] of [['todo', ['todo', 'doing', 'canceled']], ['doing', ['doing', 'done', 'canceled']], ['done', ['done']]]) {
    for (const to of ['todo', 'doing', 'done', 'canceled']) assert.equal(!context.taskStatusTransitionError(from, to), allowed.includes(to), `${admin}: ${from} -> ${to}`);
    const options = [...context.taskStatusOptions(from, false, true).matchAll(/value="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(options, allowed);
  }
  assert.equal(context.isLocked({ status: 'done' }), true);
  assert.equal(context.isLocked({ status: 'todo' }), false);
  assert.equal(context.isLocked({ status: 'canceled' }), false);
  assert.equal(context.taskStatusTransitionError('canceled', 'doing'), '');
  for (const status of ['todo', 'done']) assert.equal(!context.taskStatusTransitionError('canceled', status), admin);
}
assert(context.taskStatusOptions('todo', true, true).includes('value="doing" disabled'));
assert(!context.taskStatusOptions('todo', true, true).includes('value="canceled" disabled'));
assert.equal([...context.taskStatusOptions('done').matchAll(/<option/g)].length, 4, 'Objectives and goals keep their existing status options');
vm.runInContext(source.match(/function inlineTaskStatus\([^]*?^}/m)[0], context);
Object.assign(context, { currentUserCan: () => true, canEditOperational: () => true, taskStatusClass: (s) => s, esc: String, taskIsBlocked: () => false });
assert(context.inlineTaskStatus({ id: 'finished', status: 'done' }).includes(' disabled'));
assert(!context.inlineTaskStatus({ id: 'open', status: 'todo' }).includes(' disabled'));
vm.runInContext(source.match(/async function updateProjectTask\([^]*?^}/m)[0], context);
vm.runInContext(source.match(/function taskDateRangeError\([^]*?^}/m)[0], context);
vm.runInContext(source.match(/const TASK_TEMPLATE_IDENTIFICATION_FIELDS = \[[^]*?\];/)[0], context);
const task = { id: 'task', project_id: 'project', status: 'todo' };
let writes = 0;
Object.assign(context, {
  requireCurrentUserPermission: () => true, loadProjectTasks: () => [task], operationalProjectTasks: () => [task],
  isLive: () => false, saveProjectTasks: () => { writes += 1; }, refreshActivityCache: () => {},
  recalculateDependencySchedules: async () => {}, toast: () => {}
});
(async () => {
  context.currentUserIsAdmin = () => false;
  assert.equal(await context.updateProjectTask('task', { status: 'done' }), false);
  assert.equal(writes, 0);
  assert.equal(await context.updateProjectTask('task', { status: 'doing' }), true);
  assert(task.actual_start_date);
  assert.equal(await context.updateProjectTask('task', { status: 'done' }), true);
  assert(task.actual_end_date);
  for (const status of ['todo', 'doing', 'canceled']) assert.equal(await context.updateProjectTask('task', { status }), false);
  assert.equal(writes, 2);
  assert.equal(task.status, 'done');
  task.status = 'canceled';
  assert.equal(await context.updateProjectTask('task', { status: 'doing' }), true);
  assert.equal(task.status, 'doing');
  task.status = 'canceled';
  context.taskIsBlocked = () => true;
  context.taskDependencies = () => [{ status: 'todo' }];
  context.activityDisplayName = () => 'Dependency';
  assert.equal(await context.updateProjectTask('task', { status: 'doing' }), false);
  assert.equal(task.status, 'canceled');
  context.canEditOperational = () => false;
  context.taskIsBlocked = () => false;
  assert.equal(await context.updateProjectTask('task', { status: 'doing' }), false, 'Cannot reopen someone else\'s read-only task');
  context.canEditOperational = () => true;
  task.source_template_id = 'model';
  const beforeWrites = writes;
  assert.equal(await context.updateProjectTask('task', { category: 'Other' }), false);
  task.planned_start_date = '2026-10-10';
  task.planned_end_date = '2026-10-20';
  assert.equal(await context.updateProjectTask('task', { planned_end_date: '2026-10-01' }), false);
  assert.equal(await context.updateProjectTask('task', { actual_end_date: '2020-01-01' }), false);
  assert.equal(writes, beforeWrites, 'Invalid bulk/inline changes must not write');
  assert.equal(await context.updateProjectTask('task', { planned_end_date: '2026-10-21' }), true);
  delete task.source_template_id;
  assert.equal(await context.updateProjectTask('task', { category: 'Manual category' }), true);
  console.log('Task transitions, terminal admin lock, dropdown options, real dates and rejected updates passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
