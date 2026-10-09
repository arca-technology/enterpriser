const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('const HELP_HEADER_SLOTS =');
const end = source.indexOf('const HELP_PAGE_BY_MAIN =', start);
const pages = vm.runInNewContext(`${source.slice(start, end)}; HELP_PAGES`);
for (const id of ['home', 'contacts', 'companies', 'conversations', 'deals', 'projects', 'activities', 'reg-activities', 'reg-goals', 'reg-objectives']) {
  assert.ok(pages[id].sections.length, `${id} must have guidance`);
  assert.ok(pages[id].sections.some((section) => section.lead || section.cards), `${id} must explain concepts, not only clicks`);
}
for (const id of ['projects', 'activities']) {
  const dates = pages[id].sections.find((section) => section.title === 'Datas previstas e reais');
  assert.deepEqual(Array.from(dates.cards, (card) => card[0]), ['Início previsto', 'Término previsto', 'Início real', 'Término real']);
  assert.ok(dates.cards[1][1].includes('30/09/2026'));
  assert.ok(pages[id].sections.some((section) => section.title === 'Executar e acompanhar'));
}
assert.ok(pages['reg-activities'].sections.some((section) => section.title === 'Recorrência e prazo no mês'));
for (const id of ['projects', 'activities', 'reg-activities']) {
  const setup = pages[id].sections.find((section) => section.title === 'Requer no Setup');
  assert.ok(setup.lead.includes('Todos os requisitos'));
  assert.ok(setup.cards.some((card) => card[0] === 'Integração BLING + SHEIN'));
}
assert.ok(!JSON.stringify(pages.deals).includes('previsão de fechamento'));
console.log('Operational help content checks passed.');
