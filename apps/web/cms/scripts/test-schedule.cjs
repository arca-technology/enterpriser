const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({ GANTT_DAY_MS: 86400000,
  addDays: (day, amount) => { const date = new Date(`${day}T12:00:00`); date.setDate(date.getDate() + amount); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); },
  dt: (value) => value.split('-').reverse().join('/'),
});
for (const name of ['dateOnly', 'isoDay', 'orderedScheduleItems', 'scheduleDay', 'scheduleBounds', 'scheduleShiftDay', 'schedulePeriod', 'scheduleLate', 'scheduleFilterItems', 'scheduleScale']) {
  vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0], context);
}
const items = [
  { id: 'spans', start: '2026-07-01', end: '2026-12-31', status: 'active', client: 'A', owners: [{ id: 'ana' }] },
  { id: 'october', start: '2026-10-01', end: '2026-10-31', status: 'active', client: 'B', owners: [{ id: 'bruno' }] },
  { id: 'ends-first', start: '2026-09-01', end: '2026-10-01', status: 'active', client: 'A' },
  { id: 'starts-last', start: '2026-10-31', end: '2026-12-31', status: 'active', client: 'A' },
  { id: 'before', start: '2026-07-01', end: '2026-09-30', status: 'active' },
  { id: 'after', start: '2026-11-01', end: '2026-12-31', status: 'active' },
  { id: 'done', start: '2026-09-01', end: '2026-10-01', status: 'done' },
  { id: 'canceled', start: '2026-09-01', end: '2026-10-01', status: 'canceled' },
  { id: 'undated', start: null, end: null, status: 'todo' },
  { id: 'point', start: null, end: '2026-10-10', status: 'todo' },
];
const base = { start: '2026-10-01', end: '2026-10-31', scale: 'weeks', status: 'all', undated: false };
const ids = (settings) => Array.from(context.scheduleFilterItems(items, { ...base, ...settings }, '2026-10-11'), (item) => item.id).sort();
assert.deepEqual(ids({}), ['canceled', 'done', 'ends-first', 'october', 'point', 'spans', 'starts-last']);
assert.deepEqual(ids({ status: 'active' }), ['ends-first', 'october', 'spans', 'starts-last']);
assert.deepEqual(ids({ status: 'pending', onlyLate: true }), ['ends-first', 'point']);
assert.deepEqual(ids({ client: 'A', owner: 'ana' }), ['spans']);
assert.ok(ids({ undated: true }).includes('undated'));
assert.ok(ids({ owner: '__unassigned__' }).includes('point'));
assert.deepEqual(ids({ end: '2026-09-30' }), []);
assert.deepEqual(ids({ start: '' }), []);
assert.equal(context.scheduleDay('2026-02-31'), null);
assert.equal(context.scheduleDay('invalid'), null);
assert.equal(context.scheduleDay('2026-10-31') - context.scheduleDay('2026-10-01'), 30);
assert.equal(context.scheduleBounds({ start: '2026-10-31', end: '2026-10-01' }), null);
assert.equal(context.scheduleBounds({ end: '2026-10-10' }).point, true);
assert.equal(context.scheduleBounds({ start: '2026-07-01' }), null);
assert.ok(context.scheduleFilterItems([{ id: 'no-end', start: '2026-07-01', status: 'active' }], { ...base, undated: true }, '2026-10-11').length);
assert.equal(context.scheduleLate(items.find((item) => item.id === 'canceled'), '2026-10-11'), false);
assert.equal(context.scheduleLate({ start: '2026-01-01', status: 'todo' }, '2026-10-11'), false);
assert.equal(context.schedulePeriod('month', '2024-02-15').end, '2024-02-29');
assert.equal(context.schedulePeriod('quarter', '2026-10-11').start, '2026-10-01');
assert.equal(context.schedulePeriod('quarter', '2026-10-11').end, '2026-12-31');
assert.equal(context.schedulePeriod('next30', '2026-12-20').end, '2027-01-18');
assert.equal(context.scheduleShiftDay('2026-03-28', 2), '2026-03-30');
assert.equal(context.scheduleShiftDay('2026-12-31', 1), '2027-01-01');
assert.equal(context.schedulePeriod('all', '2026-10-11', items).start, '2026-07-01');
for (const mode of ['days', 'weeks', 'months']) {
  const scale = context.scheduleScale({ ...base, scale: mode });
  assert.equal(scale.days, 31);
  assert.equal(scale.mode, mode);
  assert.ok(Math.abs(scale.ticks.reduce((sum, tick) => sum + tick.width, 0) - 100) < .00001);
}
assert.equal(context.scheduleScale({ start: '2026-10-10', end: '2026-11-20', scale: 'months' }).ticks.length, 2);
assert.equal(context.scheduleScale({ start: '2026-01-01', end: '2030-12-31', scale: 'days' }).mode, 'months');
console.log('Schedule model passed: inclusive overlap, status/owner filters, undated and partial ranges, leap years, period presets, DST-safe scale and bounded zoom.');
