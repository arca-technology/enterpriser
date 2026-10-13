const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['operationsJobRank', 'accessProfileLabel']);
const constants = new Set(['ACCESS_PROFILE_LABEL', 'OPERATIONS_JOB_HIERARCHY']);
const code = tree.statements.filter(node => (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => constants.has(d.name.text))))
  .map(node => node.getText(tree)).join('\n');
const context = vm.createContext({});
vm.runInContext(code, context);
for (const [rank, title] of ['Diretor de operações', 'Gerente de operações', 'Analista de operações', 'Assistente de operações', 'Auxiliar de operações'].entries()) {
  assert.equal(context.operationsJobRank(title), rank);
  assert.equal(context.operationsJobRank(title.toUpperCase()), rank);
  assert.equal(context.operationsJobRank(' '+title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll(' ', '  ')+' '), rank);
}
for (const unknown of [null, '', 'Gestor', 'Gerente de Projetos', 'Diretor financeiro']) assert.equal(context.operationsJobRank(unknown), -1);
assert.equal(context.accessProfileLabel({ role: 'collaborator', access_profile: 'project_manager' }), 'Gerente');
assert.equal(context.accessProfileLabel({ role: 'collaborator', access_profile: 'custom' }), 'Personalizado');
assert.equal(context.accessProfileLabel({ role: 'admin' }), 'Administrador');
console.log('Collaborator hierarchy passed: exact role order, case/accent/spacing normalization, unknown roles and shortened manager label.');
