const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({ Date, Set, Map,
  normalizeIdList: (ids, fallback) => [...new Set([...(Array.isArray(ids) ? ids : []), fallback].filter(Boolean))],
  taskPlannedStart: (row) => row.planned_start_date,
  taskPlannedEnd: (row) => row.planned_end_date || row.due_date,
  addDays: (day, count) => { const date = new Date(`${day}T12:00:00`); date.setDate(date.getDate() + count); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); },
  taskIsBlocked: (row, tasks) => (row.dependency_ids || []).some((id) => tasks.find((task) => task.id === id)?.status !== 'done'),
  internalAssigneeUser: (user) => user.role === 'collaborator' || user.role === 'admin',
  defaultDealPipeline: (c) => c.pipelines.find((pipeline) => pipeline.name === 'Padr\u00e3o'),
});
for (const name of ['isoDay', 'dateOnly', 'deliveryGoalReached', 'homeMessageTime', 'homeConversationState', 'homeGoalCurve', 'homeGoalReached', 'homeDashboardModel']) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}
const now = new Date(2026, 9, 11, 12);
const today = '2026-10-11';
const makeTask = (id, date, extra = {}) => ({ id, project_id: 'p', assignee_ids: ['me'], status: 'todo', due_date: date, ...extra });
const c = {
  projects: [{ id: 'p', status: 'active', owner_id: 'me', start_date: '2026-10-01', end_date: '2026-10-31' }, { id: 'other', status: 'active', owner_id: 'other' }, { id: 'closed', status: 'closed', owner_id: 'me' }],
  activities: [makeTask('parent', '2026-10-01'), makeTask('late', '2026-10-10', { parent_activity_id: 'parent' }), makeTask('old', '2026-08-01', { recurrence: 'monthly' }), makeTask('daily', today), makeTask('future', '2026-10-12'), makeTask('window', '2026-10-31', { recurrence: 'monthly', deadline_window: 'month', planned_start_date: '2026-10-01' }), makeTask('next-window', '2026-10-31', { deadline_window: 'week4', planned_start_date: '2026-10-22' }), makeTask('undated', null), makeTask('done', '2026-10-01', { status: 'done', actual_end_date: '2026-10-07' }), makeTask('missing-completion', today, { status: 'done' }), makeTask('canceled', '2026-09-01', { status: 'canceled', recurrence: 'monthly' }), makeTask('closed-task', '2026-08-01', { project_id: 'closed' }), makeTask('other-task', '2026-10-01', { project_id: 'other', assignee_ids: ['other'] })],
  goals: [{ id: 'g', project_id: 'p', current_value: 10, target_value: 100, due_date: '2026-10-31', status: 'todo' }], objectives: [],
  users: [{ id: 'me', full_name: 'Ulisses', role: 'admin' }, { id: 'other', full_name: 'Ana', role: 'collaborator' }],
  contacts: [{ id: 'contact', name: 'Cliente' }],
  conversations: [
    { id: 'incoming', owner_id: 'me', contact_id: 'contact', messages: [{ author: 'Cliente', at: '08/10/2026 09:00', text: 'Oi' }] },
    { id: 'outgoing', owner_id: 'me', messages: [{ author: 'Ulisses', at: '08/10/2026 09:00' }] },
    { id: 'unknown', owner_id: 'me', last_at: '2026-10-08T09:00:00Z', messages: [{ author: 'Desconhecido', text: 'Oi' }] },
    { id: 'recent', owner_id: 'me', messages: [{ direction: 'incoming', at: '11/10/2026 09:00' }] },
    { id: 'no-date', owner_id: 'me', imported_at: '2026-10-08T09:00:00Z', messages: [{ from_me: false }] },
  ],
  pipelines: [{ id: 'default', name: 'Padr\u00e3o', stages: ['Lead', 'Proposta'] }, { id: 'another', stages: ['Lead'] }],
  deals: [{ id: 'won', owner_id: 'me', status: 'won', amount: 1500 }, { id: 'open', owner_id: 'me', status: 'open', pipeline_id: 'default', stage: 'Lead', amount: 100, contact_id: 'contact' }, { id: 'unknown-stage', owner_id: 'me', status: 'open', pipeline_id: 'default', stage: 'Removed', amount: 50 }, { id: 'another', owner_id: 'me', status: 'open', pipeline_id: 'another', stage: 'Lead', amount: 500 }, { id: 'other-won', owner_id: 'other', status: 'won', amount: 3000 }],
};
const model = context.homeDashboardModel(c, { now, userId: 'me', scope: 'mine' });
const ids = (rows) => Array.from(rows, (row) => row.id).sort();
assert.deepEqual(ids(model.buckets.late), ['late', 'old']);
assert.deepEqual(ids(model.buckets.today), ['daily', 'window']);
assert.deepEqual(ids(model.buckets.week), ['daily', 'window']); // Sunday: next Monday is not this week.
assert.deepEqual(ids(model.buckets.undated), ['undated']);
assert.deepEqual(ids(model.oldRecurring), ['old']);
assert.deepEqual(ids(model.completed), ['done']);
assert.equal(model.health[0].overdue.length, 2);
assert.equal(model.health[0].risk, 2);
assert.equal(model.revenue, 1500);
assert.equal(model.pipelineAmount, 650);
assert.equal(model.funnel.reduce((sum, stage) => sum + stage.rows.length, 0), 2);
assert.equal(model.curves.length, 1);
assert.deepEqual(ids(model.unanswered), ['incoming']);
assert.equal(model.unknownConversations, 2);
assert.equal(model.staleDeals.length, 0);
assert.equal(context.homeMessageTime('31/02/2026 09:00'), NaN);
assert.equal(context.homeMessageTime('10/10/2026 25:00'), NaN);
assert.equal(context.homeMessageTime('2026-10-10'), NaN);
const project = c.projects[0];
assert.equal(context.homeGoalCurve({ ...c.goals[0], current_value: null }, project, today), null);
assert.equal(context.homeGoalCurve({ ...c.goals[0], target_value: '' }, project, today), null);
assert.equal(context.homeGoalCurve({ ...c.goals[0], status: 'done' }, project, today), null);
assert.equal(context.homeGoalCurve(c.goals[0], { start_date: '2026-11-01' }, today), null);
assert.equal(context.homeGoalCurve({ current_value: 3, target_value: 2, comparison: 'at_most', due_date: '2026-10-31' }, project, today).expected, 2);
assert.equal(context.homeGoalCurve({ current_value: 2, target_value: 2, comparison: 'at_most', due_date: '2026-10-31' }, project, today).behind, false);
assert.equal(context.homeGoalCurve({ current_value: 120, target_value: 100, comparison: 'exactly', due_date: '2026-10-31' }, project, today).behind, true);
assert.equal(context.homeGoalCurve({ current_value: 0, target_value: 0, due_date: today }, project, today).behind, false);
assert.equal(context.homeGoalReached({ current_value: null, target_value: 0, comparison: 'at_most' }), false);
const team = context.homeDashboardModel(c, { now, userId: 'me', scope: 'team' });
assert.equal(team.revenue, 4500);
assert.ok(ids(team.buckets.late).includes('other-task'));
const denied = context.homeDashboardModel(c, { now, userId: 'me', scope: 'team', permissions: { projects: false, activities: false, deals: false, conversations: false } });
for (const key of ['projects', 'tasks', 'health', 'curves', 'openDeals', 'unanswered', 'workload']) assert.equal(denied[key].length, 0, key);
assert.equal(context.isoDay(new Date(2026, 9, 11, 23, 59)), today);
console.log('Home model passed: scope, permissions, leaf counts, recurrence windows, dates, goal curves, imported message evidence and real revenue.');
