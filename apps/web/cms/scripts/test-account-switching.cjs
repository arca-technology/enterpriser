const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['readAuthSession', 'storeAuthSession', 'quickAccountSwitchAllowed', 'rememberAccountSession', 'accountProfileForSession', 'commitAccountSwitch', 'useSavedAccount', 'getAccessToken', 'api']);
const code = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(tree)).join('\n');
const storage = new Map();
const profiles = {
  admin: { id: 'p-admin', auth_user_id: 'admin', email: 'upgferreira@gmail.com', status: 'active', role: 'admin' },
  user: { id: 'p-user', auth_user_id: 'user', email: 'ulisses.ferreira@ecommerce365.com.br', status: 'active', role: 'collaborator' },
  dev: { id: 'p-dev', auth_user_id: 'dev', email: 'dev@enterpriser.com.br', status: 'active', role: 'developer' },
};
const session = (id) => ({ user: { id }, access_token: `fixture-access-${id}`, refresh_token: `fixture-refresh-${id}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
const context = vm.createContext({
  currentProfile: profiles.admin, accountEpoch: 0, accountWritesInFlight: 0, quickAccountSessions: new Map(),
  QUICK_ACCOUNT_EMAILS: new Set(Object.values(profiles).map((profile) => profile.email)), AUTH_SESSION_KEY: 'crm_auth_session',
  localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  isLive: () => true, getCfg: () => ({ url: 'https://fixture.localhost', anonKey: 'fixture-public' }),
  fetch: async (url, options) => { const id = new URL(url).searchParams.get('auth_user_id').slice(3); assert.equal(options.headers.Authorization, `Bearer fixture-access-${id}`); return { ok: true, json: async () => [profiles[id]] }; },
  authRequest: async (_path, body) => session(body.refresh_token.replace('fixture-refresh-', '')),
  currentUserIsAdmin: () => context.currentProfile.role === 'admin',
  stopLiveUpdates() {}, stopInternalChatPolling() {}, clearTimeout() {}, columnPreferenceSaveTimer: null,
  closeHelpPanel() {}, closeFloaters() {}, closeModal() {}, identityUrls: new Map(), workspaceIdentityReady: true,
  state: { tab: 'activities', filters: { private: true }, selectedConversations: new Set(['old']), expandedActivityClients: new Set(['old']), bulkSelections: { activities: new Set(['old']) }, pages: { activities: 2 } },
  secondaryTableSelections: new Map([['old', 'selection']]), homeDayState: { selected: new Set(['old']), scope: 'team' },
  document: { getElementById: () => ({ value: '', replaceChildren() {}, removeAttribute() {} }) },
  init: async () => { context.cache = { account: context.currentProfile.id }; },
  showLogin() {}, performance, noteOwnWrite() {}, recordApiRequest() {},
});
vm.runInContext(code, context);

(async () => {
  context.storeAuthSession(session('admin'));
  context.rememberAccountSession(profiles.admin);
  context.rememberAccountSession(profiles.user, session('user'));
  context.rememberAccountSession(profiles.dev, session('dev'));
  assert.deepEqual([...storage.keys()], ['crm_auth_session'], 'Only the original active-session storage key exists');
  context.accountWritesInFlight = 1;
  await assert.rejects(context.useSavedAccount('user'), /salvamento/);
  assert.equal(context.currentProfile.role, 'admin');
  context.accountWritesInFlight = 0;
  context.remoteToolEmails = [{ password: 'fixture-not-a-real-password' }];
  await context.useSavedAccount('user');
  assert.equal(context.currentProfile.role, 'collaborator');
  assert.equal(context.cache.account, 'p-user');
  assert.equal(context.remoteToolEmails.length, 0);
  assert.equal(context.state.pages.activities, 1);
  assert.equal(context.state.bulkSelections.activities.size, 0);
  assert.equal(context.secondaryTableSelections.size, 0);
  assert.equal(context.homeDayState.scope, 'mine');
  await context.useSavedAccount('dev'); assert.equal(context.currentProfile.role, 'developer');
  await assert.rejects(context.api('activities', { method: 'PATCH' }), /bloqueadas/);
  await context.useSavedAccount('admin'); assert.equal(context.currentProfile.role, 'admin');
  profiles.user.status = 'inactive';
  await assert.rejects(context.useSavedAccount('user'), /habilitada/);
  assert.equal(context.currentProfile.role, 'admin');
  profiles.user.status = 'active';
  context.authRequest = async () => session('dev');
  await assert.rejects(context.useSavedAccount('user'), /não corresponde/);
  const expiry = context.readAuthSession(); expiry.expires_at = 1; context.storeAuthSession(expiry);
  let finish;
  context.authRequest = () => new Promise((resolve) => { finish = resolve; });
  const refresh = context.getAccessToken();
  context.accountEpoch++; context.storeAuthSession(session('user')); finish(session('admin'));
  assert.equal(await refresh, null);
  assert.equal(context.readAuthSession().user.id, 'user', 'A previous account refresh cannot overwrite the active account');
  assert.deepEqual([...storage.keys()], ['crm_auth_session']);
  assert.equal(storage.get('crm_auth_session').includes('password'), false);
  console.log('Account switching passed: authenticated target identity, current roles, memory-only extra sessions, cache/selection reset, writes guard, inactive/mismatched account rejection and stale-refresh isolation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
