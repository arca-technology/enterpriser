const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const functions = ['dateOnly', 'isoDay', 'monthlyDeadlineRange', 'taskDeadlinePeriod', 'taskDeadlineState'];
const code = functions.map((name) => source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0]).join('\n');
const RealDate = Date;
class TestDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-08T12:00:00'])); }
}
const context = vm.createContext({ Date: TestDate, taskPlannedStart: (task) => task.planned_start_date,
  taskPlannedEnd: (task) => task.planned_end_date || task.due_date });
vm.runInContext(code, context);
for (const [date, window, start, end] of [
  ['2026-10-01', 'week1', '2026-10-01', '2026-10-07'],
  ['2026-10-06', 'week2', '2026-10-08', '2026-10-14'],
  ['2026-10-06', 'week3', '2026-10-15', '2026-10-21'],
  ['2026-10-06', 'week4', '2026-10-22', '2026-10-31'],
  ['2028-02-01', 'month', '2028-02-01', '2028-02-29'],
  ['2026-02-01', 'week4', '2026-02-22', '2026-02-28'],
  ['2026-12-01', 'month', '2026-12-01', '2026-12-31']
]) {
  const range = context.monthlyDeadlineRange(date, window);
  assert.equal(range.start, start);
  assert.equal(range.end, end);
}
assert.equal(context.monthlyDeadlineRange('2026-10-01', 'date'), null);
assert.equal(context.monthlyDeadlineRange(null, 'month'), null);
const task = { recurrence: 'monthly', deadline_window: 'week1', status: 'todo',
  planned_start_date: '2026-10-01', planned_end_date: '2026-10-07' };
assert.equal(context.taskDeadlineState(task), 'Atrasado');
assert.equal(context.taskDeadlineState({ ...task, actual_end_date: '2026-10-06' }), 'Em dia');
assert.equal(context.taskDeadlineState({ ...task, actual_end_date: '2026-10-07' }), 'Em dia');
assert.equal(context.taskDeadlineState({ ...task, actual_end_date: '2026-09-30' }), 'Adiantado');
assert.equal(context.taskDeadlineState({ ...task, deadline_window: 'month', planned_end_date: '2026-10-31' }), 'Em dia');
assert.equal(context.taskDeadlineState({ ...task, deadline_window: 'date', actual_end_date: '2026-10-06' }), 'Adiantado');
console.log('Monthly deadline ranges and status checks passed.');
