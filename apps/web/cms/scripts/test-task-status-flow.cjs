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
}
assert(context.taskStatusOptions('todo', true, true).includes('value="doing" disabled'));
assert(!context.taskStatusOptions('todo', true, true).includes('value="canceled" disabled'));
assert.equal([...context.taskStatusOptions('done').matchAll(/<option/g)].length, 4, 'Objectives and goals keep their existing status options');
vm.runInContext(source.match(/function inlineTaskStatus\([^]*?^}/m)[0], context);
Object.assign(context, { currentUserCan: () => true, canEditOperational: () => true, taskStatusClass: (s) => s, esc: String, taskIsBlocked: () => false });
assert(context.inlineTaskStatus({ id: 'finished', status: 'done' }).includes(' disabled'));
assert(!context.inlineTaskStatus({ id: 'open', status: 'todo' }).includes(' disabled'));
vm.runInContext(source.match(/async function updateProjectTask\([^]*?^}/m)[0], context);
const task = { id: 'task', project_id: 'project', status: 'todo' };
let writes = 0;
Object.assign(context, {
  requireCurrentUserPermission: () => true, loadProjectTasks: () => [task], operationalProjectTasks: () => [task],
  isLive: () => false, saveProjectTasks: () => { writes += 1; }, refreshActivityCache: () => {},
  recalculateDependencySchedules: async () => {}, toast: () => {}
});
(async () => {
  assert.equal(await context.updateProjectTask('task', { status: 'done' }), false);
  assert.equal(writes, 0);
  assert.equal(await context.updateProjectTask('task', { status: 'doing' }), true);
  assert(task.actual_start_date);
  assert.equal(await context.updateProjectTask('task', { status: 'done' }), true);
  assert(task.actual_end_date);
  for (const status of ['todo', 'doing', 'canceled']) assert.equal(await context.updateProjectTask('task', { status }), false);
  assert.equal(writes, 2);
  assert.equal(task.status, 'done');
  console.log('Task transitions, terminal admin lock, dropdown options, real dates and rejected updates passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
