const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/manage-crm-user/index.ts'), 'utf8');
const validation = source.slice(source.indexOf('      const accessProfile ='), source.indexOf('      let authUserId = existing?.'));
assert.ok(validation.includes('assignmentRules'));
const js = ts.transpileModule(`function validate(body, existing, role) { ${validation}
  return { access_profile: accessProfile, ...assignmentRules }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const context = vm.createContext({ json: (body, status) => ({ ...body, status }) });
vm.runInContext(js, context);
const fields = ['auto_assignment_categories', 'auto_assignment_channels', 'auto_assignment_modules', 'auto_assignment_submodules'];
const old = { access_profile: 'project_manager', auto_assignment_categories: ['Financeiro'] };
assert.equal(context.validate({}, old, 'collaborator').access_profile, 'project_manager');
assert.equal(context.validate({}, old, 'admin').access_profile, 'custom');
assert.equal(context.validate({}, old, 'collaborator').auto_assignment_categories[0], 'Financeiro');
assert.equal(context.validate({ access_profile: 'root' }, null, 'collaborator').status, 400);
assert.equal(context.validate({ access_profile: 'project_manager' }, null, 'client').status, 400);
for (const key of fields) {
  for (const bad of ['text', [1], Array(101).fill('x'), ['x'.repeat(161)]]) {
    assert.equal(context.validate({ [key]: bad }, null, 'collaborator').status, 400);
  }
  assert.deepEqual(Array.from(context.validate({ [key]: [' Fiscal ', 'FISCAL', '', 'Financeiro'] }, null, 'collaborator')[key]), ['FISCAL', 'Financeiro']);
  assert.equal(context.validate({ [key]: [] }, old, 'collaborator')[key].length, 0);
}
assert.ok(source.indexOf('if (actor.role !== "admin")') < source.indexOf('const accessProfile ='));
assert.ok(source.indexOf('const accessProfile =') < source.indexOf('admin.auth.admin.updateUserById'));
console.log('User access validation passed: admin guard, invalid values before Auth mutations, preserved omitted fields, type restrictions and bounded normalized multiple selections.');
