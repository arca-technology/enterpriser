const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({
  cache: { projects: [{ id: 'p', product_id: 'product', start_date: '2026-01-01' }] },
  isLive: () => true,
  normalizeIdList: () => [],
  addDays: (start, days) => {
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(days));
    return date.toISOString().slice(0, 10);
  },
  updateRow: async () => {},
});
for (const name of ['syncProductGoals', 'syncProductObjectives']) {
  vm.runInContext(source.match(new RegExp(`async function ${name}\\([^]*?^}`, 'm'))[0], context);
}
async function check(kind) {
  const template = { id: 't', product_id: 'product', name: 'Result', target_days: 30 };
  const rows = ['todo', 'doing', 'done', 'canceled'].map((status) => ({
    id: status, project_id: 'p', source_template_id: 't', due_date: '2026-01-08', status,
  }));
  rows.push({ ...rows[0], id: 'manual', schedule_manual: true });
  rows.forEach((row) => { row.source_template_id = `t-${row.id}`; });
  context[`loadProduct${kind}`] = () => rows.map((row) => ({ ...template, id: row.source_template_id }));
  context[`loadDelivery${kind}`] = () => rows;
  await context[`syncProduct${kind}`]();
  assert.equal(rows[0].due_date, '2026-01-31');
  assert.equal(rows[1].due_date, '2026-01-31');
  for (const row of rows.slice(2)) assert.equal(row.due_date, '2026-01-08');
  template.target_days = 0;
  await context[`syncProduct${kind}`]();
  assert.equal(rows[0].due_date, '2026-01-01');
  template.target_days = null;
  await context[`syncProduct${kind}`]();
  assert.equal(rows[0].due_date, null);
}
(async () => {
  await check('Goals');
  await check('Objectives');
  for (const name of ['deliveryGoalReached', 'deliveryGoalPercent']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0], context);
  }
  assert.equal(context.deliveryGoalPercent({ comparison: 'at_least', current_value: 40, target_value: 100 }), 40);
  assert.equal(context.deliveryGoalPercent({ comparison: 'at_most', current_value: 3, target_value: 5 }), 100);
  assert.equal(context.deliveryGoalPercent({ comparison: 'exactly', current_value: 20, target_value: 10 }), 50);
  console.log('Result deadlines and attainment checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
