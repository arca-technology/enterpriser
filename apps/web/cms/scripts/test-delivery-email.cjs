const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const edgeSource = fs.readFileSync(path.join(root, 'supabase/functions/provision-client-email/index.ts'), 'utf8');
const compiled = ts.transpileModule(edgeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
assert.equal((compiled.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
const edge = compiled.outputText.replace(/^import .*?;\s*/m, 'const createClient = globalThis.mockClient;\n');
const cnpj = '12.345.678/0001-90';
const delivery = { id: 'delivery-fixture', company_id: cnpj, client_name: 'Cliente teste' };
const company = { tax_id: cnpj, trade_name: 'Cliente teste', legal_name: 'Cliente Teste Ltda' };
const account = { id: 'email-fixture', company_id: cnpj, delivery_id: delivery.id, email: '12345678@example.test', client_name: 'Cliente teste', password_ciphertext: null, tags: [] };

async function request(actor, method, body, options = {}) {
  let handler;
  const calls = [], mutations = [], cpanel = [];
  const env = { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'public-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture', CPANEL_EMAIL_DOMAIN: 'example.test', EMAIL_CREDENTIALS_ENCRYPTION_KEY: 'test-only-key' };
  class Query {
    constructor(table, key) { this.table = table; this.key = key; this.operation = 'select'; }
    select() { return this; }
    eq(column, value) { this[column] = value; return this; }
    order() { return this; }
    update(body) { this.operation = 'update'; this.body = body; return this; }
    insert(body) { this.operation = 'insert'; this.body = body; return this; }
    async maybeSingle() { return this.resolve(false); }
    async single() { return this.resolve(false); }
    then(resolve, reject) { return Promise.resolve(this.resolve(true)).then(resolve, reject); }
    resolve(many) {
      calls.push({ table: this.table, key: this.key, operation: this.operation });
      if (this.operation !== 'select') mutations.push({ table: this.table, body: this.body });
      let row = this.table === 'profiles' ? actor
        : this.table === 'deliveries' ? options.inaccessible ? null : { ...delivery, company_id: options.noCompany ? null : cnpj }
          : this.table === 'companies' ? company
            : this.table === 'client_email_accounts' ? this.operation !== 'select' ? { ...account, ...this.body } : options.newAccount ? null : { ...account, password_ciphertext: options.hiddenCiphertext ? 'must-not-decrypt' : null }
              : null;
      if (this.table === 'deliveries') assert.equal(this.key, 'public-fixture', 'Delivery lookup must apply caller RLS');
      return { data: many ? row ? [row] : [] : row, error: null };
    }
  }
  const context = vm.createContext({ Request, Response, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa, atob,
    Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } },
    mockClient: (_url, key, config) => ({
      auth: { getUser: async (token) => ({ data: { user: token === 'valid-fixture' ? { id: 'actor-fixture' } : null }, error: null }) },
      from: (table) => { if (table === 'deliveries') assert.equal(config.global.headers.Authorization, 'Bearer valid-fixture'); return new Query(table, key); },
      rpc: async (_name, args) => { cpanel.push(args.operation); return { data: { status: 1, data: args.operation === 'list_pops' ? [] : null }, error: null }; },
    }),
    fetch: () => { throw new Error('Live network forbidden in this test'); },
  });
  vm.runInContext(edge, context);
  const response = await handler(new Request('https://fixture.invalid/functions/v1/provision-client-email', {
    method, headers: options.unauthenticated ? {} : { Authorization: 'Bearer valid-fixture', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json(), calls, mutations, cpanel };
}

(async () => {
  const staff = { id: 'actor-profile', status: 'active', role: 'collaborator', permissions: { projects: { create: true }, emails: {} } };
  for (const newAccount of [false, true]) {
    const result = await request(staff, 'POST', { deliveryId: delivery.id }, { newAccount, hiddenCiphertext: true });
    assert.equal(result.status, newAccount ? 201 : 200);
    assert.equal(result.body.body, undefined);
    assert.equal(result.body.account.password, null);
    assert.equal(result.body.status, newAccount ? 'created' : 'existing');
    assert.deepEqual(result.cpanel, newAccount ? ['list_pops', 'add_pop'] : []);
  }
  for (const [method, body] of [['GET', null], ['PATCH', { email: account.email }], ['POST', { companyId: cnpj }], ['POST', { deliveryId: delivery.id, companyId: cnpj }]]) {
    const result = await request(staff, method, body);
    assert.equal(result.status, 403);
    assert.deepEqual(result.cpanel, []);
    assert.deepEqual(result.mutations, []);
  }
  for (const actor of [{ ...staff, status: 'inactive' }, { ...staff, role: 'client' }, { ...staff, role: 'developer' }, { ...staff, role: 'supplier' }, { ...staff, permissions: {} }]) {
    assert.equal((await request(actor, 'POST', { deliveryId: delivery.id })).status, 403);
  }
  assert.equal((await request(staff, 'POST', { deliveryId: delivery.id }, { unauthenticated: true })).status, 401);
  for (const [option, status] of [['inaccessible', 404], ['noCompany', 400]]) {
    const result = await request(staff, 'POST', { deliveryId: delivery.id }, { [option]: true });
    assert.equal(result.status, status);
    assert.deepEqual(result.mutations, []);
    assert.deepEqual(result.cpanel, []);
  }
  const manager = { ...staff, permissions: { emails: { view: true, create: true, edit: true } } };
  assert.equal((await request(manager, 'GET')).status, 200);
  assert.equal((await request(manager, 'PATCH', { email: account.email })).status, 404);
  assert.equal((await request(manager, 'POST', { companyId: cnpj })).status, 200);
  assert.equal((await request({ ...staff, role: 'admin' }, 'POST', { deliveryId: delivery.id })).status, 200);

  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const tree = ts.createSourceFile('app.js', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const clientSource = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'emailAccountsRequest').map((node) => node.getText(tree)).join('\n');
  let currentActor = staff;
  const clientCalls = [];
  const client = vm.createContext({ APP_VARIANT: 'web', currentProfile: staff, isLive: () => true,
    requireCurrentUserPermission: (module, action) => currentActor.role === 'admin' || currentActor.permissions?.[module]?.[action] === true,
    getCfg: () => ({ url: 'https://fixture.invalid', anonKey: 'public-fixture' }), getAccessToken: async () => 'valid-fixture',
    fetch: async (_url, options) => { clientCalls.push(options); return new Response(JSON.stringify({ status: 'existing', account: { ...account, password: null } })); },
  });
  vm.runInContext(clientSource, client);
  const run = (method, body) => client.emailAccountsRequest(method, body);
  await run('POST', { deliveryId: delivery.id });
  assert.equal(clientCalls.length, 1);
  await assert.rejects(run('POST', { companyId: cnpj }), /Operação não permitida/);
  await assert.rejects(run('GET'), /Operação não permitida/);
  await assert.rejects(run('PATCH', { email: account.email }), /Operação não permitida/);
  currentActor = { ...staff, permissions: { emails: { edit: true } } }; client.currentProfile = currentActor;
  await run('PATCH', { email: account.email });
  assert.equal(clientCalls.at(-1).method, 'PATCH');
  console.log('Delivery email passed: collaborator automatic provisioning, existing/create idempotency, caller RLS, no credential disclosure without view, manual permissions, inactive/external/anonymous rejection and PATCH edit permission. No live writes.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
