const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const today = '2026-10-10';
const shift = (start, days) => { const date = new Date(`${start}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const context = vm.createContext({
  esc: escape, brl: (value) => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  dt: (value) => value?.split('-').reverse().join('/') || '—', addDays: shift,
  normalizeIdList: (value) => [...new Set(value || [])],
  normalizeDeliveryChannel: (value) => String(value).replace(/[^a-z0-9]/gi, '').toUpperCase(),
  activityDisplayName: (item) => item?.title || '—', taskPlannedEnd: (item) => item.due_date,
  taskIsBlocked: (item, rows) => (item.dependency_ids || []).some((id) => rows.find((row) => row.id === id)?.status !== 'done'),
  taskDependencies: (item, rows) => rows.filter((row) => item.dependency_ids?.includes(row.id)),
  taskStatusLabel: (status) => ({ todo: 'Em aberto', doing: 'Em andamento', done: 'Atendido' }[status] || status),
  assigneeNames: () => 'Responsável', deliveryObjectiveDependencyState: () => ({ blocked: false }),
});
const names = ['isoDay', 'normalizeProjectBusinessMetrics', 'deliveryGoalReached', 'deliveryGoalPercent', 'deliveryOverviewRevenue', 'deliveryOverviewModel', 'overviewItemButton', 'overviewExecutionChart', 'overviewRevenueChart', 'overviewChannelSummary', 'renderDeliveryOverview'];
const functions = names.map((name) => source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0]);
vm.runInContext(functions.join('\n'), context);
const project = { id: 'p', name: 'EC365 | CLIENTE | PROJETO', start_date: '2026-09-01', end_date: '2027-02-28', business_metrics: [
  { month: '2026-09', revenue: 10000, skus: 80 },
  { month: '2026-10', revenue: 99999, channel_revenue: { AMAZON: 6000, SHEIN: 9000 }, skus: 100, supplier_company_ids: ['a', 'a', 'b'] },
] };
const tasks = [
  { id: 'done', title: 'Conciliação financeira', status: 'done', due_date: '2026-10-01', actual_end_date: '2026-10-02', channel: 'BLING' },
  { id: 'late', title: 'Integração com marketplace', status: 'todo', due_date: '2026-10-09', channel: 'AMAZON' },
  { id: 'future', title: 'Mentoria do próximo mês', status: 'todo', due_date: '2026-11-01', channel: 'BLING' },
  { id: 'today', title: 'Revisar cadastro', status: 'doing', due_date: today, dependency_ids: ['late'], channel: 'AMAZON' },
  { id: 'canceled', title: 'Cancelada', status: 'canceled', due_date: '2026-09-01' },
];
const objectives = [{ id: 'o', project_id: 'p', name: 'Organizar o financeiro e os processos da empresa', due_date: '2026-10-12', status: 'todo', channel: 'BLING' }];
const goals = [{ id: 'g', project_id: 'p', name: 'Chegar a 100 SKUs ativos', metric: 'SKUs', target_value: 100, current_value: 40, due_date: '2026-10-15', status: 'doing', channel: 'AMAZON' }];
const model = context.deliveryOverviewModel(project, tasks, objectives, goals, today);
assert.equal(model.planned.length, 3, 'Exclude future and canceled tasks from the current denominator');
assert.equal(model.plannedDone.length, 1);
assert.equal(model.lateTasks.length, 1, 'Due today is not late');
assert.equal(model.weekTasks.length, 1);
assert.equal(model.blockedTasks.length, 1);
assert.equal(model.upcoming.length, 2);
assert.equal(context.deliveryOverviewRevenue(model.currentMonth), 15000, 'Channel amounts override legacy totals');
assert.equal(model.currentMonth.supplier_company_ids.length, 2);
assert.equal(context.deliveryOverviewRevenue({ revenue: 100, channel_revenue: { AMAZON: 0 } }), 0);
assert.equal(context.deliveryOverviewRevenue(undefined), null);
assert.equal(context.deliveryOverviewRevenue(model.currentMonth, 'MERCADO LIVRE'), null);
const january = context.deliveryOverviewModel({ ...project, business_metrics: [{ month: '2025-12', revenue: 5 }] }, [], [], [], '2026-01-02');
assert.equal(january.previousMonth.month, '2025-12');
const chart = context.overviewExecutionChart(tasks, today);
assert.equal((chart.match(/overview-chart-row"/g) || []).length, 8);
assert(!chart.includes('NaN'));
assert(context.overviewExecutionChart([{ status: 'done' }], today).includes('sem data real'));
const summary = context.overviewChannelSummary(tasks.filter((item) => item.status !== 'canceled'), objectives, goals, today);
assert.equal((summary.match(/<details class="overview-channel">/g) || []).length, 2);
context.operationalProjectTasks = () => tasks;
context.loadDeliveryObjectives = () => objectives;
context.loadDeliveryGoals = () => goals;
context.Date = class extends Date {
  constructor(...args) { super(...(args.length ? args : [`${today}T12:00:00`])); }
};
const markup = context.renderDeliveryOverview(project);
assert(markup.includes('Atenção primeiro'));
assert(markup.includes('+50%'));
assert(!markup.includes('Atingimento médio'));
assert(!markup.includes('delivery-overview-okr'));
assert(markup.includes('data-overview-search="Integração com marketplace"'));
assert.equal((markup.match(/class="delivery-overview-progress"/g) || []).length, 3, 'No fake progress for business data');
if (process.argv.includes('--preview')) {
  const css = html.match(/<style>([^]*?)<\/style>/)[1];
  const client = `const esc=${escape.toString()};const brl=${context.brl.toString()};${functions.filter((fn) => /function (overviewRevenueChart|deliveryOverviewRevenue)/.test(fn)).join('\n')}
    document.getElementById('overview-revenue-channel').addEventListener('change',event=>document.getElementById('overview-revenue-chart').innerHTML=overviewRevenueChart(${JSON.stringify(model.metrics)},event.target.value));`;
  fs.mkdirSync(path.join(__dirname, '..', '.next'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.next', 'overview-preview.html'), `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{overflow:auto;padding:20px;box-sizing:border-box;font-family:Arial,sans-serif}.delivery-overview{height:auto;max-width:1900px;margin:auto;overflow:visible}</style><body class="light">${markup}<script>${client}</script></body></html>`);
}
console.log('Delivery overview metrics, periods, charts and navigation checks passed.');
