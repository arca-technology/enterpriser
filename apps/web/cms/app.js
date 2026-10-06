"use strict";

const IS_EXTENSION_CONTEXT = Boolean(globalThis.chrome?.runtime?.id);
const APP_VARIANT = IS_EXTENSION_CONTEXT ? "extension" : "web";

// ---------- Config / conexão (config.js ou salvo nas Configurações) ----------
function getCfg() {
  try {
    const ls = JSON.parse(localStorage.getItem("crm_cfg") || "null");
    if (ls && ls.url && ls.anonKey) return ls;
  } catch (e) {}
  return window.CRM_CONFIG || { url: "", anonKey: "" };
}
const isLive = () => {
  const c = getCfg();
  return Boolean(c.url && c.anonKey);
};

// ---------- Autenticação Supabase ----------
const AUTH_SESSION_KEY = "crm_auth_session";
const PRIVACY_CONSENT_KEY = "erc_privacy_consent_v1";
const PRIVACY_VERSION = "2026-09-19";
let currentProfile = null;
function readPrivacyConsent() {
  return new Promise((resolve) => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.get({ [PRIVACY_CONSENT_KEY]: null }, (data) => resolve(data[PRIVACY_CONSENT_KEY]));
      return;
    }
    try { resolve(JSON.parse(localStorage.getItem(PRIVACY_CONSENT_KEY) || "null")); }
    catch (e) { resolve(null); }
  });
}
function savePrivacyConsent(value) {
  return new Promise((resolve) => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.set({ [PRIVACY_CONSENT_KEY]: value }, resolve);
      return;
    }
    localStorage.setItem(PRIVACY_CONSENT_KEY, JSON.stringify(value));
    resolve();
  });
}
async function ensurePrivacyConsent() {
  const gate = document.getElementById("privacy-gate");
  if (!IS_EXTENSION_CONTEXT) {
    gate.hidden = true;
    return true;
  }
  const current = await readPrivacyConsent();
  if (current?.accepted && current?.version === PRIVACY_VERSION) {
    gate.hidden = true;
    return true;
  }
  gate.hidden = false;
  return new Promise((resolve) => {
    document.getElementById("privacy-accept").onclick = async () => {
      await savePrivacyConsent({ accepted: true, version: PRIVACY_VERSION, accepted_at: new Date().toISOString() });
      gate.hidden = true;
      resolve(true);
    };
    document.getElementById("privacy-decline").onclick = () => {
      document.getElementById("privacy-message").textContent = "O consentimento é necessário para usar a extensão. Nenhuma captura de Reddit ou WhatsApp será ativada sem sua autorização.";
    };
  });
}
function readAuthSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null"); }
  catch (e) { return null; }
}
function storeAuthSession(session) {
  if (!session) { localStorage.removeItem(AUTH_SESSION_KEY); return null; }
  const normalized = {
    ...session,
    expires_at: Number(session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600))
  };
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(normalized));
  return normalized;
}
async function authRequest(path, body, accessToken = null) {
  const c = getCfg();
  const headers = { apikey: c.anonKey, "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${c.url}/auth/v1/${path}`, { method: "POST", headers, body: body == null ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.msg || data?.error_description || data?.message || `Falha de autenticação (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}
async function getAccessToken() {
  if (!isLive()) return null;
  let session = readAuthSession();
  if (!session?.access_token || !session?.refresh_token) return null;
  if (Number(session.expires_at || 0) > Math.floor(Date.now() / 1000) + 60) return session.access_token;
  try {
    session = storeAuthSession(await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
    return session.access_token;
  } catch (e) {
    storeAuthSession(null);
    return null;
  }
}
function showLogin(message = "") {
  closeModal();
  document.getElementById("boot-gate")?.setAttribute("hidden", "");
  const gate = document.getElementById("auth-gate");
  if (!gate) return;
  gate.hidden = false;
  document.getElementById("login-error").textContent = message;
  document.getElementById("login-password").value = "";
  document.getElementById("login-email").focus();
}
function hideLogin() {
  const gate = document.getElementById("auth-gate");
  if (gate) gate.hidden = true;
}
async function callUserAdmin(action, payload = {}) {
  const c = getCfg();
  const token = await getAccessToken();
  if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
  const res = await fetch(`${c.url}/functions/v1/manage-crm-user`, {
    method: "POST",
    headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || data.message || `Falha ao gerenciar acesso (${res.status})`;
    if (res.status === 403) throw new Error(`${message} Sessão atual: ${currentSessionLabel()}. Saia e entre com o acesso administrador.`);
    throw new Error(message);
  }
  return data;
}
async function signOut() {
  const session = readAuthSession();
  try { if (session?.access_token) await authRequest("logout", null, session.access_token); } catch (e) {}
  stopLiveUpdates();
  storeAuthSession(null);
  currentProfile = null;
  cache = null;
  showLogin("Sessão encerrada.");
}

// ---------- Domínio ----------
// As etapas de negociação não são mais fixas — cada pipeline (tabela
// "pipelines") define sua própria lista de etapas em texto livre, até 5
// pipelines por conta (gerenciado no modal "Pipeline" do rodapé).
const STATUSES = ["open", "won", "lost"];
const STATUS_LABEL = { open: "Aberto", won: "Ganho", lost: "Perdido" };
const PROJECT_STATUSES = ["active", "inactive", "closed"];
const PROJECT_STATUS_LABEL = { active: "Ativo", inactive: "Inativo", closed: "Encerrado" };
const PROJECT_SUBSTATUS = ["support", "closed"];
const PROJECT_SUBSTATUS_LABEL = { support: "Suporte", closed: "Encerrado" };
const DELIVERY_CHANNEL_OPTIONS = {
  erp: ["BLING", "OLIST"],
  marketplaces: ["AMAZON", "MAGAZINE LUIZA", "MERCADO LIVRE", "SHEIN", "SHOPEE", "TIKTOKSHOP"],
  stores: ["LOJA FÍSICA", "BAGY", "NUVEM SHOP", "SHOPIFY", "TRAY", "VTEX", "WAKE", "WOOCOMMERCE"],
  freight: ["CORREIOS", "FRENET", "JADLOG", "LOGI", "MELHOR ENVIO", "MERCADO ENVIOS", "NUVEM ENVIO", "TOTAL EXPRESS"],
  financial: [
    "BANCO DO BRASIL", "BRADESCO", "BTG PACTUAL", "C6 BANK", "CAIXA", "INTER", "ITAÚ", "NUBANK", "SANTANDER", "SICOOB", "SICREDI",
    "APPMAX", "ASAAS", "CIELO", "EFÍ", "GETNET", "MERCADO PAGO", "NUVEM PAGO", "PAGAR.ME", "PAGBANK", "PAYPAL", "REDE", "STONE", "STRIPE", "VINDI"
  ]
};
const DELIVERY_COMPANY_SETUP_OPTIONS = ["ABERTA"];
// Canais que trazem contas financeiras e fretes automaticamente.
const DELIVERY_AUTO_SETUPS = [
  { channel: "MERCADO LIVRE", financial: ["MERCADO PAGO"], freight: ["MERCADO ENVIOS"] },
  { channel: "NUVEM SHOP", financial: ["NUVEM PAGO"], freight: ["NUVEM ENVIO"] },
  { channel: "TRAY", financial: ["VINDI"], freight: [] }
];
function deliveryAutoSetups(marketplaces = [], stores = []) {
  const active = new Set([...normalizeTextList(marketplaces), ...normalizeTextList(stores)].map(normalizeDeliveryChannel));
  const rules = DELIVERY_AUTO_SETUPS.filter((rule) => active.has(normalizeDeliveryChannel(rule.channel)));
  return { financial: normalizeTextList(rules.flatMap((rule) => rule.financial)), freight: normalizeTextList(rules.flatMap((rule) => rule.freight)) };
}
function projectStoreList(project) {
  return normalizeTextList(project?.store_platforms).length ? normalizeTextList(project.store_platforms) : normalizeTextList(project?.store_platform ? [project.store_platform] : []);
}
const MANAGED_DELIVERY_CHANNELS = new Set(Object.values(DELIVERY_CHANNEL_OPTIONS).flat().map(normalizeDeliveryChannel));
const deliveryChannelOptions = (group) => DELIVERY_CHANNEL_OPTIONS[group].map((value) => ({ value, label: value }));
function normalizeDeliveryChannel(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}
function activatedDeliveryChannels(project) {
  return new Set([
    project?.erp_platform,
    ...normalizeTextList(project?.marketplace_channels),
    ...normalizeTextList(project?.store_platforms),
    project?.store_platform,
    ...normalizeTextList(project?.freight_channels),
    ...normalizeTextList(project?.financial_accounts),
    ...Object.values(deliveryAutoSetups(project?.marketplace_channels, projectStoreList(project))).flat()
  ].filter(Boolean).map(normalizeDeliveryChannel));
}
function projectChannelEnabled(project, channel) {
  const normalized = normalizeDeliveryChannel(channel);
  return !normalized || !MANAGED_DELIVERY_CHANNELS.has(normalized) || activatedDeliveryChannels(project).has(normalized);
}
const MAX_PIPELINES = 5;
const SOURCES = ["Indicação", "Site", "Anúncio", "Evento", "LinkedIn", "Inbound", "Prospecção", "Outro"];
const RECURRENCE_OPTIONS = [
  ["once", "Única"], ["daily", "Diária"], ["weekly", "Semanal"], ["biweekly", "Quinzenal"], ["monthly", "Mensal"],
  ["bimonthly", "Bimestral"], ["quarterly", "Trimestral"], ["semiannual", "Semestral"], ["annual", "Anual"]
];
const RECURRENCE_LABEL = Object.fromEntries(RECURRENCE_OPTIONS);
const PRIORITY_OPTIONS = [["low", "Baixa"], ["normal", "Normal"], ["high", "Alta"], ["urgent", "Urgente"]];
const PRIORITY_LABEL = Object.fromEntries(PRIORITY_OPTIONS);
const TASK_GROUP_SUBGROUP_OPTIONS = {
  "Negócios": ["Comércio", "Contabilidade"],
  "Vendas": ["Canais", "Logística"],
  "Compras": ["Mercado", "Fornecedores"],
  "Gestão": ["Operação", "Dados"]
};
const TASK_GROUP_OPTIONS = Object.keys(TASK_GROUP_SUBGROUP_OPTIONS);
const TASK_SECTOR_OPTIONS = ["Administração", "Marketing", "Logística", "Produção", "Serviços", "Recursos Humanos", "Financeiro", "Contabilidade", "Jurídico"];
function canonicalTaskChoice(value, choices) {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
  return choices.find((choice) => choice.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR") === normalized) || "";
}
function taskSelectOptions(choices, value, emptyLabel) {
  const selected = canonicalTaskChoice(value, choices);
  return `<option value="">${esc(emptyLabel)}</option>${choices.map((choice) => `<option value="${esc(choice)}"${choice === selected ? " selected" : ""}>${esc(choice)}</option>`).join("")}`;
}
function wireTaskGroupSelect(groupId, subgroupId) {
  const group = document.getElementById(groupId);
  const subgroup = document.getElementById(subgroupId);
  if (!group || !subgroup) return;
  const update = (preserve = true) => {
    const previous = preserve ? subgroup.value : "";
    const choices = TASK_GROUP_SUBGROUP_OPTIONS[group.value] || [];
    subgroup.innerHTML = taskSelectOptions(choices, previous, choices.length ? "Sem subgrupo" : "Selecione o grupo primeiro");
    subgroup.disabled = !choices.length;
  };
  group.addEventListener("change", () => update(false));
  update(true);
}
const TASK_STRUCTURE_REQUIRED_LABEL = "Categoria, Canal, Módulo e Tipo";
function taskStructureFieldsFilled(fieldIds) {
  return fieldIds.every((id) => String(document.getElementById(id)?.value || "").trim());
}
function wireTaskStructureToggle(toggleId, inputId, labelId, requiredFieldIds = []) {
  const toggle = document.getElementById(toggleId);
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  if (!toggle || !input || !label) return;
  const locked = toggle.disabled;
  const baseLabel = label.textContent.replace(/\s*\*$/, "");
  const update = () => {
    if (!locked) {
      const ready = taskStructureFieldsFilled(requiredFieldIds);
      toggle.disabled = !ready;
      if (!ready) toggle.checked = false;
      toggle.closest("label")?.setAttribute("title", ready ? "" : `Preencha ${TASK_STRUCTURE_REQUIRED_LABEL} para usar a estrutura.`);
    }
    input.disabled = toggle.checked;
    input.required = !toggle.checked;
    label.textContent = toggle.checked ? baseLabel : `${baseLabel} *`;
  };
  toggle.addEventListener("change", update);
  requiredFieldIds.forEach((id) => document.getElementById(id)?.addEventListener("input", update));
  update();
}
const CONTACT_TYPE_OPTIONS = ["Colaborador", "Fornecedor", "Cliente", "Parceiro", "Network"];
// Tipos de contato que a empresa define e replica para as pessoas vinculadas.
const COMPANY_CONTACT_TYPE_OPTIONS = ["Cliente", "Fornecedor", "Parceiro"];
const BR_UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
const taxIdDigits = (value) => String(value || "").replace(/\D/g, "");
function companyHasDelivery(taxId) {
  const digits = taxIdDigits(taxId);
  return Boolean(digits) && (cache?.projects || []).some((project) => taxIdDigits(project.company_id) === digits);
}
const CONTACT_CHANNEL_OPTIONS = ["Facebook", "Instagram", "LinkedIn", "Reddit", "TikTok", "YouTube", "E-mail", "Telefone", "Evento", "Outros"];
function normalizeIdList(value, fallback = null) {
  let ids = value;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch (e) { ids = ids.replace(/^\{|\}$/g, "").split(","); }
  }
  const normalized = Array.isArray(ids) ? [...new Set(ids.map(String).map((id) => id.trim()).filter(Boolean))] : [];
  if (!normalized.length && fallback) normalized.push(String(fallback));
  return normalized;
}
function normalizeTextList(value) {
  let values = value;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch (e) { values = values.replace(/^\{|\}$/g, "").split(/[;,]/); }
  }
  return Array.isArray(values)
    ? [...new Map(values.map((item) => String(item || "").trim()).filter(Boolean).map((item) => [item.toLocaleLowerCase("pt-BR"), item])).values()]
    : [];
}
function priorityBadge(value) {
  const priority = PRIORITY_LABEL[value] ? value : "normal";
  return `<span class="badge priority-badge priority-${priority}">${esc(PRIORITY_LABEL[priority])}</span>`;
}
function normalizeChecklist(value) {
  let rows = value;
  if (typeof rows === "string") {
    try { rows = JSON.parse(rows); } catch (e) { rows = []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((item, index) => {
    if (typeof item === "string") return { id: `legacy-${index}`, text: item.trim(), checked: false };
    return {
      id: item?.id || `legacy-${index}`,
      text: String(item?.text || "").trim(),
      checked: Boolean(item?.checked)
    };
  }).filter((item) => item.text);
}
function mergeTemplateChecklist(templateValue, activityValue) {
  const checkedById = new Map(normalizeChecklist(activityValue).map((item) => [item.id, item.checked]));
  return normalizeChecklist(templateValue).map((item) => ({ ...item, checked: checkedById.get(item.id) || false }));
}
function checklistProgress(value) {
  const items = normalizeChecklist(value);
  return { total: items.length, done: items.filter((item) => item.checked).length };
}
const ENTITY_LABEL = { home: "Home", contacts: "Pessoas", companies: "Empresas", conversations: "Conversas", deals: "Negócios", products: "Produtos", projects: "Entregas", activities: "Tarefas" };
const SINGULAR = { contacts: "pessoa", companies: "empresa", conversations: "conversa", deals: "negócio", products: "produto", projects: "entrega" };
const PERMISSION_ACTIONS = [
  { id: "view", label: "Ver" }, { id: "create", label: "Cadastrar" },
  { id: "edit", label: "Editar" }, { id: "clone", label: "Clonar" },
  { id: "delete", label: "Excluir" }, { id: "operate", label: "Operar" }
];
const PERMISSION_GROUPS = [
  { label: "CMS", modules: [
    ["contacts", "Pessoas"], ["companies", "Empresas"], ["conversations", "Conversas"],
    ["deals", "Negócios"], ["projects", "Entregas"], ["activities", "Tarefas"]
  ] },
  { label: "Cadastros", modules: [
    ["products", "Produtos"], ["pipelines", "Pipeline"], ["users", "Usuários"],
    ["activityTemplates", "Tarefas"], ["goalTemplates", "Metas"], ["objectiveTemplates", "Objetivos"]
  ] },
  { label: "Ferramentas", modules: [
    ["files", "Arquivos"], ["emails", "Emails"], ["processes", "Processos"],
    ["documents", "Documentação"], ["tables", "Tabelas"]
  ] },
  { label: "Social", modules: [
    ["facebook", "Facebook"], ["instagram", "Instagram"], ["linkedin", "LinkedIn"],
    ["reddit", "Reddit"], ["tiktokshop", "TikTokShop"], ["youtube", "YouTube"]
  ] }
];
const REGISTRATION_PERMISSION_MODULE = {
  products: "products", pipelines: "pipelines", users: "users",
  activities: "activityTemplates", goals: "goalTemplates", objectives: "objectiveTemplates"
};
function defaultUserPermissions() {
  const permissions = {};
  PERMISSION_GROUPS.forEach((group) => group.modules.forEach(([moduleId]) => {
    const isMain = ["contacts", "companies", "conversations", "deals", "projects", "activities"].includes(moduleId);
    const isToolsOrSocial = ["files", "emails", "processes", "documents", "tables", "facebook", "instagram", "linkedin", "reddit", "tiktokshop", "youtube"].includes(moduleId);
    permissions[moduleId] = Object.fromEntries(PERMISSION_ACTIONS.map(({ id }) => [id, isMain || (isToolsOrSocial && id === "view")]));
    if (moduleId === "activities") permissions[moduleId].operate = true;
  }));
  return permissions;
}
function emptyUserPermissions() {
  const permissions = {};
  PERMISSION_GROUPS.forEach((group) => group.modules.forEach(([moduleId]) => {
    permissions[moduleId] = Object.fromEntries(PERMISSION_ACTIONS.map(({ id }) => [id, false]));
  }));
  return permissions;
}
function defaultPermissionsForRole(role) {
  if (role === "admin") return {};
  if (role === "collaborator" || role === "user") return defaultUserPermissions();
  const permissions = emptyUserPermissions();
  if (role === "developer") {
    Object.values(permissions).forEach((actions) => { actions.view = true; });
  } else if (role === "client") {
    ["companies", "contacts", "projects", "activities", "files"].forEach((moduleId) => {
      permissions[moduleId].view = true;
    });
  } else if (role === "supplier") {
    ["companies", "contacts", "projects", "activities", "files"].forEach((moduleId) => {
      permissions[moduleId].view = true;
    });
    permissions.activities.operate = true;
  }
  return permissions;
}
function normalizeUserPermissions(value) {
  const defaults = defaultUserPermissions();
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  Object.keys(defaults).forEach((moduleId) => {
    const moduleValue = source[moduleId];
    if (!moduleValue || typeof moduleValue !== "object") return;
    PERMISSION_ACTIONS.forEach(({ id }) => {
      if (typeof moduleValue[id] === "boolean") defaults[moduleId][id] = moduleValue[id];
    });
  });
  return defaults;
}
function modulePermissionLabel(moduleId) {
  for (const group of PERMISSION_GROUPS) {
    const module = group.modules.find(([id]) => id === moduleId);
    if (module) return module[1];
  }
  return ENTITY_LABEL[moduleId] || moduleId;
}
// Abas cujo formulário de cadastro abre em painel lateral (vindo da direita).
const SIDE_PANEL_TABS = new Set(["deals", "products", "projects", "contacts", "companies"]);

// Colunas usadas como chave primária real no banco (Supabase). Tudo que não
// estiver aqui usa "id" como padrão.
const PK_COLUMN = { companies: "tax_id" };
const pk = (tab) => PK_COLUMN[tab] || "id";

// A aba "deals" (Negócios) do app conversa com a tabela "negotiations" no
// Supabase — nome e uma coluna (amount/value) diferem, então a tradução
// fica só aqui, sem espalhar "negotiations" pelo resto do código.
const REMOTE_TABLE = {
  deals: "negotiations",
  users: "profiles",
  projects: "deliveries",
  productActivities: "product_activity_templates",
  productObjectives: "product_objective_templates",
  productGoals: "product_goal_templates",
  deliveryObjectives: "delivery_objectives",
  deliveryGoals: "delivery_goals",
  files: "company_files",
  processes: "training_processes",
  documents: "company_documents",
  customTables: "custom_tables",
  contactCompanies: "contact_companies",
  activityComments: "activity_comments",
  directMessages: "direct_messages"
};
const remoteTable = (tab) => REMOTE_TABLE[tab] || tab;
// Estado do tempo real (ver seção "Tempo real").
const LIVE_TABLES = ["activities", "activity_comments", "deliveries", "negotiations", "contacts", "companies", "delivery_objectives", "delivery_goals"];
const LIVE_TOPIC = "realtime:cms-live";
const liveState = { socket: null, ref: 0, heartbeat: null, tokenTimer: null, retry: 0, reconnectTimer: null, pending: 0, ownWrites: new Map(), commentsActivityId: null, stopped: false, connectedOnce: false };
const DATA_PERMISSION_MODULE = {
  users: "users", products: "products", pipelines: "pipelines",
  productActivities: "activityTemplates", productObjectives: "objectiveTemplates", productGoals: "goalTemplates",
  deliveryObjectives: "projects", deliveryGoals: "projects",
  files: "files", processes: "processes", documents: "documents", customTables: "tables"
};
function dataPermissionModule(table) {
  return DATA_PERMISSION_MODULE[table] || table;
}
function requireDataPermission(table, action) {
  const moduleId = dataPermissionModule(table);
  const allowed = action === "create"
    ? currentUserCan(moduleId, "create") || currentUserCan(moduleId, "clone")
    : action === "edit" && moduleId === "activities"
      ? currentUserCan(moduleId, "edit") || currentUserCan(moduleId, "operate")
      : currentUserCan(moduleId, action);
  if (allowed) return true;
  toast(`Sem permissão para ${PERMISSION_ACTIONS.find((item) => item.id === action)?.label.toLocaleLowerCase("pt-BR") || action} em ${modulePermissionLabel(moduleId)}.`, true);
  return false;
}
const FIELD_REMAP = {
  deals: { amount: "value" },
  activities: { project_id: "delivery_id", group: "group_name", subgroup: "subgroup_name", module: "module_name", submodule: "submodule_name", type: "activity_type" },
  deliveryObjectives: { project_id: "delivery_id" },
  deliveryGoals: { project_id: "delivery_id" },
  productActivities: { group: "group_name", subgroup: "subgroup_name", module: "module_name", submodule: "submodule_name", type: "activity_type" },
  customTables: { columns: "column_definitions", rows: "row_data" }
}; // chave local -> chave remota
function toRemoteBody(tab, body) {
  const map = FIELD_REMAP[tab];
  if (!map) return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) out[map[k] || k] = v;
  return out;
}
function fromRemoteRow(tab, row) {
  const map = FIELD_REMAP[tab];
  if (!map || !row) return row;
  const out = { ...row };
  for (const [localKey, remoteKey] of Object.entries(map)) {
    if (remoteKey in out) { out[localKey] = out[remoteKey]; delete out[remoteKey]; }
  }
  return out;
}

// ---------- Dados de exemplo (mutáveis em memória quando offline) ----------
const DEMO = {
  users: [
    { id: "u1", full_name: "Ana Ferreira", nickname: "Ana", email: "ana@upgferreira.com", phone: "", role: "admin", status: "active" },
    { id: "u2", full_name: "Bruno Lima", nickname: "Bruno", email: "bruno@upgferreira.com", phone: "", role: "collaborator", status: "active" }
  ],
  pipelines: [
    { id: "pl1", name: "Padrão", stages: ["Lead", "Qualificação", "Diagnóstico", "Proposta", "Negociação"] }
  ],
  companies: [
    { tax_id: "12.345.678/0001-90", legal_name: "REDE ALFA VAREJO LTDA", trade_name: "Rede Alfa", email: "contato@alfa.com", phone: "(12) 3300-1000", headquarters: "Matriz", founded_at: "2026-05-02", registration_status: "Ativa", activities: "47.89-0-99 — Comércio varejista de outros produtos", address: "Avenida Central, 100 - Centro", zip_code: "12300-000", city: "São José dos Campos", state: "SP", notes: "" },
    { tax_id: "98.765.432/0001-10", legal_name: "INDÚSTRIA BETA LTDA", trade_name: "Beta", email: "comercial@beta.com", phone: "(12) 3300-2000", headquarters: "Matriz", founded_at: "2026-05-10", registration_status: "Ativa", activities: "28.29-1-99 — Fabricação de outras máquinas e equipamentos", address: "Rua Ipe, 163 - Vila Industrial", zip_code: "12400-000", city: "Pindamonhangaba", state: "SP", notes: "" },
    { tax_id: "45.111.222/0001-33", legal_name: "CLÍNICA GAMA SERVIÇOS MÉDICOS LTDA", trade_name: "Clínica Gama", email: "atendimento@gama.com", phone: "(12) 3300-3000", headquarters: "Matriz", founded_at: "2026-06-01", registration_status: "Ativa", activities: "86.30-5-03 — Atividade médica ambulatorial restrita a consultas", address: "Rua Saúde, 45 - Jardim Europa", zip_code: "12500-000", city: "Taubaté", state: "SP", notes: "" },
    { tax_id: "22.333.444/0001-55", legal_name: "LOGÍSTICA DELTA LTDA", trade_name: "Delta Log", email: "operacoes@delta.com", phone: "(12) 3300-4000", headquarters: "Filial", founded_at: "2026-06-18", registration_status: "Ativa", activities: "52.11-7-99 — Depósitos de mercadorias para terceiros", address: "Rodovia SP-000, km 12 - Distrito Industrial", zip_code: "12600-000", city: "Jacareí", state: "SP", notes: "" }
  ],
  contacts: [
    { id: "p1", name: "Carla Souza", phone: "(12) 99111-0001", email: "carla@alfa.com", contact_type: "Cliente", channel: "LinkedIn", job_title: "Gerente de RH", company_id: "12.345.678/0001-90", linkedin: "linkedin.com/in/carlasouza", facebook: "", instagram: "@carla.souza", reddit: "", whatsapp: "(12) 99111-0001", youtube: "", groups: "RH Brasil", birth_date: "1988-03-12", cpf: "123.456.789-00" },
    { id: "p2", name: "Diego Alves", phone: "(12) 99111-0002", email: "diego@beta.com", contact_type: "Prospect", channel: "Indicação", job_title: "Diretor Comercial", company_id: "98.765.432/0001-10", linkedin: "linkedin.com/in/diegoalves", facebook: "", instagram: "", reddit: "", whatsapp: "(12) 99111-0002", youtube: "", groups: "B2B Sales", birth_date: "1982-09-21", cpf: "987.654.321-00" },
    { id: "p3", name: "Elaine Costa", phone: "(12) 99111-0003", email: "elaine@gama.com", contact_type: "Parceiro", channel: "Evento", job_title: "Coord. de Treinamento", company_id: "45.111.222/0001-33", linkedin: "", facebook: "facebook.com/elaine.costa", instagram: "@elainecosta", reddit: "", whatsapp: "(12) 99111-0003", youtube: "", groups: "Educação Corporativa", birth_date: "1990-01-05", cpf: "111.222.333-44" },
    { id: "p4", name: "Felipe Rocha", phone: "(12) 99111-0004", email: "felipe@delta.com", contact_type: "Cliente", channel: "WhatsApp", job_title: "Gestor de Operações", company_id: "22.333.444/0001-55", linkedin: "linkedin.com/in/feliperocha", facebook: "", instagram: "", reddit: "u/feliperocha", whatsapp: "(12) 99111-0004", youtube: "", groups: "Operações e Logística", birth_date: "1985-07-17", cpf: "222.333.444-55" }
  ],
  products: [
    { id: "pr1", category: "Treinamentos", name: "Formação em Liderança", description: "Programa 40h in-company", price: 18000, price_installment: 19800, sales_page: "https://upgferreira.com/lideranca", status: "Ativo", duration_days: 45 },
    { id: "pr2", category: "Cursos", name: "Excel Avançado", description: "Turma fechada 20h", price: 7500, price_installment: 8200, sales_page: "https://upgferreira.com/excel", status: "Ativo", duration_days: 18 },
    { id: "pr3", category: "Onboarding", name: "Onboarding Comercial", description: "Trilha de vendas 16h", price: 9800, price_installment: 10600, sales_page: "https://upgferreira.com/onboarding", status: "Ativo", duration_days: 18 }
  ],
  deals: [
    { id: "d1", title: "Liderança 2 turmas", company_id: "12.345.678/0001-90", contact_id: "p1", product_id: "pr1", owner_id: "u1", pipeline_id: "pl1", stage: "Proposta", status: "open", amount: 36000, lead_source: "Indicação", expected_close_date: "2026-07-20" },
    { id: "d2", title: "Excel RH", company_id: "98.765.432/0001-10", contact_id: "p2", product_id: "pr2", owner_id: "u2", pipeline_id: "pl1", stage: "Diagnóstico", status: "open", amount: 7500, lead_source: "Site", expected_close_date: "2026-07-30" },
    { id: "d3", title: "Trilha vendas Q3", company_id: "45.111.222/0001-33", contact_id: "p3", product_id: "pr3", owner_id: "u1", pipeline_id: "pl1", stage: "Negociação", status: "open", amount: 19600, lead_source: "Evento", expected_close_date: "2026-07-15" },
    { id: "d4", title: "Liderança piloto", company_id: "22.333.444/0001-55", contact_id: "p4", product_id: "pr1", owner_id: "u2", pipeline_id: "pl1", stage: "Lead", status: "open", amount: 18000, lead_source: "LinkedIn", expected_close_date: "2026-08-10" },
    { id: "d5", title: "Excel fechado", company_id: "12.345.678/0001-90", contact_id: "p1", product_id: "pr2", owner_id: "u1", pipeline_id: "pl1", stage: "Qualificação", status: "open", amount: 7500, lead_source: "Inbound", expected_close_date: "2026-08-01" },
    { id: "d6", title: "Onboarding Delta", company_id: "22.333.444/0001-55", contact_id: "p4", product_id: "pr3", owner_id: "u2", pipeline_id: "pl1", stage: "Negociação", status: "won", amount: 9800, lead_source: "Indicação", expected_close_date: "2026-06-28" }
  ],
  projects: [
    { id: "pj1", name: "EC365 | Rede Alfa | Formação em Liderança", group_name: "", client_name: "Rede Alfa", company_id: "12.345.678/0001-90", product_id: "pr1", owner_id: "u1", negotiation_id: null, status: "active", substatus: "", source: "manual", start_date: "2026-07-01", end_date: "2026-08-15" },
    { id: "pj2", name: "EC365 | Beta | Excel Avançado", group_name: "", client_name: "Beta", company_id: "98.765.432/0001-10", product_id: "pr2", owner_id: "u2", negotiation_id: null, status: "active", substatus: "", source: "manual", start_date: "2026-07-18", end_date: "2026-08-05" },
    { id: "pj3", name: "EC365 | Delta Log | Onboarding Comercial", group_name: "", client_name: "Delta Log", company_id: "22.333.444/0001-55", product_id: "pr3", owner_id: "u2", negotiation_id: "d6", status: "closed", substatus: "closed", source: "negotiation", start_date: "2026-06-10", end_date: "2026-06-28" }
  ],
  conversations: [],
  activities: [],
  productActivities: [],
  productObjectives: [],
  productGoals: [],
  deliveryObjectives: [],
  deliveryGoals: [],
  files: [],
  processes: [],
  documents: [],
  customTables: [],
  contactCompanies: [],
  activityComments: [],
  directMessages: []
};

// ---------- REST Supabase ----------
async function api(path, opts = {}) {
  const c = getCfg();
  const token = await getAccessToken();
  if (isLive() && !token) {
    showLogin("Sua sessão expirou. Entre novamente.");
    throw new Error("Sessão expirada");
  }
  const method = String(opts.method || "GET").toUpperCase();
  if (currentProfile && ["developer", "client"].includes(currentProfile.role) && !["GET", "HEAD"].includes(method)) {
    const label = currentProfile.role === "developer" ? "Desenvolvedor" : "Cliente";
    throw new Error(`Perfil ${label}: alterações no banco estão bloqueadas.`);
  }
  const headers = { apikey: c.anonKey, Authorization: `Bearer ${token || c.anonKey}`, ...(opts.headers || {}) };
  const startedAt = performance.now();
  const [resource, query = ""] = String(path).split("?");
  noteOwnWrite(resource, query, method);
  const entry = { at: new Date().toISOString(), method, resource, query: query.slice(0, 300), status: 0, ms: 0, error: "" };
  let res;
  try {
    res = await fetch(`${c.url}/rest/v1/${path}`, { ...opts, headers });
  } catch (networkError) {
    entry.ms = Math.round(performance.now() - startedAt);
    entry.error = networkError?.message || "Falha de rede";
    recordApiRequest(entry);
    throw networkError;
  }
  entry.status = res.status;
  entry.ms = Math.round(performance.now() - startedAt);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    entry.error = `${res.statusText}${txt ? " · " + txt.slice(0, 500) : ""}`.trim();
    recordApiRequest(entry);
    if (res.status === 401) {
      storeAuthSession(null);
      showLogin("Sua sessão expirou. Entre novamente.");
    }
    throw new Error(`${res.status} ${res.statusText}${txt ? " · " + txt.slice(0, 120) : ""}`);
  }
  recordApiRequest(entry);
  if (res.status === 204) return null;
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}

// ---------- Diagnóstico de chamadas e atividades dos usuários ----------
const API_REQUEST_LOG = [];
const API_REQUEST_LOG_LIMIT = 500;
const DIAGNOSTIC_TABLES = new Set(["user_activities", "app_request_errors"]);
function diagnosticInsert(table, body) {
  if (!isLive() || !currentProfile?.id) return;
  const c = getCfg();
  getAccessToken().then((token) => {
    if (!token) return null;
    return fetch(`${c.url}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ profile_id: currentProfile.id, ...body })
    });
  }).catch(() => {});
}
function recordApiRequest(entry) {
  API_REQUEST_LOG.unshift(entry);
  if (API_REQUEST_LOG.length > API_REQUEST_LOG_LIMIT) API_REQUEST_LOG.length = API_REQUEST_LOG_LIMIT;
  if (entry.error && !DIAGNOSTIC_TABLES.has(entry.resource) && entry.status !== 401) {
    diagnosticInsert("app_request_errors", { method: entry.method, path: `${entry.resource}${entry.query ? `?${entry.query}` : ""}`.slice(0, 600), status: entry.status || null, message: entry.error.slice(0, 1000) });
  }
}
let activityLogSuppressed = 0;
const ACTIVITY_ENTITY_LABEL = {
  companies: "Empresa", contacts: "Pessoa", deals: "Negócio", products: "Produto", projects: "Entrega", activities: "Tarefa",
  users: "Usuário", pipelines: "Pipeline", productActivities: "Tarefa (cadastro)", productObjectives: "Objetivo (cadastro)",
  productGoals: "Meta (cadastro)", deliveryObjectives: "Objetivo", deliveryGoals: "Meta", files: "Arquivo", processes: "Processo",
  documents: "Documento", customTables: "Tabela", activityComments: "Comentário"
};
const ACTIVITY_LOG_SKIP_TABLES = new Set(["directMessages", "contactCompanies"]);
function activitySourceRows(table) {
  try {
    if (table === "activities") return cache?.activityRecords || [];
    if (table === "productActivities") return loadProductActivities();
    if (table === "productObjectives") return loadProductObjectives();
    if (table === "productGoals") return loadProductGoals();
    if (table === "deliveryObjectives") return loadDeliveryObjectives();
    if (table === "deliveryGoals") return loadDeliveryGoals();
    return Array.isArray(cache?.[table]) ? cache[table] : [];
  } catch (e) { return []; }
}
function activityRecordLabel(table, id, body = {}) {
  const key = pk(table);
  const stored = id == null ? null : activitySourceRows(table).find((item) => item?.[key] === id);
  const source = { ...(stored || {}), ...(body || {}) };
  if (["activities", "productActivities"].includes(table)) {
    const label = activityDisplayName(source);
    return label === "—" ? "" : label.slice(0, 200);
  }
  return String(source.name || source.title || source.trade_name || source.legal_name || source.full_name || source.email || source.body || "").slice(0, 200);
}
function activityUpdateVerb(table, body = {}) {
  const keys = Object.keys(body || {}).filter((key) => !["updated_at", "actual_start_date", "actual_end_date"].includes(key));
  if (body?.status && keys.length === 1 && ["activities", "deliveryObjectives", "deliveryGoals"].includes(table)) {
    return { done: "Concluiu", doing: "Iniciou", todo: "Reabriu", canceled: "Cancelou" }[body.status] || "Alterou status de";
  }
  return "Editou";
}
function logUserActivity(action, table = null, id = null, label = "") {
  if (!isLive() || activityLogSuppressed > 0) return;
  if (table && ACTIVITY_LOG_SKIP_TABLES.has(table)) return;
  diagnosticInsert("user_activities", {
    action,
    entity_type: table ? (ACTIVITY_ENTITY_LABEL[table] || table) : null,
    entity_id: id == null ? null : String(id),
    entity_label: label || null
  });
}
function withActivityLogSuppressed(fn) {
  return async function (...args) {
    activityLogSuppressed += 1;
    try { return await fn.apply(this, args); }
    finally { activityLogSuppressed -= 1; }
  };
}

async function fetchTable(name) {
  if (!isLive()) return DEMO[name] || [];
  const pageSize = 1000;
  const order = name === "contactCompanies" ? "contact_id.asc,company_id.asc" : `${pk(name)}.asc`;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await api(`${remoteTable(name)}?select=*&order=${order}&offset=${offset}&limit=${pageSize}`);
    if (!Array.isArray(page)) return page;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map((row) => fromRemoteRow(name, row));
}
async function createRow(table, body) {
  if (!requireDataPermission(table, "create")) throw new Error("Operação não permitida para este usuário.");
  if (!isLive()) {
    const row = PK_COLUMN[table] ? { ...body } : { id: crypto.randomUUID(), ...body };
    DEMO[table].push(row);
    return row;
  }
  const j = { "Content-Type": "application/json", Prefer: "return=representation" };
  const r = await api(remoteTable(table), { method: "POST", headers: j, body: JSON.stringify(toRemoteBody(table, body)) });
  const row = Array.isArray(r) ? r[0] : r;
  const created = fromRemoteRow(table, row);
  logUserActivity("Criou", table, created?.[pk(table)] ?? body?.[pk(table)], activityRecordLabel(table, null, { ...body, ...(created || {}) }));
  return created;
}
async function createActivityOrLoadExisting(body) {
  try {
    return await createRow("activities", body);
  } catch (error) {
    if (!isLive() || !String(error?.message || error).startsWith("409 ") || !body.source_template_id) throw error;
    const rows = await api(`${remoteTable("activities")}?select=*&delivery_id=eq.${encodeURIComponent(body.project_id)}&source_template_id=eq.${encodeURIComponent(body.source_template_id)}&occurrence_index=eq.${encodeURIComponent(Number(body.occurrence_index || 0))}&limit=1`);
    const existing = Array.isArray(rows) ? rows[0] : null;
    if (!existing) throw error;
    return fromRemoteRow("activities", existing);
  }
}
async function updateRow(table, id, body) {
  if (!requireDataPermission(table, "edit")) throw new Error("Operação não permitida para este usuário.");
  const k = pk(table);
  if (!isLive()) { const r = DEMO[table].find((x) => x[k] === id); Object.assign(r, body); return r; }
  const j = { "Content-Type": "application/json", Prefer: "return=representation" };
  const r = await api(`${remoteTable(table)}?${k}=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: j, body: JSON.stringify(toRemoteBody(table, body)) });
  const row = Array.isArray(r) ? r[0] : r;
  const updated = fromRemoteRow(table, row);
  logUserActivity(activityUpdateVerb(table, body), table, id, activityRecordLabel(table, id, { ...body, ...(updated || {}) }));
  return updated;
}
async function deleteRow(table, id) {
  if (!requireDataPermission(table, "delete")) throw new Error("Operação não permitida para este usuário.");
  const k = pk(table);
  if (!isLive()) { DEMO[table] = DEMO[table].filter((x) => x[k] !== id); return; }
  const label = activityRecordLabel(table, id);
  const result = await api(`${remoteTable(table)}?${k}=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  logUserActivity("Excluiu", table, id, label);
  return result;
}

async function emailAccountsRequest(method = "GET", body = null) {
  if (APP_VARIANT !== "web" || !isLive()) throw new Error("A criação automática de e-mail está disponível na versão web conectada.");
  const permissionAction = method === "GET" ? "view" : method === "DELETE" ? "delete" : body?.action === "update-metadata" ? "edit" : "create";
  if (!requireCurrentUserPermission("emails", permissionAction, "Emails")) throw new Error("Operação não permitida para este usuário.");
  const c = getCfg();
  const token = await getAccessToken();
  if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
  const response = await fetch(`${c.url}/functions/v1/provision-client-email`, {
    method,
    headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Falha ao acessar os e-mails (${response.status})`);
  return data;
}

async function provisionDeliveryEmail(project, { notify = true } = {}) {
  if (APP_VARIANT !== "web" || !isLive() || !project?.id) return null;
  try {
    const result = await emailAccountsRequest("POST", { deliveryId: project.id });
    remoteToolEmailsLoaded = true;
    remoteToolEmailsLoadedAt = Date.now();
    if (result.account) {
      const index = remoteToolEmails.findIndex((account) => account.id === result.account.id);
      if (index >= 0) remoteToolEmails[index] = result.account;
      else remoteToolEmails.unshift(result.account);
    }
    if (notify) {
      const message = result.status === "created"
        ? `E-mail ${result.account.email} criado na HostGator.`
        : result.status === "existing_unmanaged"
          ? `E-mail ${result.account.email} já existe na HostGator. A senha anterior não pode ser recuperada.`
          : `E-mail ${result.account.email} já estava criado.`;
      toast(message);
    }
    return result.account;
  } catch (err) {
    if (notify) toast("Entrega salva, mas o e-mail não foi criado · " + err.message, true);
    return null;
  }
}

function showDeliveryClientCredentials(credential) {
  if (!credential?.email || !credential?.password) return;
  const access = `ENTERPRISER • CMS\nEmpresa: ${credential.company || "Cliente"}\nE-mail: ${credential.email}\nSenha: ${credential.password}`;
  sidePanel("Acesso do cliente", `<div class="panel-list"><b>Acesso criado automaticamente</b><p>Copie estes dados agora. Por segurança, a senha não poderá ser consultada depois.</p></div>
    <div class="form">
      <div class="field full"><label>Empresa</label><input value="${esc(credential.company || "Cliente")}" readonly></div>
      <div class="field full"><label>E-mail</label><input value="${esc(credential.email)}" readonly></div>
      <div class="field full"><label>Senha</label><div class="input-action-row"><input value="${esc(credential.password)}" readonly><button class="btn primary" id="copy-delivery-client-access" type="button">Copiar acesso</button></div></div>
    </div>`, { closeOnOverlay: true });
  document.getElementById("copy-delivery-client-access")?.addEventListener("click", async () => {
    await copyText(access);
    toast("Acesso do cliente copiado.");
  });
}

async function provisionDeliveryClientAccess(project, { notify = true } = {}) {
  if (APP_VARIANT !== "web" || !isLive() || !project?.id) return null;
  try {
    const result = await callUserAdmin("provision-delivery-client", { delivery_id: project.id });
    if (result.profile) upsertCachedEntity("users", result.profile);
    if (notify) toast(result.created ? `Acesso ${result.email} criado para o cliente.` : `Acesso ${result.email} vinculado ao cliente.`);
    if (result.credential) setTimeout(() => showDeliveryClientCredentials(result.credential), 0);
    return result;
  } catch (err) {
    if (notify) toast("Entrega salva, mas o acesso do cliente não foi criado · " + err.message, true);
    return null;
  }
}

async function provisionDeliveryResources(project) {
  const [emailAccount, clientAccess] = await Promise.all([
    provisionDeliveryEmail(project),
    provisionDeliveryClientAccess(project),
  ]);
  return { emailAccount, clientAccess };
}

// ---------- Cache ----------
let cache = null;
function loadConversations() {
  try {
    const rows = JSON.parse(localStorage.getItem("crm_conversations") || "null");
    if (Array.isArray(rows)) return rows;
  } catch (e) {}
  try {
    const legacy = JSON.parse(localStorage.getItem("crm_imports") || "[]");
    if (Array.isArray(legacy) && legacy.length) {
      localStorage.setItem("crm_conversations", JSON.stringify(legacy));
      return legacy;
    }
  } catch (e) {}
  return [];
}
function saveConversations(rows) {
  localStorage.setItem("crm_conversations", JSON.stringify(rows));
  if (cache) cache.conversations = rows;
}
function loadProjectTasks() {
  if (isLive() && cache?.activityRecords) return cache.activityRecords;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_project_tasks") || "[]");
    return Array.isArray(rows) ? rows : [];
  }
  catch (e) { return []; }
}
function saveProjectTasks(rows) {
  localStorage.setItem("crm_project_tasks", JSON.stringify(rows));
  if (cache && !isLive()) cache.activityRecords = rows;
}
function operationalProjectTasks(projectId = null) {
  return loadProjectTasks().filter((task) => {
    if (projectId && task.project_id !== projectId) return false;
    return projectChannelEnabled(cache?.projectById?.[task.project_id], task.channel);
  });
}
function loadProductActivities() {
  if (isLive() && cache?.productActivities) return cache.productActivities;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_product_activities") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveProductActivities(rows) {
  localStorage.setItem("crm_product_activities", JSON.stringify(rows));
  if (cache && !isLive()) cache.productActivities = rows;
}
function loadProductObjectives() {
  if (isLive() && cache?.productObjectives) return cache.productObjectives;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_product_objectives") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveProductObjectives(rows) {
  localStorage.setItem("crm_product_objectives", JSON.stringify(rows));
  if (cache && !isLive()) cache.productObjectives = rows;
}
function loadProductGoals() {
  if (isLive() && cache?.productGoals) return cache.productGoals;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_product_goals") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveProductGoals(rows) {
  localStorage.setItem("crm_product_goals", JSON.stringify(rows));
  if (cache && !isLive()) cache.productGoals = rows;
}
function loadDeliveryObjectives() {
  if (isLive() && cache?.deliveryObjectives) return cache.deliveryObjectives;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_delivery_objectives") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveDeliveryObjectives(rows) {
  localStorage.setItem("crm_delivery_objectives", JSON.stringify(rows));
  if (cache && !isLive()) cache.deliveryObjectives = rows;
}
function loadDeliveryGoals() {
  if (isLive() && cache?.deliveryGoals) return cache.deliveryGoals;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_delivery_goals") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveDeliveryGoals(rows) {
  localStorage.setItem("crm_delivery_goals", JSON.stringify(rows));
  if (cache && !isLive()) cache.deliveryGoals = rows;
}
function activityRemoteBody(task) {
  return {
    id: task.id,
    project_id: task.project_id,
    parent_activity_id: task.parent_activity_id || null,
    source_template_id: task.source_template_id || null,
    occurrence_index: Number(task.occurrence_index || 0),
    depends_on_activity_id: task.depends_on_activity_id || null,
    dependency_ids: normalizeIdList(task.dependency_ids, task.depends_on_activity_id),
    objective_id: task.objective_id || null,
    title: task.title,
    information: task.information || null,
    sort_order: Number(task.sort_order || 0),
    group: task.group || null,
    subgroup: task.subgroup || null,
    sector: task.sector || null,
    subsector: task.subsector || null,
    module: task.module || null,
    submodule: task.submodule || null,
    category: task.category || null,
    channel: task.channel || null,
    type: task.type || null,
    recurrence: task.recurrence || "once",
    checklist: normalizeChecklist(task.checklist),
    owner_id: task.owner_id || null,
    assignee_ids: normalizeIdList(task.assignee_ids, task.owner_id),
    assignee_job_titles: normalizeTextList(task.assignee_job_titles),
    assign_to_client: Boolean(task.assign_to_client),
    priority: task.priority || "normal",
    due_date: task.due_date || null,
    planned_start_date: task.planned_start_date || null,
    planned_end_date: task.planned_end_date || task.due_date || null,
    actual_start_date: task.actual_start_date || null,
    actual_end_date: task.actual_end_date || null,
    notes: task.notes || null,
    document_ids: normalizeIdList(task.document_ids),
    custom_table_ids: normalizeIdList(task.custom_table_ids),
    start_after_days: task.start_after_days == null || task.start_after_days === "" ? null : Number(task.start_after_days),
    schedule_manual: Boolean(task.schedule_manual),
    status: task.status || "todo",
    created_at: task.created_at || new Date().toISOString(),
    updated_at: task.updated_at || new Date().toISOString()
  };
}
function productActivityRemoteBody(template) {
  return {
    id: template.id,
    product_id: template.product_id,
    parent_template_id: template.parent_template_id || null,
    depends_on_template_id: template.depends_on_template_id || null,
    dependency_template_ids: normalizeIdList(template.dependency_template_ids, template.depends_on_template_id),
    group: template.group || null,
    subgroup: template.subgroup || null,
    sector: template.sector || null,
    subsector: template.subsector || null,
    module: template.module || null,
    submodule: template.submodule || null,
    category: template.category || null,
    channel: template.channel || null,
    type: template.type || null,
    activity: template.activity,
    information: template.information || null,
    default_owner_id: template.default_owner_id || null,
    default_assignee_ids: normalizeIdList(template.default_assignee_ids, template.default_owner_id),
    default_assignee_job_titles: normalizeTextList(template.default_assignee_job_titles),
    assign_to_client: Boolean(template.assign_to_client),
    template_group_id: template.template_group_id || crypto.randomUUID(),
    priority: template.priority || "normal",
    objective_template_id: template.objective_template_id || null,
    recurrence: template.recurrence || "once",
    target_days: template.target_days == null ? null : Number(template.target_days),
    start_after_days: template.start_after_days == null || template.start_after_days === "" ? null : Number(template.start_after_days),
    consider_business_days: Boolean(template.consider_business_days),
    checklist: normalizeChecklist(template.checklist).map((item) => ({ ...item, checked: false })),
    document_ids: normalizeIdList(template.document_ids),
    custom_table_ids: normalizeIdList(template.custom_table_ids),
    sort_order: Number(template.sort_order || 0),
    created_at: template.created_at || new Date().toISOString(),
    updated_at: template.updated_at || new Date().toISOString()
  };
}
async function migrateLocalOperationalData() {
  if (!isLive()) return;
  const localTemplates = (() => { try { return JSON.parse(localStorage.getItem("crm_product_activities") || "[]"); } catch (e) { return []; } })();
  const localTasks = (() => { try { return JSON.parse(localStorage.getItem("crm_project_tasks") || "[]"); } catch (e) { return []; } })();
  const remainingTemplates = [];
  for (const template of Array.isArray(localTemplates) ? localTemplates : []) {
    if (cache.productActivities.some((row) => row.id === template.id)) continue;
    if (!cache.productById[template.product_id]) { remainingTemplates.push(template); continue; }
    try {
      const saved = await createRow("productActivities", productActivityRemoteBody(template));
      cache.productActivities.push(saved);
    } catch (e) { remainingTemplates.push(template); }
  }
  const remainingTasks = [];
  for (const task of Array.isArray(localTasks) ? localTasks : []) {
    const already = cache.activityRecords.some((row) => row.id === task.id ||
      (task.source_template_id && row.project_id === task.project_id && row.source_template_id === task.source_template_id
        && Number(row.occurrence_index || 0) === Number(task.occurrence_index || 0)));
    if (already) continue;
    if (!cache.projectById[task.project_id]) { remainingTasks.push(task); continue; }
    const compatible = { ...task };
    if (compatible.source_template_id && !cache.productActivities.some((row) => row.id === compatible.source_template_id)) {
      compatible.source_template_id = null;
    }
    try {
      const saved = await createRow("activities", activityRemoteBody(compatible));
      cache.activityRecords.push(saved);
    } catch (e) { remainingTasks.push(task); }
  }
  if (remainingTemplates.length) localStorage.setItem("crm_product_activities", JSON.stringify(remainingTemplates));
  else if (localTemplates?.length) localStorage.removeItem("crm_product_activities");
  if (remainingTasks.length) localStorage.setItem("crm_project_tasks", JSON.stringify(remainingTasks));
  else if (localTasks?.length) localStorage.removeItem("crm_project_tasks");
}
async function syncProductObjectives() {
  if (!cache) return;
  const templates = loadProductObjectives();
  const objectives = loadDeliveryObjectives();
  let changed = false;
  for (const project of cache.projects || []) {
    for (const template of templates.filter((item) => item.product_id === project.product_id)) {
      const current = objectives.find((item) => item.project_id === project.id && item.source_template_id === template.id);
      const structural = {
        name: template.name,
        completion_criteria: template.completion_criteria || "",
        comments: template.comments || "",
        category: template.category || "",
        channel: template.channel || "",
        notes: template.notes || "",
        sort_order: Number(template.sort_order || 0)
      };
      const suggestedDue = project.start_date && template.target_days != null
        ? addDays(project.start_date, template.target_days)
        : null;
      if (current) {
        const updates = { ...structural };
        const defaultAssignees = normalizeIdList(template.default_assignee_ids, template.default_owner_id);
        if (!normalizeIdList(current.assignee_ids, current.owner_id).length && defaultAssignees.length) {
          updates.assignee_ids = defaultAssignees;
          updates.owner_id = defaultAssignees[0];
        }
        if (!current.assign_to_client && template.assign_to_client) updates.assign_to_client = true;
        if (!current.due_date && suggestedDue) updates.due_date = suggestedDue;
        if (Object.entries(updates).some(([key, value]) => current[key] !== value)) {
          Object.assign(current, updates, { updated_at: new Date().toISOString() });
          if (isLive()) await updateRow("deliveryObjectives", current.id, updates);
          changed = true;
        }
        continue;
      }
      const now = new Date().toISOString();
      const body = {
        id: crypto.randomUUID(), project_id: project.id, source_template_id: template.id,
        ...structural,
        owner_id: normalizeIdList(template.default_assignee_ids, template.default_owner_id)[0] || null,
        assignee_ids: normalizeIdList(template.default_assignee_ids, template.default_owner_id),
        assign_to_client: Boolean(template.assign_to_client), due_date: suggestedDue,
        status: "todo", created_at: now, updated_at: now
      };
      const saved = isLive() ? await createRow("deliveryObjectives", body) : body;
      objectives.push(saved);
      changed = true;
    }
  }
  if (changed) {
    if (isLive()) cache.deliveryObjectives = objectives;
    else saveDeliveryObjectives(objectives);
  }
}
async function syncDeliveryObjectiveDependencies() {
  if (!cache) return;
  const templates = loadProductObjectives();
  const objectives = loadDeliveryObjectives();
  const tasks = operationalProjectTasks();
  let changed = false;
  for (const objective of objectives) {
    const template = templates.find((item) => item.id === objective.source_template_id);
    if (!template) continue;
    const dependencyObjectiveIds = normalizeIdList(template.dependency_objective_template_ids)
      .map((templateId) => objectives.find((item) => item.project_id === objective.project_id && item.source_template_id === templateId)?.id)
      .filter(Boolean);
    const dependencyActivityIds = normalizeIdList(template.dependency_activity_template_ids)
      .flatMap((templateId) => tasks
        .filter((item) => item.project_id === objective.project_id && item.source_template_id === templateId)
        .sort(activityOccurrenceSort)
        .map((item) => item.id));
    const sameObjectives = JSON.stringify(normalizeIdList(objective.dependency_objective_ids)) === JSON.stringify(dependencyObjectiveIds);
    const sameActivities = JSON.stringify(normalizeIdList(objective.dependency_activity_ids)) === JSON.stringify(dependencyActivityIds);
    if (sameObjectives && sameActivities) continue;
    const updates = { dependency_objective_ids: dependencyObjectiveIds, dependency_activity_ids: dependencyActivityIds };
    Object.assign(objective, updates, { updated_at: new Date().toISOString() });
    if (isLive()) await updateRow("deliveryObjectives", objective.id, updates);
    changed = true;
  }
  if (changed) {
    if (isLive()) cache.deliveryObjectives = objectives;
    else saveDeliveryObjectives(objectives);
  }
}
async function syncProductGoals() {
  if (!cache) return;
  const templates = loadProductGoals();
  const goals = loadDeliveryGoals();
  let changed = false;
  for (const project of cache.projects || []) {
    for (const template of templates.filter((item) => item.product_id === project.product_id)) {
      const current = goals.find((item) => item.project_id === project.id && item.source_template_id === template.id);
      const structural = {
        name: template.name,
        metric: template.metric,
        comparison: template.comparison || "at_least",
        target_value: Number(template.target_value || 0),
        unit: template.unit || "",
        comments: template.comments || "",
        category: template.category || "",
        channel: template.channel || "",
        notes: template.notes || "",
        sort_order: Number(template.sort_order || 0)
      };
      const suggestedDue = project.start_date && template.target_days != null
        ? addDays(project.start_date, template.target_days)
        : null;
      if (current) {
        const updates = { ...structural };
        const defaultAssignees = normalizeIdList(template.default_assignee_ids, template.default_owner_id);
        if (!normalizeIdList(current.assignee_ids, current.owner_id).length && defaultAssignees.length) {
          updates.assignee_ids = defaultAssignees;
          updates.owner_id = defaultAssignees[0];
        }
        if (!current.assign_to_client && template.assign_to_client) updates.assign_to_client = true;
        if (!current.due_date && suggestedDue) updates.due_date = suggestedDue;
        if (Object.entries(updates).some(([key, value]) => current[key] !== value)) {
          Object.assign(current, updates, { updated_at: new Date().toISOString() });
          if (isLive()) await updateRow("deliveryGoals", current.id, updates);
          changed = true;
        }
        continue;
      }
      const now = new Date().toISOString();
      const body = {
        id: crypto.randomUUID(), project_id: project.id, source_template_id: template.id,
        ...structural, current_value: 0,
        owner_id: normalizeIdList(template.default_assignee_ids, template.default_owner_id)[0] || null,
        assignee_ids: normalizeIdList(template.default_assignee_ids, template.default_owner_id),
        assign_to_client: Boolean(template.assign_to_client),
        due_date: suggestedDue, status: "todo", created_at: now, updated_at: now
      };
      const saved = isLive() ? await createRow("deliveryGoals", body) : body;
      goals.push(saved);
      changed = true;
    }
  }
  if (changed) {
    if (isLive()) cache.deliveryGoals = goals;
    else saveDeliveryGoals(goals);
  }
}
async function syncDeliveryGoalDependencies() {
  if (!cache) return;
  const templates = loadProductGoals();
  const goals = loadDeliveryGoals();
  const tasks = operationalProjectTasks();
  let changed = false;
  for (const goal of goals) {
    const template = templates.find((item) => item.id === goal.source_template_id);
    if (!template) continue;
    const dependencyGoalIds = normalizeIdList(template.dependency_goal_template_ids)
      .map((templateId) => goals.find((item) => item.project_id === goal.project_id && item.source_template_id === templateId)?.id)
      .filter(Boolean);
    const dependencyActivityIds = normalizeIdList(template.dependency_activity_template_ids)
      .flatMap((templateId) => tasks
        .filter((item) => item.project_id === goal.project_id && item.source_template_id === templateId)
        .sort(activityOccurrenceSort)
        .map((item) => item.id));
    const sameGoals = JSON.stringify(normalizeIdList(goal.dependency_goal_ids)) === JSON.stringify(dependencyGoalIds);
    const sameActivities = JSON.stringify(normalizeIdList(goal.dependency_activity_ids)) === JSON.stringify(dependencyActivityIds);
    if (sameGoals && sameActivities) continue;
    const updates = { dependency_goal_ids: dependencyGoalIds, dependency_activity_ids: dependencyActivityIds };
    Object.assign(goal, updates, { updated_at: new Date().toISOString() });
    if (isLive()) await updateRow("deliveryGoals", goal.id, updates);
    changed = true;
  }
  if (changed) {
    if (isLive()) cache.deliveryGoals = goals;
    else saveDeliveryGoals(goals);
  }
}
async function syncProductActivities() {
  if (!cache) return;
  const templates = loadProductActivities();
  const tasks = loadProjectTasks();
  let changed = false;
  for (const project of cache.projects || []) {
    for (const template of templates.filter((item) => item.product_id === project.product_id && projectChannelEnabled(project, item.channel))) {
      const hasSubtasks = templates.some((item) => item.parent_template_id === template.id);
      const objective = template.objective_template_id
        ? loadDeliveryObjectives().find((item) => item.project_id === project.id && item.source_template_id === template.objective_template_id)
        : null;
      const dates = activityOccurrenceDates(project, template.recurrence || "once", template.consider_business_days);
      const existing = tasks
        .filter((task) => task.project_id === project.id && task.source_template_id === template.id)
        .sort(activityOccurrenceSort);
      for (let occurrenceIndex = 0; occurrenceIndex < dates.length; occurrenceIndex += 1) {
        const current = existing.find((task) => Number(task.occurrence_index || 0) === occurrenceIndex);
        const occurrenceDate = dates[occurrenceIndex];
        const plannedStartDate = occurrenceDate || project.start_date || null;
        const dueDate = plannedStartDate && template.target_days != null
          ? (template.consider_business_days ? addBusinessDays(plannedStartDate, Number(template.target_days)) : addDays(plannedStartDate, Number(template.target_days)))
          : occurrenceDate;
        const structural = {
          title: template.activity,
          information: template.information || "",
          priority: template.priority || "normal",
          sort_order: Number(template.sort_order || 0) * 1000 + occurrenceIndex,
          group: template.group || "",
          subgroup: template.subgroup || "",
          sector: template.sector || "",
          subsector: template.subsector || "",
          module: template.module || "",
          submodule: template.submodule || "",
          category: template.category || "",
          channel: template.channel || "",
          type: template.type || "",
          recurrence: template.recurrence || "once",
          consider_business_days: Boolean(template.consider_business_days),
          target_days: template.target_days == null ? null : Number(template.target_days),
          start_after_days: template.start_after_days == null || template.start_after_days === "" ? null : Number(template.start_after_days),
          occurrence_index: occurrenceIndex,
          objective_id: objective?.id || null,
          document_ids: normalizeIdList(template.document_ids),
          custom_table_ids: normalizeIdList(template.custom_table_ids)
        };
        if (current) {
          const recurrenceChanged = (current.recurrence || "once") !== structural.recurrence;
          const scheduleChanged = recurrenceChanged
            || Boolean(current.consider_business_days) !== structural.consider_business_days
            || (current.target_days == null ? null : Number(current.target_days)) !== structural.target_days;
          const updates = { ...structural, checklist: hasSubtasks ? [] : mergeTemplateChecklist(template.checklist, current.checklist) };
          const defaultAssignees = normalizeIdList(template.default_assignee_ids, template.default_owner_id);
          if (!normalizeIdList(current.assignee_ids, current.owner_id).length && defaultAssignees.length) {
            updates.assignee_ids = defaultAssignees;
            updates.owner_id = defaultAssignees[0];
          }
          const defaultJobTitles = normalizeTextList(template.default_assignee_job_titles);
          if (!normalizeTextList(current.assignee_job_titles).length && defaultJobTitles.length) {
            updates.assignee_job_titles = defaultJobTitles;
          }
          if (!current.assign_to_client && template.assign_to_client) updates.assign_to_client = true;
          if (plannedStartDate && (!current.planned_start_date || scheduleChanged)) updates.planned_start_date = plannedStartDate;
          if (scheduleChanged || (dueDate && !current.due_date)) {
            updates.due_date = dueDate;
            updates.planned_end_date = dueDate;
          }
          if (Object.entries(updates).some(([key, value]) => key === "checklist"
            ? JSON.stringify(normalizeChecklist(current[key])) !== JSON.stringify(value)
            : ["document_ids", "custom_table_ids"].includes(key)
              ? JSON.stringify(normalizeIdList(current[key])) !== JSON.stringify(normalizeIdList(value))
            : current[key] !== value)) {
            Object.assign(current, updates, { updated_at: new Date().toISOString() });
            if (isLive()) await updateRow("activities", current.id, updates);
            changed = true;
          }
          continue;
        }
        const now = new Date().toISOString();
        const body = {
          id: crypto.randomUUID(), project_id: project.id, source_template_id: template.id,
          ...structural, checklist: hasSubtasks ? [] : mergeTemplateChecklist(template.checklist, []),
          owner_id: normalizeIdList(template.default_assignee_ids, template.default_owner_id)[0] || null,
          assignee_ids: normalizeIdList(template.default_assignee_ids, template.default_owner_id),
          assignee_job_titles: normalizeTextList(template.default_assignee_job_titles),
          assign_to_client: Boolean(template.assign_to_client),
          due_date: dueDate, planned_start_date: plannedStartDate, planned_end_date: dueDate,
          actual_start_date: null, actual_end_date: null, notes: "", status: "todo",
          created_at: now, updated_at: now
        };
        const saved = isLive() ? await createActivityOrLoadExisting(body) : body;
        tasks.push(saved);
        existing.push(saved);
        changed = true;
      }
    }
  }
  for (const project of cache.projects || []) {
    const projectTemplates = templates.filter((item) => item.product_id === project.product_id && projectChannelEnabled(project, item.channel));
    const projectTemplateIds = new Set(projectTemplates.map((item) => item.id));
    for (const template of projectTemplates) {
      const occurrences = tasks.filter((task) => task.project_id === project.id && task.source_template_id === template.id && projectChannelEnabled(project, task.channel)).sort(activityOccurrenceSort);
      const dependencyTemplateIds = normalizeIdList(template.dependency_template_ids, template.depends_on_template_id)
        .filter((templateId) => projectTemplateIds.has(templateId));
      const parentOccurrences = template.parent_template_id && projectTemplateIds.has(template.parent_template_id)
        ? tasks.filter((task) => task.project_id === project.id && task.source_template_id === template.parent_template_id).sort(activityOccurrenceSort)
        : [];
      for (let index = 0; index < occurrences.length; index += 1) {
        const current = occurrences[index];
        const occurrenceIndex = Number(current.occurrence_index || 0);
        const parentId = parentOccurrences.find((task) => Number(task.occurrence_index || 0) === occurrenceIndex)?.id
          || parentOccurrences[Math.min(index, parentOccurrences.length - 1)]?.id
          || null;
        const dependencyIds = dependencyTemplateIds.map((templateId) => {
          const dependencyOccurrences = tasks.filter((task) => task.project_id === project.id && task.source_template_id === templateId).sort(activityOccurrenceSort);
          return dependencyOccurrences.find((task) => Number(task.occurrence_index || 0) === occurrenceIndex)?.id
            || dependencyOccurrences[Math.min(index, dependencyOccurrences.length - 1)]?.id;
        }).filter(Boolean);
        const dependencyId = dependencyIds[0] || null;
        if ((current.parent_activity_id || null) === parentId
          && (current.depends_on_activity_id || null) === dependencyId
          && JSON.stringify(normalizeIdList(current.dependency_ids, current.depends_on_activity_id)) === JSON.stringify(dependencyIds)) continue;
        current.parent_activity_id = parentId;
        current.depends_on_activity_id = dependencyId;
        current.dependency_ids = dependencyIds;
        current.updated_at = new Date().toISOString();
        if (isLive()) await updateRow("activities", current.id, { parent_activity_id: parentId, depends_on_activity_id: dependencyId, dependency_ids: dependencyIds });
        changed = true;
      }
    }
  }
  if (changed) {
    if (isLive()) cache.activityRecords = tasks;
    else saveProjectTasks(tasks);
  }
  await recalculateDependencySchedules();
  await syncDeliveryObjectiveDependencies();
  await syncDeliveryGoalDependencies();
}
// Reprograma o início previsto pelas dependências: término real (se concluída) ou previsto + "iniciar após".
async function recalculateDependencySchedules(projectId = null) {
  const tasks = loadProjectTasks();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const shift = (date, days, business) => business ? addBusinessDays(date, days) : addDays(date, days);
  const candidates = tasks.filter((task) => (!projectId || task.project_id === projectId)
    && task.start_after_days != null && task.start_after_days !== ""
    && !task.schedule_manual && !["done", "canceled"].includes(task.status)
    && normalizeIdList(task.dependency_ids, task.depends_on_activity_id).length);
  const changedIds = new Set();
  for (let pass = 0; pass <= candidates.length; pass += 1) {
    let changedThisPass = false;
    for (const task of candidates) {
      const dependencies = normalizeIdList(task.dependency_ids, task.depends_on_activity_id).map((id) => byId.get(id)).filter(Boolean);
      if (!dependencies.length) continue;
      const ends = dependencies.map((dependency) => dependency.status === "done" && dependency.actual_end_date ? dependency.actual_end_date : taskPlannedEnd(dependency));
      if (ends.some((end) => !end)) continue;
      const base = ends.map((end) => String(end).slice(0, 10)).sort().at(-1);
      const business = Boolean(task.consider_business_days);
      const start = shift(base, Number(task.start_after_days || 0), business);
      let end;
      if (task.target_days != null && task.target_days !== "") end = shift(start, Number(task.target_days), business);
      else {
        const previousStart = task.planned_start_date ? String(task.planned_start_date).slice(0, 10) : null;
        const previousEnd = taskPlannedEnd(task) ? String(taskPlannedEnd(task)).slice(0, 10) : null;
        const duration = previousStart && previousEnd && previousEnd >= previousStart
          ? Math.round((new Date(`${previousEnd}T12:00:00`) - new Date(`${previousStart}T12:00:00`)) / 86400000) : 0;
        end = addDays(start, duration);
      }
      if (task.planned_start_date === start && task.planned_end_date === end && task.due_date === end) continue;
      Object.assign(task, { planned_start_date: start, planned_end_date: end, due_date: end });
      changedIds.add(task.id);
      changedThisPass = true;
    }
    if (!changedThisPass) break;
  }
  if (!changedIds.size) return false;
  const now = new Date().toISOString();
  for (const id of changedIds) {
    const task = byId.get(id);
    task.updated_at = now;
    if (isLive()) await updateRow("activities", id, { planned_start_date: task.planned_start_date, planned_end_date: task.planned_end_date, due_date: task.due_date, updated_at: now });
  }
  if (isLive()) cache.activityRecords = tasks;
  else saveProjectTasks(tasks);
  refreshActivityCache();
  return true;
}
migrateLocalOperationalData = withActivityLogSuppressed(migrateLocalOperationalData);
syncProductObjectives = withActivityLogSuppressed(syncProductObjectives);
syncProductGoals = withActivityLogSuppressed(syncProductGoals);
syncProductActivities = withActivityLogSuppressed(syncProductActivities);
syncDeliveryObjectiveDependencies = withActivityLogSuppressed(syncDeliveryObjectiveDependencies);
syncDeliveryGoalDependencies = withActivityLogSuppressed(syncDeliveryGoalDependencies);
recalculateDependencySchedules = withActivityLogSuppressed(recalculateDependencySchedules);
function activityOccurrenceSort(a, b) {
  return String(a.due_date || "9999-12-31").localeCompare(String(b.due_date || "9999-12-31"))
    || Number(a.sort_order || 0) - Number(b.sort_order || 0)
    || String(a.created_at || "").localeCompare(String(b.created_at || ""));
}
function addMonthsClamped(isoDate, months) {
  const source = new Date(`${isoDate}T00:00:00`);
  const day = source.getDate();
  const target = new Date(source.getFullYear(), source.getMonth() + Number(months), 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
function activityOccurrenceDates(project, recurrence, considerBusinessDays = false) {
  if (!recurrence || recurrence === "once") return [null];
  const start = project.start_date;
  const end = project.end_date;
  if (!start) return [null];
  if (!end || end <= start) return [start];
  const dates = [];
  let cursor = start;
  const monthStep = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 }[recurrence];
  const dayStep = recurrence === "daily" ? 1 : recurrence === "weekly" ? 7 : recurrence === "biweekly" ? 14 : null;
  for (let guard = 0; guard < 3660 && cursor < end; guard += 1) {
    const weekday = new Date(`${cursor}T12:00:00`).getDay();
    if (!(recurrence === "daily" && considerBusinessDays && [0, 6].includes(weekday))) dates.push(cursor);
    cursor = monthStep ? addMonthsClamped(cursor, monthStep) : addDays(cursor, dayStep || 1);
  }
  return dates.length ? dates : [start];
}
function projectTasks(projectId) {
  const tasks = operationalProjectTasks(projectId);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map();
  const compare = (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
    || String(a.created_at || "").localeCompare(String(b.created_at || ""));
  tasks.forEach((task) => {
    if (!task.parent_activity_id || !byId.has(task.parent_activity_id)) return;
    if (!children.has(task.parent_activity_id)) children.set(task.parent_activity_id, []);
    children.get(task.parent_activity_id).push(task);
  });
  const ordered = [];
  const visited = new Set();
  const append = (task) => {
    if (!task || visited.has(task.id)) return;
    visited.add(task.id);
    ordered.push(task);
    (children.get(task.id) || []).sort(compare).forEach(append);
  };
  tasks.filter((task) => !task.parent_activity_id || !byId.has(task.parent_activity_id)).sort(compare).forEach(append);
  tasks.sort(compare).forEach(append);
  return ordered;
}

function taskSubtasks(taskId, tasks = loadProjectTasks()) {
  return tasks.filter((task) => task.parent_activity_id === taskId);
}

function taskParent(task, tasks = loadProjectTasks()) {
  return task?.parent_activity_id ? tasks.find((item) => item.id === task.parent_activity_id) || null : null;
}

function taskSubtaskProgress(taskId, tasks = loadProjectTasks()) {
  const subtasks = taskSubtasks(taskId, tasks);
  return { total: subtasks.length, done: subtasks.filter((task) => task.status === "done").length };
}

function taskDescendantIds(taskId, tasks = loadProjectTasks(), ids = new Set()) {
  taskSubtasks(taskId, tasks).forEach((task) => {
    if (ids.has(task.id)) return;
    ids.add(task.id);
    taskDescendantIds(task.id, tasks, ids);
  });
  return ids;
}
function findConversation(id) {
  return loadConversations().find((row) => row.id === id);
}
function selectedConversationRows() {
  return [...state.selectedConversations].map(findConversation).filter(Boolean);
}
function contactForConversation(row) {
  if (!row) return "";
  return row.contact || "";
}
function redditUserFromSender(sender) {
  const m = String(sender || "").match(/^@([^:]+):/);
  return m ? m[1] : sender || "";
}
function redditProfileUrl(username) {
  return username ? `https://www.reddit.com/user/${username}/` : "";
}
// Participante "principal" da sala = quem não é você. Se você não configurou
// myRedditUsername em config.js, cai no primeiro username visto (funciona
// bem pra DM 1:1; em sala com mais gente, ajuste o config).
function primaryRedditParticipant(row) {
  const me = String(getCfg().myRedditUsername || "").toLowerCase();
  const counts = row.participants || {};
  const candidates = Object.keys(counts).filter((u) => u.toLowerCase() !== me);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => counts[b] - counts[a])[0];
}

function syncRedditQueue() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get({
    erc_reddit_events_queue: [],
    erc_reddit_rooms: {},
    erc_reddit_profiles: {},
    erc_reddit_room_urls: {}
  }, (data) => {
    const events = data.erc_reddit_events_queue || [];
    const roomNames = data.erc_reddit_rooms || {};
    const profiles = data.erc_reddit_profiles || {};
    const roomUrls = data.erc_reddit_room_urls || {};
    const conversations = loadConversations();
    let changed = false;

    if (events.length) {
      const byRoom = {};
      events.forEach((ev) => {
        if (!ev.room_id) return;
        (byRoom[ev.room_id] = byRoom[ev.room_id] || []).push(ev);
      });

      Object.entries(byRoom).forEach(([roomId, evs]) => {
        evs.sort((a, b) => (a.origin_server_ts || 0) - (b.origin_server_ts || 0));
        let row = conversations.find((r) => r.source === "Reddit" && r.external_room_id === roomId);
        const existingIds = new Set(row?.event_ids || []);
        const newEvs = evs.filter((ev) => ev.event_id && !existingIds.has(ev.event_id));
        if (!newEvs.length) return;

        const mapped = newEvs.map((ev) => ({
          at: ev.origin_server_ts ? new Date(ev.origin_server_ts).toLocaleString("pt-BR") : "",
          author: redditUserFromSender(ev.sender),
          text: ev.content?.body || ""
        }));

        if (!row) {
          row = {
            id: crypto.randomUUID(), source: "Reddit", origin: "Scrap", external_room_id: roomId,
            contact_name: "", contact: "", username: "", profile_url: "", chat_url: roomUrls[roomId] || "",
            participants: {}, message_count: 0, first_at: "", last_at: "",
            title: roomNames[roomId] ? `Reddit - ${roomNames[roomId]}` : "Reddit",
            summary: "", messages: [], event_ids: [],
            imported_at: new Date().toLocaleString("pt-BR"), status: "imported"
          };
          conversations.unshift(row);
        }

        row.messages = (row.messages || []).concat(mapped);
        row.event_ids = (row.event_ids || []).concat(newEvs.map((ev) => ev.event_id));
        row.message_count = row.messages.length;
        row.first_at = row.first_at || mapped[0].at;
        row.last_at = mapped[mapped.length - 1].at || row.last_at;
        row.summary = row.messages.filter((m) => m.author).slice(-8)
          .map((m) => `${m.author}: ${m.text}`).join(" / ").slice(0, 360);
        row.participants = row.participants || {};
        mapped.forEach((m) => { if (m.author) row.participants[m.author] = (row.participants[m.author] || 0) + 1; });
        changed = true;
      });
    }

    // Resolve username / URL perfil / contato (nome) pra toda sala do Reddit,
    // usando o que já foi capturado até agora (não depende de novas mensagens).
    conversations.forEach((row) => {
      if (row.source !== "Reddit") return;
      if (!row.chat_url && roomUrls[row.external_room_id]) { row.chat_url = roomUrls[row.external_room_id]; changed = true; }
      const primary = primaryRedditParticipant(row);
      if (primary && row.username !== primary) {
        row.username = primary;
        row.profile_url = redditProfileUrl(primary);
        changed = true;
      }
      const profile = row.username ? profiles[row.username] : null;
      if (profile && profile.displayName && row.contact !== profile.displayName) {
        row.contact = profile.displayName;
        if (profile.url) row.profile_url = profile.url;
        changed = true;
      }
    });

    if (changed) {
      saveConversations(conversations);
      if (state.tab === "conversations") render();
      if (events.length) toast("Conversas do Reddit atualizadas.");
    }
    if (events.length) chrome.storage.local.set({ erc_reddit_events_queue: [] });
  });
}

function syncWhatsAppQueue() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get({
    erc_whatsapp_events_queue: [],
    erc_whatsapp_rooms: {},
    erc_whatsapp_contacts: {}
  }, (data) => {
    const events = data.erc_whatsapp_events_queue || [];
    const roomNames = data.erc_whatsapp_rooms || {};
    const contacts = data.erc_whatsapp_contacts || {};
    const conversations = loadConversations();
    let changed = false;

    if (events.length) {
      const byRoom = {};
      events.forEach((ev) => {
        if (!ev.room_id) return;
        (byRoom[ev.room_id] = byRoom[ev.room_id] || []).push(ev);
      });

      Object.entries(byRoom).forEach(([roomId, evs]) => {
        evs.sort((a, b) => (a.at_ts || 0) - (b.at_ts || 0));
        let row = conversations.find((r) => r.source === "WhatsApp" && r.external_room_id === roomId);
        const existingIds = new Set(row?.event_ids || []);
        const newEvs = evs.filter((ev) => ev.msg_id && !existingIds.has(ev.msg_id));
        if (!newEvs.length) return;

        // Guardamos o timestamp de cada mensagem porque a rolagem pra cima
        // (carregar histórico) chega DEPOIS das mensagens recentes — sem o
        // ts não dá pra saber qual é realmente a primeira da conversa nem
        // reordenar o chat corretamente.
        const mapped = newEvs.map((ev) => ({ at: ev.at_label || "", at_ts: ev.at_ts || null, author: ev.author || "", text: ev.text || "" }));
        const title = roomNames[roomId] || row?.contact_name || "WhatsApp";

        if (!row) {
          row = {
            id: crypto.randomUUID(), source: "WhatsApp", origin: "Scrap", external_room_id: roomId,
            contact_name: title, contact: contacts[roomId] || "", username: "", profile_url: "", chat_url: "",
            participants: {}, message_count: 0, first_at: "", last_at: "",
            title: `WhatsApp - ${title}`,
            summary: "", messages: [], event_ids: [],
            imported_at: new Date().toLocaleString("pt-BR"), status: "imported"
          };
          conversations.unshift(row);
        } else if (title) {
          row.contact_name = title;
          row.title = `WhatsApp - ${title}`;
        }

        row.messages = (row.messages || []).concat(mapped).sort((a, b) => (a.at_ts || 0) - (b.at_ts || 0));
        row.event_ids = (row.event_ids || []).concat(newEvs.map((ev) => ev.msg_id));
        row.message_count = row.messages.length;
        const timed = row.messages.filter((m) => m.at_ts);
        if (timed.length) {
          row.first_at = timed[0].at;
          row.last_at = timed[timed.length - 1].at;
        } else {
          row.first_at = row.first_at || mapped[0].at;
          row.last_at = mapped[mapped.length - 1].at || row.last_at;
        }
        row.summary = row.messages.filter((m) => m.author).slice(-8)
          .map((m) => `${m.author}: ${m.text}`).join(" / ").slice(0, 360);
        row.participants = row.participants || {};
        mapped.forEach((m) => { if (m.author) row.participants[m.author] = (row.participants[m.author] || 0) + 1; });
        changed = true;
      });
    }

    // Telefone capturado no perfil do contato — independente de mensagem
    // nova, pra funcionar mesmo só abrindo o perfil na conversa já existente.
    conversations.forEach((row) => {
      if (row.source !== "WhatsApp") return;
      const phone = contacts[row.external_room_id];
      if (phone && row.contact !== phone) { row.contact = phone; changed = true; }
    });

    if (changed) {
      saveConversations(conversations);
      if (state.tab === "conversations") render();
      toast("Conversas do WhatsApp atualizadas.");
    }
    if (events.length) chrome.storage.local.set({ erc_whatsapp_events_queue: [] });
  });
}

async function loadAll() {
  // Cada tabela é buscada de forma independente: se uma ainda não existir ou
  // tiver nome diferente no banco, o módulo dela fica vazio em vez de
  // derrubar o carregamento inteiro (ex.: "companies" continua funcionando
  // mesmo que "deals"/"users" ainda não tenham sido migradas).
  const [users, companies, contacts, products, deals, projects, pipelines, activityRecords, productActivities, productObjectives, productGoals, deliveryObjectives, deliveryGoals, contactCompanies, activityComments] = await Promise.all([
    fetchTable("users").catch(() => []),
    fetchTable("companies"),
    fetchTable("contacts").catch(() => []),
    fetchTable("products").catch(() => []),
    fetchTable("deals").catch(() => []),
    fetchTable("projects").catch(() => []),
    fetchTable("pipelines").catch(() => []),
    fetchTable("activities").catch(() => []),
    fetchTable("productActivities").catch(() => []),
    fetchTable("productObjectives").catch(() => []),
    fetchTable("productGoals").catch(() => []),
    fetchTable("deliveryObjectives").catch(() => []),
    fetchTable("deliveryGoals").catch(() => []),
    fetchTable("contactCompanies").catch(() => null),
    fetchTable("activityComments").catch(() => [])
  ]);
  const byId = (arr, key = "id") => Object.fromEntries(arr.map((r) => [r[key], r]));
  const companyIdsByContact = new Map();
  const contactIdsByCompany = new Map();
  (contactCompanies || []).forEach((link) => {
    if (!companyIdsByContact.has(link.contact_id)) companyIdsByContact.set(link.contact_id, []);
    if (!contactIdsByCompany.has(link.company_id)) contactIdsByCompany.set(link.company_id, []);
    companyIdsByContact.get(link.contact_id).push(link.company_id);
    contactIdsByCompany.get(link.company_id).push(link.contact_id);
  });
  contacts.forEach((contact) => {
    const linked = companyIdsByContact.get(contact.id) || [];
    contact.company_ids = [...new Set((contactCompanies ? linked : [...linked, contact.company_id]).filter(Boolean))];
  });
  companies.forEach((company) => {
    company.contact_ids = [...new Set(contactIdsByCompany.get(company.tax_id) || [])];
    company.state_registration_text = normalizeStateRegistrations(company.state_registrations).filter((item) => item.ie).map((item) => `${item.uf}: ${item.ie}`).join(" · ");
  });
  const conversations = loadConversations();
  const projectById = byId(projects);
  cache = { users, companies, contacts, products, deals, projects, pipelines, conversations,
    activities: [], activityRecords, productActivities, productObjectives, productGoals, deliveryObjectives, deliveryGoals, contactCompanies: contactCompanies || [], activityComments,
    companyById: byId(companies, pk("companies")), contactById: byId(contacts), productById: byId(products),
    userById: byId(users),
    userByAuthId: Object.fromEntries(users.filter((user) => user.auth_user_id).map((user) => [user.auth_user_id, user])),
    pipelineById: byId(pipelines), projectById };
  if (!isLive()) {
    await migrateLocalOperationalData();
    await syncProductObjectives();
    await syncProductGoals();
    await syncProductActivities();
  }
  refreshActivityCache();
  return cache;
}

// ---------- Utils ----------
const brl = (n) => (n == null || n === "" ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n));
const dt = (value) => {
  if (!value) return "—";
  const raw = String(value);
  const date = /^\d{4}-\d{2}-\d{2}/.test(raw)
    ? new Date(`${raw.slice(0, 10)}T12:00:00`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("pt-BR");
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (e) {
    return "";
  }
}
const badge = (v, label) => `<span class="badge b-${v}">${esc(label || v)}</span>`;
const TABLE_ACTION_ICONS = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>',
  clone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>'
};
function tableActionButtons(actions = {}) {
  const labels = { open: "Abrir", edit: "Editar", clone: "Clonar", delete: "Excluir" };
  const attrsHtml = (attrs = {}) => Object.entries(attrs).map(([key, value]) => ` ${esc(key)}="${esc(value)}"`).join("");
  return `<span class="table-actions">${["open", "edit", "clone", "delete"].map((kind) => {
    const action = actions[kind];
    const enabled = Boolean(action && action.enabled !== false);
    const title = action?.title || labels[kind];
    const classes = ["rowbtn", "table-action-btn", `action-${kind}`, enabled ? action?.className : "is-disabled"].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" title="${esc(enabled ? title : `${labels[kind]} indisponível`)}" aria-label="${esc(enabled ? title : `${labels[kind]} indisponível`)}"${enabled ? attrsHtml(action.attrs) : ' disabled aria-disabled="true"'}>${TABLE_ACTION_ICONS[kind]}</button>`;
  }).join("")}</span>`;
}
const tableActionsHead = () => '<th class="noclick table-actions-head">AÇÕES</th>';
function splitMultiValues(value) {
  return String(value || "").split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean);
}
function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const number = digits.slice(4);
    const prefixLength = number.length - 4;
    return `+55 (${ddd}) ${number.slice(0, prefixLength)}-${number.slice(prefixLength)}`;
  }
  if (digits.length > 11) return `+${digits}`;
  return raw;
}
function normalizePhoneList(value) {
  const seen = new Set();
  const normalized = splitMultiValues(value).map(normalizePhoneNumber).filter((item) => {
    const key = item.replace(/\D/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const phoneDigits = (item) => {
    let digits = item.replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits;
  };
  return normalized.filter((item) => {
    const short = phoneDigits(item);
    if (short.length !== 12) return true;
    return !normalized.some((candidate) => {
      const long = phoneDigits(candidate);
      return long.length === 13
        && long.slice(0, 4) === short.slice(0, 4)
        && long[4] === "9"
        && long.slice(5) === short.slice(4);
    });
  }).join("; ");
}
function normalizeEmailList(value) {
  const seen = new Set();
  return splitMultiValues(value).filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("; ");
}
function multiLineCell(value, formatter = (item) => item) {
  const values = splitMultiValues(value).map(formatter).filter(Boolean);
  return values.length ? `<div class="multi-value">${values.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : "—";
}
function stackedCell(values) {
  const items = [...new Set((Array.isArray(values) ? values : [values]).map((item) => String(item || "").trim()).filter((item) => item && item !== "—"))];
  return items.length ? `<div class="stacked-cell">${items.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : "—";
}
const activityDisplayName = (item) => {
  if (!item) return "—";
  const parts = [item.category, item.channel, item.module, item.submodule, item.activity || item.title, item.type]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" | ") : "—";
};
const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
};
const addDaysRoundedToMonthEnd = (isoDate, days) => {
  const calculated = new Date(`${addDays(isoDate, days)}T12:00:00`);
  const monthEnd = new Date(calculated.getFullYear(), calculated.getMonth() + 1, 0, 12);
  return `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, "0")}-${String(monthEnd.getDate()).padStart(2, "0")}`;
};
const addBusinessDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T12:00:00`);
  let remaining = Math.max(0, Number(days || 0));
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    if (![0, 6].includes(date.getDay())) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
};
function deliveryTypeForProduct(product) {
  const text = `${product?.category || ""} ${product?.name || ""}`.toLowerCase();
  if (text.includes("imers")) return "Imersão";
  if (text.includes("trein") || text.includes("curso") || text.includes("formaç")) return "Treinamento";
  if (text.includes("consult")) return "Consultoria";
  if (text.includes("evento")) return "Evento";
  return "Projeto";
}
function deliveryGeneratedName(clientName, productId) {
  const product = cache?.productById?.[productId];
  return `EC365 | ${String(clientName || "Sem cliente").trim() || "Sem cliente"} | ${product?.name || "Sem produto"}`;
}
const taskPlannedStart = (task) => task?.planned_start_date || null;
const taskPlannedEnd = (task) => task?.planned_end_date || task?.due_date || null;
const taskStatusLabel = (status) => TASK_STATUS.find((item) => item.id === status)?.label || "Em aberto";
const taskStatusTone = (status) => status === "done" ? "won" : status === "canceled" ? "lost" : status === "doing" ? "negotiation" : "lead";
function inlineTaskStatus(task, className = "inline-task-status") {
  const disabled = !currentUserCan("activities", "operate") || taskStatusLocked(task);
  return `<select class="${className}" data-id="${esc(task.id)}" title="${taskStatusLocked(task) ? "Somente administradores alteram esta tarefa" : "Alterar status"}"${disabled ? " disabled" : ""}>${taskStatusOptions(task.status || "todo", taskIsBlocked(task), true)}</select>`;
}
function taskDeadlineState(task) {
  const planned = String(taskPlannedEnd(task) || "").slice(0, 10);
  if (!planned || (task.status === "canceled" && !task.actual_end_date)) return "";
  const actual = String(task.actual_end_date || "").slice(0, 10);
  if (actual) return actual < planned ? "Adiantado" : actual > planned ? "Atrasado" : "Em dia";
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return today > planned ? "Atrasado" : "Em dia";
}
function taskDeadlineBadge(task) {
  const value = task.deadline_state || taskDeadlineState(task);
  if (!value) return "—";
  const tone = value === "Atrasado" ? "lost" : value === "Adiantado" ? "qualification" : "won";
  return badge(tone, value);
}
function taskComments(taskId) {
  return (cache?.activityComments || []).filter((comment) => comment.activity_id === taskId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
function taskCommentCount(task) {
  return taskComments(task.id).length + (String(task.notes || "").trim() ? 1 : 0);
}
function taskCommentsButton(task) {
  const count = taskCommentCount(task);
  return `<button class="task-comments-open" type="button" data-id="${esc(task.id)}" title="Abrir comentários">${count ? `${count} comentário${count === 1 ? "" : "s"}` : "+ Comentar"}</button>`;
}

async function ensureTaskReferenceSources() {
  if (!isLive()) return;
  await Promise.all([loadRemoteToolDocuments(), loadRemoteToolTables()]);
}

function taskDocumentOptions() {
  return toolDocumentRows().map((item) => ({ value: item.id, label: toolDocumentValue(item, "title") || item.title || "Documento sem nome" }));
}

function taskTableOptions() {
  return toolCustomTableRows().map((item) => ({ value: item.id, label: item.name || "Tabela sem nome" }));
}

function taskReferencesHtml(task) {
  const documents = normalizeIdList(task?.document_ids).map((id) => ({ id, name: taskDocumentOptions().find((item) => item.value === id)?.label || "Documento", kind: "document" }));
  const tables = normalizeIdList(task?.custom_table_ids).map((id) => ({ id, name: taskTableOptions().find((item) => item.value === id)?.label || "Tabela", kind: "table" }));
  const references = [...documents, ...tables];
  return references.length ? `<span class="task-references">${references.map((item) => `<button class="task-reference-open" type="button" data-reference-kind="${item.kind}" data-reference-id="${esc(item.id)}" title="Abrir ${esc(item.name)}">${esc(item.name)}</button>`).join("")}</span>` : "—";
}

async function openTaskReference(kind, id) {
  await ensureTaskReferenceSources();
  if (kind === "document") openToolDocument(id);
  else openToolCustomTableEditor(id, true);
}

// Quando um negócio entra em "Ganho", um projeto nasce sozinho — carrega
// cliente/produto do negócio e calcula o fim pela duração cadastrada no
// produto. Idempotente: se já existe projeto pra esse negócio, não duplica.
async function createProjectFromDeal(deal) {
  if (!cache || !deal?.id) return;
  const already = (cache.projects || []).some((p) => p.negotiation_id === deal.id);
  if (already) return;
  const product = deal.product_id ? cache.productById[deal.product_id] : null;
  const company = deal.company_id ? cache.companyById[deal.company_id] : null;
  const contact = deal.contact_id ? cache.contactById?.[deal.contact_id] : null;
  const start = new Date().toISOString().slice(0, 10);
  const end = product?.duration_days ? addDaysRoundedToMonthEnd(start, product.duration_days) : null;
  const clientName = contact?.name || company?.trade_name || company?.legal_name || "Sem cliente";
  const name = deliveryGeneratedName(clientName, deal.product_id);
  try {
    const savedProject = await createRow("projects", {
      name: name || deal.title || "Entrega",
      delivery_type: deliveryTypeForProduct(product),
      group_name: null,
      client_name: clientName,
      company_id: deal.company_id || null,
      product_id: deal.product_id || null,
      negotiation_id: deal.id,
      status: "active",
      substatus: null,
      source: "negotiation",
      start_date: start,
      end_date: end
    });
    toast("Entrega criada automaticamente a partir do negócio ganho.");
    await provisionDeliveryResources(savedProject);
    if (deal.company_id) await ensureCompanyClientType(deal.company_id);
  } catch (err) {
    toast("Erro ao criar entrega automática · " + err.message, true);
  }
}

function toast(msg, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.getElementById("toast").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- Colunas e campos ----------
function columns(tab, c) {
  switch (tab) {
    case "companies": return [
      { k: "tax_id", h: "CNPJ", cls: "muted company-sticky-col company-sticky-col-1", thCls: "company-sticky-col company-sticky-col-1" },
      { k: "legal_name", h: "NOME EMPRESARIAL", cls: "company-sticky-col company-sticky-col-2", thCls: "company-sticky-col company-sticky-col-2", fmt: (v, row) => `${companyRegistryBadgeHtml(row)}${esc(v || (row.registry_pending ? "Aguardando Receita" : "—"))}` },
      { k: "trade_name", h: "NOME FANTASIA" },
      { k: "contact_type", h: "TIPO DE CONTATO", fmt: (v) => `<span class="tool-tags">${normalizeTextList(v).map((type) => `<span class="tool-tag">${esc(type)}</span>`).join("") || '<span class="muted">—</span>'}</span>` },
      { k: "email", h: "E-MAIL", cls: "muted" },
      { k: "phone", h: "TELEFONE", cls: "muted" },
      { k: "headquarters", h: "SEDE" },
      { k: "founded_at", h: "DATA DE ABERTURA", fmt: dt },
      { k: "registration_status", h: "SITUAÇÃO CADASTRAL" },
      { k: "state_registration_text", h: "INSCRIÇÃO ESTADUAL", cls: "muted" },
      { k: "municipal_registration", h: "INSCRIÇÃO MUNICIPAL", cls: "muted" },
      { k: "qsa", h: "QSA", fmt: (v) => multiLineCell(v) },
      { k: "share_capital", h: "CAPITAL SOCIAL", num: true, fmt: brl, cls: "pos" },
      { k: "activities", h: "ATIVIDADES" },
      { k: "address", h: "ENDEREÇO" },
      { k: "zip_code", h: "CEP", cls: "muted" },
      { k: "city", h: "CIDADE" },
      { k: "state", h: "UF", cls: "muted" },
      { k: "contact_ids", h: "PESSOAS", fmt: (v) => contactNames(v, c) },
      { k: "notes", h: "OBSERVAÇÕES", cls: "muted" }];
    case "contacts": return [
      { k: "name", h: "NOME COMPLETO", cls: "person-sticky-col person-sticky-col-1", thCls: "person-sticky-col person-sticky-col-1" },
      { k: "phone", h: "TELEFONE/CELULAR", cls: "muted person-sticky-col person-sticky-col-2", thCls: "person-sticky-col person-sticky-col-2", fmt: (v) => multiLineCell(v, normalizePhoneNumber) },
      { k: "email", h: "EMAIL(S)", cls: "muted", fmt: (v) => multiLineCell(v) },
      { k: "contact_type", h: "TIPO DE CONTATO", fmt: (v) => `<span class="tool-tags">${normalizeTextList(v).map((type) => `<span class="tool-tag">${esc(type)}</span>`).join("") || '<span class="muted">—</span>'}</span>` },
      { k: "channel", h: "CANAL" },
      { k: "job_title", h: "CARGO" },
      { k: "department", h: "DEPARTAMENTO" },
      { k: "company_ids", h: "EMPRESA(S)", fmt: (v, row) => companyNames(v?.length ? v : [row.company_id], c) },
      { k: "linkedin", h: "LINKEDIN", cls: "muted" },
      { k: "facebook", h: "FACEBOOK", cls: "muted" },
      { k: "instagram", h: "INSTAGRAM", cls: "muted" },
      { k: "reddit", h: "REDDIT", cls: "muted" },
      { k: "whatsapp", h: "WHATSAPP", cls: "muted" },
      { k: "youtube", h: "YOUTUBE", cls: "muted" },
      { k: "groups", h: "GRUPOS/COMUNIDADES", fmt: (v) => `<span class="tool-tags">${normalizeTextList(v).map((group) => `<span class="tool-tag">${esc(group)}</span>`).join("") || '<span class="muted">—</span>'}</span>` },
      { k: "tags", h: "TAGS", fmt: (v) => `<span class="tool-tags">${normalizeTextList(v).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("") || '<span class="muted">—</span>'}</span>` },
      { k: "notes", h: "OBSERVAÇÕES", cls: "muted", fmt: (v) => multiLineCell(v) },
      { k: "birth_date", h: "DATA DE NASCIMENTO", fmt: dt },
      { k: "cpf", h: "CPF", cls: "muted" }];
    case "products": return [
      { k: "category", h: "CATEGORIA" },
      { k: "name", h: "PRODUTO" },
      { k: "description", h: "DESCRIÇÃO", cls: "muted" },
      { k: "price", h: "PREÇO A VISTA", num: true, fmt: brl, cls: "pos" },
      { k: "price_installment", h: "PREÇO PARCELADO", num: true, fmt: brl, cls: "pos" },
      { k: "sales_page", h: "PÁGINA DE VENDAS", fmt: (v) => safeHttpUrl(v) ? `<a href="${esc(safeHttpUrl(v))}" target="_blank" rel="noopener">Abrir</a>` : "—", csv: (v) => v || "" },
      { k: "duration_days", h: "DURAÇÃO (DIAS)", num: true, cls: "muted" },
      { k: "status", h: "STATUS", fmt: (v) => badge(v === "Ativo" ? "open" : v === "Pausado" ? "lead" : "lost", v) }];
    case "deals": return [
      { k: "title", h: "Negócio" },
      { k: "company_id", h: "Empresa", fmt: (v, row) => row.no_company ? '<span class="muted">Não possui empresa</span>' : c.companyById[v]?.legal_name || c.companyById[v]?.name || "—" },
      { k: "pipeline_id", h: "Pipeline", fmt: (v) => c.pipelineById?.[v]?.name || "—", cls: "muted" },
      { k: "stage", h: "Etapa", fmt: (v) => v ? badge("lead", v) : "—" },
      { k: "status", h: "Status", fmt: (v) => badge(v, STATUS_LABEL[v]) },
      { k: "lead_source", h: "Origem", cls: "muted" },
      { k: "amount", h: "Valor", num: true, fmt: brl, cls: "pos" },
      { k: "expected_close_date", h: "Previsão", fmt: dt }];
    case "projects": return [
      { k: "delivery_type", h: "TIPO" },
      { k: "group_name", h: "GRUPO" },
      { k: "name", h: "ENTREGA" },
      { k: "company_id", h: "EMPRESA", fmt: (v) => c.companyById[v]?.legal_name || "—" },
      { k: "client_name", h: "CLIENTE" },
      { k: "product_id", h: "PRODUTO", fmt: (v) => c.productById[v]?.name || "—" },
      { k: "continuation_of_id", h: "CONTINUIDADE", fmt: (v) => v ? (c.projects.find((project) => project.id === v)?.name || "Entrega anterior") : "Nova entrega" },
      { k: "start_date", h: "INÍCIO", fmt: dt },
      { k: "end_date", h: "FIM", fmt: dt },
      { k: "status", h: "STATUS", fmt: (v) => badge(v === "active" ? "won" : v === "closed" ? "lost" : "lead", PROJECT_STATUS_LABEL[v] || v) },
      { k: "substatus", h: "SUBSTATUS", fmt: (v) => PROJECT_SUBSTATUS_LABEL[v] || v || "—", cls: "muted" }];
    case "activities": return [
      { k: "client_name", h: "CLIENTE", cls: "sticky-col sticky-col-1", thCls: "sticky-col sticky-col-1" },
      { k: "product_name", h: "PRODUTO", cls: "sticky-col sticky-col-2", thCls: "sticky-col sticky-col-2" },
      { k: "activity_origin", h: "ORIGEM", fmt: (v, row) => row.parent_activity_id ? badge("lead", "Subtarefa") : badge(v === "product" ? "qualification" : "proposal", v === "product" ? "Produto" : "Dia a dia") },
      { k: "title", h: "TAREFA", fmt: (_v, row) => `${row.parent_activity_id ? '<span class="task-subtask-branch">↳</span> ' : ""}${esc(activityDisplayName(row))}` },
      { k: "priority", h: "PRIORIDADE", fmt: (v) => priorityBadge(v) },
      { k: "dependency_ids", h: "DEPENDE DE", fmt: (v, row) => stackedCell(dependencyNameList(v, row.depends_on_activity_id, c.activityRecords)), cls: "compact-multi-cell", thCls: "compact-multi-cell" },
      { k: "information", h: "INFORMAÇÃO", cls: "muted" },
      { k: "group", h: "GRUPO" },
      { k: "subgroup", h: "SUBGRUPO" },
      { k: "sector", h: "SETOR" },
      { k: "subsector", h: "SUBSETOR" },
      { k: "module", h: "MÓDULO" },
      { k: "submodule", h: "SUBMÓDULO" },
      { k: "category", h: "CATEGORIA" },
      { k: "channel", h: "CANAL" },
      { k: "type", h: "TIPO" },
      { k: "recurrence", h: "RECORRÊNCIA", fmt: (v) => RECURRENCE_LABEL[v] || "Única" },
      { k: "consider_business_days", h: "DIAS ÚTEIS", fmt: (v) => v ? "Sim" : "Não" },
      { k: "target_days", h: "PRAZO SUGERIDO", fmt: (v) => v == null ? "—" : `${v} dia(s)` },
      { k: "checklist", h: "CHECKLIST", fmt: (v, row) => {
        const subtasks = taskSubtaskProgress(row.id, c.activityRecords);
        if (subtasks.total) return `<span class="muted">Subtarefas ${subtasks.done}/${subtasks.total}</span>`;
        const progress = checklistProgress(v);
        const complete = progress.total > 0 && progress.done === progress.total;
        return `<button class="btn checklist-open${complete ? " complete" : ""}" data-id="${esc(row.id)}" title="Abrir checklist">${progress.done}/${progress.total}</button>`;
      } },
      { k: "objective_name", h: "OBJETIVO" },
      { k: "assignee_ids", h: "RESPONSÁVEIS", fmt: (v, row) => stackedCell(responsibilityNameList(v, row.owner_id, row.assignee_job_titles, row.assign_to_client)), cls: "compact-multi-cell", thCls: "compact-multi-cell" },
      { k: "references", h: "REFERÊNCIAS", fmt: (_v, row) => taskReferencesHtml(row) },
      { k: "planned_start_date", h: "INÍCIO PREVISTO", fmt: (v) => v ? dt(v) : "—" },
      { k: "planned_end_date", h: "TÉRMINO PREVISTO", fmt: (v, row) => dt(v || row.due_date) || "—" },
      { k: "actual_start_date", h: "INÍCIO REAL", fmt: (v) => v ? dt(v) : "—" },
      { k: "actual_end_date", h: "TÉRMINO REAL", fmt: (v) => v ? dt(v) : "—" },
      { k: "status", h: "STATUS", fmt: (_v, row) => inlineTaskStatus(row) },
      { k: "deadline_state", h: "PRAZO", fmt: (_v, row) => taskDeadlineBadge(row) },
      { k: "comment_count", h: "COMENTÁRIOS", fmt: (_v, row) => taskCommentsButton(row) }];
    case "conversations": return [
      { k: "contact_name", h: "NOME", fmt: (v, row, c) => (row.contact_id && c.contactById[row.contact_id]?.name) || v || "—" },
      { k: "contact", h: "CONTATO", fmt: (_v, row) => contactForConversation(row) || "—" },
      { k: "username", h: "USUÁRIO", fmt: (v, row) => v ? (row.source === "Reddit" ? `u/${v}` : v) : "—" },
      { k: "profile_url", h: "URL PERFIL", fmt: (v) => safeHttpUrl(v) ? `<a href="${esc(safeHttpUrl(v))}" target="_blank" rel="noopener">Perfil</a>` : "—", csv: (v) => v || "" },
      { k: "source", h: "CANAL" },
      { k: "first_at", h: "PRIMEIRO CONTATO" },
      { k: "last_at", h: "ÚLTIMO CONTATO" },
      { k: "imported_at", h: "DATA REGISTRO" },
      { k: "chat_url", h: "URL CHAT", fmt: (v) => safeHttpUrl(v) ? `<a href="${esc(safeHttpUrl(v))}" target="_blank" rel="noopener">Abrir</a>` : "—", csv: (v) => v || "" },
      { k: "origin", h: "DADO" },
      { k: "conversation", h: "", fmt: (_v, row) => `<button class="rowbtn open-chat" data-id="${esc(row.id)}" title="Ver mensagens no CMS">Ver</button>` }];
  }
}

function refOptions(ref, c) {
  return (c[ref] || []).map((r) => ({ value: r[pk(ref)], label: r.name || r.legal_name || r.full_name || r.title || "Registro sem nome" }));
}

function companyRefOptions(c) {
  return (c.companies || []).map((company) => ({
    value: company.tax_id,
    label: company.trade_name || company.legal_name || company.tax_id,
    detail: company.tax_id,
    search: [company.trade_name, company.legal_name, company.tax_id].filter(Boolean).join(" ")
  }));
}

function contactGroupOptions(c) {
  return normalizeTextList((c.contacts || []).flatMap((contact) => normalizeTextList(contact.groups)))
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((group) => ({ value: group, label: group }));
}

function contactTagOptions(c) {
  return normalizeTextList((c.contacts || []).flatMap((contact) => normalizeTextList(contact.tags)))
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((tag) => ({ value: tag, label: tag }));
}

function normalizeProjectBusinessMetrics(value) {
  let rows = value;
  if (typeof rows === "string") {
    try { rows = JSON.parse(rows); } catch (error) { rows = []; }
  }
  return Array.isArray(rows) ? rows.map((row) => ({
    month: String(row?.month || "").slice(0, 7),
    revenue: row?.revenue === "" || row?.revenue == null ? null : Number(row.revenue),
    channel_revenue: Object.fromEntries(Object.entries(row?.channel_revenue && typeof row.channel_revenue === "object" ? row.channel_revenue : {})
      .map(([channel, amount]) => [channel, amount === "" || amount == null ? null : Number(amount)])
      .filter(([, amount]) => Number.isFinite(amount))),
    skus: row?.skus === "" || row?.skus == null ? null : Number(row.skus),
    supplier_company_ids: normalizeIdList(row?.supplier_company_ids),
    observations: String(row?.observations || row?.notes || "")
  })).filter((row) => /^\d{4}-\d{2}$/.test(row.month)) : [];
}

function projectRevenueChannels(project) {
  const channels = normalizeTextList([
    ...normalizeTextList(project?.marketplace_channels),
    ...normalizeTextList(project?.store_platforms),
    ...(project?.store_platform ? [project.store_platform] : [])
  ]);
  return channels.length ? channels : ["NÃO INFORMADO"];
}

function projectMetricRevenue(row) {
  const channelTotal = Object.values(row?.channel_revenue || {}).reduce((total, value) => total + (Number(value) || 0), 0);
  return channelTotal || Number(row?.revenue || 0);
}

function projectMonthKeys(startDate, endDate, existing = []) {
  const keys = new Set(normalizeProjectBusinessMetrics(existing).map((row) => row.month));
  if (/^\d{4}-\d{2}/.test(startDate || "") && /^\d{4}-\d{2}/.test(endDate || "")) {
    let [year, month] = String(startDate).slice(0, 7).split("-").map(Number);
    const [endYear, endMonth] = String(endDate).slice(0, 7).split("-").map(Number);
    for (let guard = 0; guard < 120 && (year < endYear || (year === endYear && month <= endMonth)); guard += 1) {
      keys.add(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
  }
  return [...keys].sort();
}

function projectBusinessMetricsHtml(value, startDate, endDate, c = cache, channels = []) {
  const rows = normalizeProjectBusinessMetrics(value);
  const byMonth = Object.fromEntries(rows.map((row) => [row.month, row]));
  const months = projectMonthKeys(startDate, endDate, rows);
  if (!months.length) return '<div class="panel-list">Informe início e fim para gerar os meses do projeto.</div>';
  const companyOptions = companyRefOptions(c);
  const revenueChannels = channels.length ? channels : ["NÃO INFORMADO"];
  const channelTotals = Object.fromEntries(revenueChannels.map((channel) => [channel, 0]));
  let grandTotal = 0;
  const body = months.map((month) => {
    const row = byMonth[month] || {};
    const label = new Date(`${month}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    const legacyRevenue = !Object.keys(row.channel_revenue || {}).length ? row.revenue : null;
    const channelCells = revenueChannels.map((channel, index) => {
      const amount = row.channel_revenue?.[channel] ?? (index === 0 ? legacyRevenue : null);
      channelTotals[channel] += Number(amount || 0);
      return `<td><input class="business-channel-revenue" data-business-channel="${esc(channel)}" type="number" min="0" step="0.01" value="${esc(amount ?? "")}" placeholder="R$ 0,00"></td>`;
    }).join("");
    const monthTotal = revenueChannels.reduce((total, channel, index) => total + Number(row.channel_revenue?.[channel] ?? (index === 0 ? legacyRevenue : 0) ?? 0), 0);
    grandTotal += monthTotal;
    return `<tr data-business-month="${esc(month)}"><td><strong>${esc(label)}</strong></td>${channelCells}<td class="business-month-total" data-business-month-total>${brl(monthTotal)}</td><td><input class="business-skus" type="number" min="0" step="1" value="${esc(row.skus ?? "")}" placeholder="0"></td><td>${multiPickerHtml(`business-suppliers-${month}`, companyOptions, new Set(normalizeIdList(row.supplier_company_ids)), "Buscar fornecedores", true)}</td><td><textarea class="business-observations" rows="2" placeholder="Observações do mês">${esc(row.observations || "")}</textarea></td></tr>`;
  }).join("");
  return `<div class="business-metrics-table"><table><thead><tr><th>MÊS</th>${revenueChannels.map((channel) => `<th>${esc(channel)}</th>`).join("")}<th>TOTAL MENSAL</th><th>SKUs</th><th>FORNECEDORES</th><th>OBSERVAÇÕES</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th>TOTAL</th>${revenueChannels.map((channel) => `<th data-business-channel-total="${esc(channel)}">${brl(channelTotals[channel])}</th>`).join("")}<th data-business-grand-total>${brl(grandTotal)}</th><th colspan="3"></th></tr></tfoot></table></div>`;
}

function readProjectBusinessMetrics(form = document.querySelector("#modal-root .form")) {
  return [...(form?.querySelectorAll("[data-business-month]") || [])].map((row) => {
    const channelRevenue = Object.fromEntries([...row.querySelectorAll(".business-channel-revenue")]
      .filter((input) => input.value !== "")
      .map((input) => [input.dataset.businessChannel, Number(input.value)]));
    const revenue = Object.values(channelRevenue).reduce((total, amount) => total + Number(amount || 0), 0);
    return {
      month: row.dataset.businessMonth,
      revenue: Object.keys(channelRevenue).length ? revenue : null,
      channel_revenue: channelRevenue,
      skus: row.querySelector(".business-skus")?.value === "" ? null : Number(row.querySelector(".business-skus")?.value),
      supplier_company_ids: multiPickerValues(`business-suppliers-${row.dataset.businessMonth}`),
      observations: row.querySelector(".business-observations")?.value.trim() || ""
    };
  }).filter((row) => row.revenue != null || row.skus != null || row.supplier_company_ids.length || row.observations);
}

function dealContactOptions(c, companyId) {
  if (!companyId) return [];
  const linkedIds = new Set((c.contactCompanies || [])
    .filter((link) => String(link.company_id) === String(companyId))
    .map((link) => String(link.contact_id)));
  return (c.contacts || [])
    .filter((contact) => linkedIds.has(String(contact.id)))
    .map((contact) => ({ value: contact.id, label: contact.name || "Contato sem nome" }));
}

function companyNames(ids, c = cache) {
  return normalizeIdList(ids).map((id) => c?.companyById?.[id]?.trade_name || c?.companyById?.[id]?.legal_name || "Empresa não encontrada").join(", ") || "—";
}

function contactNames(ids, c = cache) {
  return normalizeIdList(ids).map((id) => c?.contactById?.[id]?.name || "Pessoa não encontrada").join(", ") || "—";
}

function userByReference(id, c = cache) {
  if (!id) return null;
  return c?.userById?.[id] || c?.userByAuthId?.[id] || null;
}

function userDisplayName(id, c = cache, missing = "Responsável não encontrado") {
  const user = userByReference(id, c);
  return user?.nickname || user?.full_name || user?.name || user?.email || missing;
}
// Etapas do pipeline selecionado (ou o primeiro cadastrado, na falta de um).
// Como agora são texto livre por pipeline, valor e rótulo da opção são o
// próprio texto da etapa.
function pipelineStageOptions(c, pipelineId) {
  const pipeline = (c.pipelineById && c.pipelineById[pipelineId]) || (c.pipelines || [])[0];
  return (pipeline?.stages || []).map((s) => ({ value: s, label: s }));
}
function fields(tab, c) {
  switch (tab) {
    case "companies": return [
      { k: "tax_id", label: "CNPJ", req: true, full: true, lookup: "cnpj" },
      { k: "legal_name", label: "Nome empresarial", full: true, receita: true },
      { k: "trade_name", label: "Nome fantasia", receita: true },
      { k: "contact_type", label: "Tipo de contato", type: "multi", options: COMPANY_CONTACT_TYPE_OPTIONS.map((value) => ({ value, label: value })), textValues: true, placeholder: "Vazio", lockedValues: (record) => companyHasDelivery(record?.tax_id) ? ["Cliente"] : [], help: "Aceita mais de uma opção. Ao salvar, as pessoas vinculadas recebem estes tipos; vazio não altera as pessoas. Empresa com entrega é sempre Cliente." },
      { k: "email", label: "E-mail", receita: true },
      { k: "phone", label: "Telefone", receita: true },
      { k: "headquarters", label: "Sede", receita: true },
      { k: "founded_at", label: "Data de abertura", type: "date", receita: true },
      { k: "registration_status", label: "Situação cadastral", receita: true },
      { k: "state_registrations", label: "Inscrições estaduais", type: "ie_list", full: true, help: "A primeira é a do estado da empresa. Preenchida pela consulta quando disponível; adicione outras UFs se a empresa tiver inscrição como substituta." },
      { k: "municipal_registration", label: "Inscrição municipal" },
      { k: "qsa", label: "QSA", type: "textarea", full: true, receita: true },
      { k: "share_capital", label: "Capital social (R$)", type: "number", min: 0, step: 0.01, receita: true },
      { k: "activities", label: "Atividades", full: true, receita: true },
      { k: "address", label: "Endereço", full: true, receita: true },
      { k: "zip_code", label: "CEP", receita: true },
      { k: "city", label: "Cidade", receita: true },
      { k: "state", label: "UF", receita: true },
      { k: "contact_ids", label: "Pessoas vinculadas", type: "multi", options: refOptions("contacts", c), full: true, placeholder: "Selecionar pessoas" },
      { k: "notes", label: "Observações", full: true }];
    case "contacts": return [
      { k: "name", label: "Nome completo", req: true, full: true },
      { k: "phone", label: "Telefone/celular" },
      { k: "email", label: "Email(s)" },
      { k: "contact_type", label: "Tipo de contato", type: "multi", options: CONTACT_TYPE_OPTIONS.map((value) => ({ value, label: value })), textValues: true, full: true, placeholder: "Selecionar tipos", help: "Relação da pessoa com a operação ou com a empresa; aceita mais de uma opção." },
      { k: "channel", label: "Canal", type: "select", options: CONTACT_CHANNEL_OPTIONS.map((value) => ({ value, label: value })), help: "Origem do primeiro contato com a empresa." },
      { k: "job_title", label: "Cargo" },
      { k: "department", label: "Departamento" },
      { k: "company_ids", label: "Empresa(s)", type: "multi", options: companyRefOptions(c), full: true, placeholder: "Buscar por nome ou CNPJ", searchOnly: true },
      { k: "linkedin", label: "LinkedIn" },
      { k: "facebook", label: "Facebook" },
      { k: "instagram", label: "Instagram" },
      { k: "reddit", label: "Reddit" },
      { k: "whatsapp", label: "WhatsApp" },
      { k: "youtube", label: "YouTube" },
      { k: "groups", label: "Grupos/comunidades", type: "multi", options: contactGroupOptions(c), textValues: true, allowCreate: true, full: true, placeholder: "Buscar ou adicionar grupos" },
      { k: "tags", label: "Tags", type: "multi", options: contactTagOptions(c), textValues: true, allowCreate: true, full: true, placeholder: "Buscar ou adicionar tags" },
      { k: "notes", label: "Observações", type: "textarea", full: true },
      { k: "birth_date", label: "Data de nascimento", type: "date" },
      { k: "cpf", label: "CPF" }];
    case "products": return [
      { k: "category", label: "Categoria" },
      { k: "name", label: "Produto", req: true },
      { k: "description", label: "Descrição", full: true },
      { k: "price", label: "Preço à vista (R$)", type: "number" },
      { k: "price_installment", label: "Preço parcelado (R$)", type: "number" },
      { k: "sales_page", label: "Página de vendas", full: true },
      { k: "duration_days", label: "Duração da entrega (dias)", type: "number" },
      { k: "status", label: "Status", type: "select", options: [{ value: "Ativo", label: "Ativo" }, { value: "Pausado", label: "Pausado" }, { value: "Inativo", label: "Inativo" }], def: "Ativo" }];
    case "deals": return [
      { k: "title", label: "Título", req: true, full: true },
      { k: "company_id", label: "Empresa", type: "search", options: companyRefOptions(c), placeholder: "Buscar por nome ou CNPJ" },
      { k: "no_company", label: "Não possui empresa", type: "checkbox", embedded: true },
      { k: "contact_id", label: "Contato", type: "select", options: [] },
      { k: "product_id", label: "Produto", type: "select", options: refOptions("products", c) },
      { k: "pipeline_id", label: "Pipeline", type: "select", options: (c.pipelines || []).map((p) => ({ value: p.id, label: p.name })), req: true },
      { k: "stage", label: "Etapa", type: "select", options: pipelineStageOptions(c, null) },
      { k: "status", label: "Status", type: "select", options: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })), def: "open" },
      { k: "lead_source", label: "Origem do lead", type: "select", options: SOURCES.map((s) => ({ value: s, label: s })) },
      { k: "amount", label: "Valor (R$)", type: "number" },
      { k: "expected_close_date", label: "Previsão", type: "date" }];
    case "projects": return [
      { k: "name", label: "Entrega", full: true, generated: true },
      { k: "delivery_type", label: "Tipo", type: "select", options: ["Projeto", "Imersão", "Treinamento", "Consultoria", "Evento", "Serviço recorrente", "Outro"].map((value) => ({ value, label: value })), def: "Projeto", full: true },
      { k: "company_id", label: "Empresa", type: "search", options: companyRefOptions(c), req: true, full: true, placeholder: "Buscar por nome ou CNPJ" },
      { k: "client_name", label: "Cliente", req: true },
      { k: "group_name", label: "Grupo" },
      { k: "product_id", label: "Produto", type: "select", options: refOptions("products", c), req: true },
      { k: "continuation_of_id", label: "Continuidade de", type: "select", options: [] },
      { k: "status", label: "Status", type: "select", options: PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABEL[s] })), def: "active" },
      { k: "substatus", label: "Substatus", type: "select", options: PROJECT_SUBSTATUS.map((s) => ({ value: s, label: PROJECT_SUBSTATUS_LABEL[s] })) },
      { k: "start_date", label: "Início", type: "date" },
      { k: "end_date", label: "Fim", type: "date" },
      { k: "erp_platform", label: "ERP", type: "select", options: deliveryChannelOptions("erp"), lockWhenSet: true, full: true },
      { k: "marketplace_channels", label: "Marketplaces", type: "multi", options: deliveryChannelOptions("marketplaces"), addOnly: true, full: true, placeholder: "Selecionar marketplaces" },
      { k: "store_platforms", label: "Lojas", type: "multi", options: deliveryChannelOptions("stores"), addOnly: true, full: true, placeholder: "Selecionar lojas" },
      { k: "freight_channels", label: "Frete", type: "multi", options: deliveryChannelOptions("freight"), addOnly: true, full: true, placeholder: "Selecionar canais de frete" },
      { k: "company_setup", label: "Situação da empresa", type: "select", options: DELIVERY_COMPANY_SETUP_OPTIONS.map((value) => ({ value, label: value })), full: true },
      { k: "financial_accounts", label: "Contas financeiras", type: "multi", options: deliveryChannelOptions("financial"), addOnly: true, full: true, placeholder: "Selecionar bancos e gateways", help: "Mercado Livre inclui Mercado Pago e Mercado Envios; Nuvem Shop inclui Nuvem Pago e Nuvem Envio; Tray inclui Vindi." }];
  }
}

// ---------- Estado ----------
function loadColPrefs() {
  try { return JSON.parse(localStorage.getItem("crm_cols_v2") || "{}"); }
  catch (e) { return {}; }
}
function saveColPrefs() {
  localStorage.setItem("crm_cols_v2", JSON.stringify(colPrefs));
}
let colPrefs = loadColPrefs();
let state = {
  tab: "home", view: "dashboard", sortK: null, sortDir: 1, q: "", filters: {},
  groupActivitiesByClient: false,
  expandedActivityClients: new Set(),
  selectedConversations: new Set(),
  bulkSelections: {
    contacts: new Set(), companies: new Set(), deals: new Set(), products: new Set(),
    projects: new Set(), activities: new Set()
  },
  pages: { contacts: 1, companies: 1, conversations: 1, deals: 1, products: 1, projects: 1, activities: 1 },
  pageSize: 50, kanbanPipelineId: null, calendarCursor: null
};
const secondaryTableSelections = new Map();

function secondaryTableSelection(scope) {
  if (!secondaryTableSelections.has(scope)) secondaryTableSelections.set(scope, new Set());
  return secondaryTableSelections.get(scope);
}

function orderLeadingTableCells(row, cells) {
  const select = cells.find((cell) => cell.classList.contains("select-cell") || cell.classList.contains("select-head"));
  const expand = cells.find((cell) => cell.classList.contains("expand-cell") || cell.classList.contains("expand-head"));
  cells.filter((cell) => cell !== select && cell !== expand).forEach((cell) => row.appendChild(cell));
  if (expand) row.insertBefore(expand, row.firstChild);
  if (select) row.insertBefore(select, row.firstChild);
}

const tableExpandMemory = new Map();
function tableExpandHeadInner(enabled, allExpanded) {
  const label = !enabled ? "Nada para expandir nesta tabela" : allExpanded ? "Recolher todos" : "Expandir todos";
  return `<button class="table-expand-btn table-expand-all" type="button" title="${label}" aria-label="${label}"${enabled ? "" : " disabled"}>${enabled && allExpanded ? "▾" : "▸"}</button>`;
}
function tableRowExpandInner(expanded, extraClass = "", attrs = "") {
  const label = expanded ? "Recolher" : "Expandir";
  return `<button class="table-expand-btn table-row-expand${extraClass ? ` ${extraClass}` : ""}" type="button" title="${label}" aria-label="${label}" aria-expanded="${expanded}"${attrs}>${expanded ? "▾" : "▸"}</button>`;
}

function wireTableExpandColumn(table, scope) {
  const headRow = table.tHead?.rows?.[0];
  if (!headRow || headRow.querySelector(".expand-head")) return;
  const dataRows = [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty"));
  const childrenOf = (id) => dataRows.filter((row) => row.dataset.expandParent === id);
  const parents = dataRows.filter((row) => row.dataset.expandId && childrenOf(row.dataset.expandId).length);
  if (!tableExpandMemory.has(scope)) tableExpandMemory.set(scope, new Map());
  const memory = tableExpandMemory.get(scope);
  const head = document.createElement("th");
  head.className = "expand-head noclick";
  const selectHead = headRow.querySelector(":scope > .select-head");
  headRow.insertBefore(head, selectHead ? selectHead.nextSibling : headRow.firstChild);
  dataRows.forEach((row) => {
    const cell = document.createElement("td");
    cell.className = "expand-cell";
    const selectCell = row.querySelector(":scope > .select-cell");
    row.insertBefore(cell, selectCell ? selectCell.nextSibling : row.firstChild);
  });
  table.querySelectorAll("tbody tr .empty").forEach((cell) => { cell.colSpan = Number(cell.colSpan || 1) + 1; });
  const proxyOf = (parent) => parent.querySelector(".registration-task-toggle[data-group]");
  const isExpanded = (parent) => childrenOf(parent.dataset.expandId).some((row) => !row.hidden);
  const paint = (parent) => {
    const button = parent.querySelector(":scope > .expand-cell .table-row-expand");
    if (!button) return;
    const expanded = isExpanded(parent);
    button.textContent = expanded ? "▾" : "▸";
    button.title = expanded ? "Recolher" : "Expandir";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(expanded));
  };
  const paintHead = () => { head.innerHTML = tableExpandHeadInner(parents.length > 0, parents.length > 0 && parents.every(isExpanded)); };
  const setExpanded = (parent, expanded) => {
    const proxy = proxyOf(parent);
    if (proxy) { if (isExpanded(parent) !== expanded) proxy.click(); }
    else childrenOf(parent.dataset.expandId).forEach((row) => { row.hidden = !expanded; });
    memory.set(parent.dataset.expandId, expanded);
    paint(parent);
  };
  parents.forEach((parent) => {
    const id = parent.dataset.expandId;
    if (!proxyOf(parent) && memory.has(id)) childrenOf(id).forEach((row) => { row.hidden = !memory.get(id); });
    const cell = parent.querySelector(":scope > .expand-cell");
    cell.innerHTML = tableRowExpandInner(isExpanded(parent));
    cell.firstChild.addEventListener("click", (event) => {
      event.stopPropagation();
      setExpanded(parent, !isExpanded(parent));
      paintHead();
    });
  });
  paintHead();
  head.addEventListener("click", (event) => {
    if (!event.target.closest(".table-expand-all") || !parents.length) return;
    event.stopPropagation();
    const expand = parents.some((parent) => !isExpanded(parent));
    parents.forEach((parent) => setExpanded(parent, expand));
    paintHead();
  });
}

function renderTableActionsHead(head, count, provider, getIds, clearSelection) {
  if (!head) return;
  if (!count) {
    head.classList.remove("has-bulk-actions");
    head.textContent = "AÇÕES";
    return;
  }
  const canEdit = Boolean(provider && provider.canEdit !== false && provider.fields().length);
  const editTitle = canEdit ? `Editar campo de ${count} selecionado(s)` : "Edição em massa indisponível nesta tabela";
  head.classList.add("has-bulk-actions");
  head.innerHTML = `<span class="table-actions table-bulk-actions"><button type="button" class="rowbtn table-action-btn action-edit table-bulk-edit${canEdit ? "" : " is-disabled"}" title="${esc(editTitle)}" aria-label="${esc(editTitle)}"${canEdit ? "" : " disabled"}>${TABLE_ACTION_ICONS.edit}</button><button type="button" class="rowbtn table-action-btn table-bulk-clear" title="Limpar seleção (${count})" aria-label="Limpar seleção">${TABLE_BULK_CLEAR_ICON}</button></span>`;
  head.querySelector(".table-bulk-edit")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openTableBulkEditor(event.currentTarget, provider, getIds());
  });
  head.querySelector(".table-bulk-clear")?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearSelection();
  });
}

const TABLE_BULK_CLEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TASK_BULK_FIELDS = () => [
  { k: "status", label: "Status", type: "select", options: TASK_STATUS.map((status) => ({ value: status.id, label: status.label })) },
  { k: "priority", label: "Prioridade", type: "select", options: PRIORITY_OPTIONS.map(([value, label]) => ({ value, label })) },
  { k: "category", label: "Categoria", type: "text" },
  { k: "channel", label: "Canal", type: "text" },
  { k: "module", label: "Módulo", type: "text" },
  { k: "submodule", label: "Submódulo", type: "text" },
  { k: "type", label: "Tipo", type: "text" },
  { k: "planned_start_date", label: "Início previsto", type: "date" },
  { k: "planned_end_date", label: "Término previsto", type: "date" }
];
const MAIN_BULK_FIELD_KEYS = {
  contacts: ["channel", "job_title", "department", "notes"],
  companies: ["notes"],
  deals: ["product_id", "lead_source", "amount", "expected_close_date"],
  products: ["category", "status", "price", "price_installment", "duration_days"],
  projects: ["delivery_type", "group_name", "status", "substatus", "start_date", "end_date"]
};

function bulkSuggestions(rows, key) {
  return [...new Set((rows || []).map((row) => String(row?.[key] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function taskBulkProvider(rows, rerender, keys = null) {
  return {
    canEdit: currentUserCan("activities", "edit"),
    fields: () => TASK_BULK_FIELDS().filter((field) => !keys || keys.includes(field.k)).map((field) => field.type === "text" ? { ...field, suggestions: bulkSuggestions(rows(), field.k) } : field),
    apply: async (ids, patch) => {
      const dates = "planned_start_date" in patch || "planned_end_date" in patch;
      const changes = { ...patch };
      if ("planned_end_date" in changes) changes.due_date = changes.planned_end_date;
      if (dates) changes.schedule_manual = true;
      let updated = 0;
      let refused = 0;
      const projects = new Set();
      for (const id of ids) {
        const task = loadProjectTasks().find((item) => item.id === id);
        if (!task) continue;
        if (changes.status && taskStatusTransitionError(task.status || "todo", changes.status)) { refused += 1; continue; }
        if (await updateProjectTask(id, changes)) { updated += 1; projects.add(task.project_id); }
      }
      if (refused) toast(`${refused} tarefa(s) mantida(s) pelo fluxo de status: Em andamento não volta para Em aberto e cancelar ou reabrir é só para administradores.`, true);
      if (dates) for (const projectId of projects) await recalculateDependencySchedules(projectId);
      return updated;
    },
    done: rerender
  };
}

function mainTabBulkProvider(tab) {
  if (tab === "activities") return taskBulkProvider(() => loadProjectTasks(), () => render(), ["status", "priority"]);
  const keys = MAIN_BULK_FIELD_KEYS[tab];
  if (!keys) return null;
  return entityBulkProvider(tab, keys, () => render());
}

function entityBulkProvider(tab, keys, rerender) {
  return {
    canEdit: currentUserCan(tab, "edit"),
    fields: () => {
      const definitions = fields(tab, cache) || [];
      return keys.map((key) => definitions.find((field) => field.k === key)).filter(Boolean).map((field) => ({
        k: field.k, label: field.label, type: ["select", "number", "date", "textarea", "checkbox"].includes(field.type) ? field.type : "text",
        options: field.options, suggestions: field.type ? undefined : bulkSuggestions(cache?.[tab], field.k)
      }));
    },
    apply: async (ids, patch) => {
      let updated = 0;
      for (const id of ids) {
        const record = (cache?.[tab] || []).find((row) => String(row[pk(tab)]) === String(id));
        if (!record) continue;
        const body = { ...patch };
        if (tab === "projects") {
          const status = body.status ?? record.status;
          if (status === "active") body.substatus = null;
          if (status === "closed") body.substatus = "closed";
          if (status === "inactive" && !(body.substatus ?? record.substatus)) { toast("Entrega inativa precisa de substatus (Suporte ou Encerrado).", true); continue; }
        }
        const saved = await updateRow(tab, record[pk(tab)], body);
        upsertCachedEntity(tab, saved || { ...record, ...body });
        updated += 1;
      }
      return updated;
    },
    done: rerender
  };
}

function templateBulkProvider(section) {
  const config = {
    activities: { table: "productActivities", permission: "activityTemplates", load: loadProductActivities, save: saveProductActivities, cacheKey: "productActivities",
      fields: [
        { k: "category", label: "Categoria", type: "text" }, { k: "channel", label: "Canal", type: "text" },
        { k: "module", label: "Módulo", type: "text" }, { k: "submodule", label: "Submódulo", type: "text" },
        { k: "type", label: "Tipo", type: "text" },
        { k: "priority", label: "Prioridade", type: "select", options: PRIORITY_OPTIONS.map(([value, label]) => ({ value, label })) },
        { k: "recurrence", label: "Recorrência", type: "select", options: RECURRENCE_OPTIONS.map(([value, label]) => ({ value, label })) },
        { k: "target_days", label: "Prazo (dias)", type: "number" },
        { k: "start_after_days", label: "Iniciar após dependência (dias)", type: "number" },
        { k: "consider_business_days", label: "Dias úteis", type: "checkbox" }
      ],
      sync: async () => { await syncProductActivities(); refreshActivityCache(); } },
    objectives: { table: "productObjectives", permission: "objectiveTemplates", load: loadProductObjectives, save: saveProductObjectives, cacheKey: "productObjectives",
      fields: [{ k: "category", label: "Categoria", type: "text" }, { k: "channel", label: "Canal", type: "text" }, { k: "notes", label: "Observações", type: "textarea" }],
      sync: async () => { await syncProductObjectives(); await syncProductActivities(); refreshActivityCache(); } },
    goals: { table: "productGoals", permission: "goalTemplates", load: loadProductGoals, save: saveProductGoals, cacheKey: "productGoals",
      fields: [{ k: "category", label: "Categoria", type: "text" }, { k: "channel", label: "Canal", type: "text" }, { k: "notes", label: "Observações", type: "textarea" }],
      sync: async () => { await syncProductGoals(); refreshActivityCache(); } }
  }[section];
  if (!config) return null;
  return {
    canEdit: currentUserCan(config.permission, "edit"),
    fields: () => config.fields.map((field) => field.type === "text" ? { ...field, suggestions: bulkSuggestions(config.load(), field.k) } : field),
    apply: async (ids, patch) => {
      const rows = config.load();
      const targets = new Map();
      ids.forEach((id) => {
        const item = rows.find((row) => row.id === id);
        if (!item) return;
        const linked = section === "activities" ? rows.filter((row) => (row.template_group_id || row.id) === (item.template_group_id || item.id)) : [item];
        linked.forEach((row) => targets.set(row.id, row));
      });
      for (const row of targets.values()) {
        const changes = { ...patch, updated_at: new Date().toISOString() };
        const saved = isLive() ? await updateRow(config.table, row.id, changes) : { ...row, ...changes };
        Object.assign(row, saved);
      }
      if (isLive()) cache[config.cacheKey] = rows;
      else config.save(rows);
      return ids.filter((id) => rows.some((row) => row.id === id)).length;
    },
    done: async () => {
      renderRegistrationsSection();
      toast("Sincronizando com as entregas...");
      try { await config.sync(); } catch (err) { toast("Erro ao sincronizar com as entregas · " + err.message, true); }
    }
  };
}

function deliveryBulkProvider(projectId, section) {
  const rerender = () => renderProjectBoard(projectId);
  if (section === "activities") return taskBulkProvider(() => projectTasks(projectId), rerender);
  const isGoal = section === "goals";
  if (!["objectives", "goals"].includes(section)) return null;
  const load = isGoal ? loadDeliveryGoals : loadDeliveryObjectives;
  return {
    canEdit: currentUserCan("projects", "edit"),
    fields: () => [
      { k: "status", label: "Status", type: "select", options: TASK_STATUS.map((status) => ({ value: status.id, label: status.label })) },
      { k: "category", label: "Categoria", type: "text", suggestions: bulkSuggestions(load().filter((row) => row.project_id === projectId), "category") },
      { k: "channel", label: "Canal", type: "text", suggestions: bulkSuggestions(load().filter((row) => row.project_id === projectId), "channel") },
      { k: "notes", label: "Observações", type: "textarea" }
    ],
    apply: async (ids, patch) => {
      let updated = 0;
      for (const id of ids) {
        const ok = isGoal ? await updateDeliveryGoal(id, patch) : await updateDeliveryObjective(id, patch);
        if (ok) updated += 1;
      }
      return updated;
    },
    done: rerender
  };
}

function tableBulkEditProvider(scope) {
  const [kind, first, second] = String(scope || "").split(":");
  if (kind === "main") return mainTabBulkProvider(first);
  if (kind === "registrations") {
    if (first === "products") return entityBulkProvider("products", MAIN_BULK_FIELD_KEYS.products, () => renderRegistrationsSection());
    return templateBulkProvider(first);
  }
  if (kind === "delivery") return deliveryBulkProvider(first, second);
  return null;
}

function bulkValueControlHtml(field) {
  if (field.type === "select") return `<select id="bulk-edit-value"><option value="">— Limpar —</option>${(field.options || []).map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("")}</select>`;
  if (field.type === "checkbox") return '<select id="bulk-edit-value"><option value="true">Sim</option><option value="false">Não</option></select>';
  if (field.type === "textarea") return '<textarea id="bulk-edit-value" rows="3" placeholder="Vazio limpa o campo"></textarea>';
  const type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
  const list = field.suggestions?.length ? `<datalist id="bulk-edit-suggestions">${field.suggestions.map((value) => `<option value="${esc(value)}"></option>`).join("")}</datalist>` : "";
  return `<input id="bulk-edit-value" type="${type}"${list ? ' list="bulk-edit-suggestions"' : ""} placeholder="Vazio limpa o campo">${list}`;
}

function openTableBulkEditor(anchor, provider, ids) {
  document.getElementById("table-bulk-dd")?.remove();
  if (!provider || !ids.length) return;
  const fieldsList = provider.fields();
  if (!fieldsList.length) return;
  const panel = document.createElement("div");
  panel.id = "table-bulk-dd";
  panel.className = "data-dd table-bulk-dd";
  panel.innerHTML = `<div class="dd-head"><span>Editar em massa</span><span>${ids.length} selecionado(s)</span></div>
    <div class="table-bulk-body">
      <label>Campo<select id="bulk-edit-field">${fieldsList.map((field, index) => `<option value="${index}">${esc(field.label)}</option>`).join("")}</select></label>
      <label>Novo valor<span id="bulk-edit-value-slot"></span></label>
      <div class="table-bulk-foot"><button class="btn" type="button" id="bulk-edit-cancel">Cancelar</button><button class="btn primary" type="button" id="bulk-edit-apply">Aplicar</button></div>
    </div>`;
  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.right = "auto";
  panel.style.left = `${Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288))}px`;
  panel.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 260)}px`;
  const fieldSelect = panel.querySelector("#bulk-edit-field");
  const paintValue = () => {
    panel.querySelector("#bulk-edit-value-slot").innerHTML = bulkValueControlHtml(fieldsList[Number(fieldSelect.value)]);
    panel.querySelector("#bulk-edit-value")?.focus({ preventScroll: true });
  };
  fieldSelect.addEventListener("change", paintValue);
  paintValue();
  const close = () => { panel.remove(); document.removeEventListener("mousedown", outside, true); };
  const outside = (event) => { if (!panel.contains(event.target) && !anchor.contains(event.target)) close(); };
  setTimeout(() => document.addEventListener("mousedown", outside, true), 60);
  panel.querySelector("#bulk-edit-cancel").addEventListener("click", close);
  panel.querySelector("#bulk-edit-apply").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    const field = fieldsList[Number(fieldSelect.value)];
    const raw = panel.querySelector("#bulk-edit-value")?.value ?? "";
    let value = String(raw).trim() === "" ? null : raw;
    if (field.type === "checkbox") value = raw === "true";
    else if (field.type === "number" && value != null) value = Number(value);
    else if (typeof value === "string" && field.type !== "textarea") value = value.trim();
    button.disabled = true;
    button.textContent = "Aplicando...";
    try {
      const updated = await provider.apply(ids, { [field.k]: value });
      close();
      toast(`${field.label} atualizado em ${updated} de ${ids.length} registro(s).`, updated < ids.length);
      await provider.done?.();
    } catch (err) {
      toast("Erro na edição em massa · " + err.message, true);
      button.disabled = false;
      button.textContent = "Aplicar";
    }
  });
}

function wireSecondaryTableSelection(table, scope) {
  if (!table || table.querySelector("thead .secondary-select-all")) return;
  const rows = [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty") && !row.dataset.groupRow);
  const selected = secondaryTableSelection(scope);
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  const head = document.createElement("th");
  head.className = "select-head noclick";
  head.innerHTML = '<input type="checkbox" class="secondary-select-all" aria-label="Selecionar linhas visíveis">';
  headRow.insertBefore(head, headRow.firstChild);
  rows.forEach((row, index) => {
    const rowId = String(row.dataset.rowId || row.dataset.id || row.dataset.objectiveId || row.dataset.goalId
      || row.querySelector("[data-id]")?.dataset.id || `${scope}:${index}`);
    row.dataset.selectionId = rowId;
    const cell = document.createElement("td");
    cell.className = "select-cell";
    cell.innerHTML = `<input type="checkbox" class="secondary-row-select" aria-label="Selecionar linha"${selected.has(rowId) ? " checked" : ""}>`;
    row.insertBefore(cell, row.firstChild);
  });
  table.querySelectorAll("tbody tr[data-group-row]").forEach((row) => {
    const cell = document.createElement("td");
    cell.className = "select-cell";
    row.insertBefore(cell, row.firstChild);
  });
  table.querySelectorAll("tbody tr .empty").forEach((cell) => {
    cell.colSpan = Number(cell.colSpan || headRow.cells.length - 1) + 1;
  });
  wireTableExpandColumn(table, scope);
  const actionsHead = headRow.querySelector(".table-actions-head");
  const bulkProvider = tableBulkEditProvider(scope);
  const host = table.closest("#registrations-root, #project-board-root, #tools-root, #product-activities-root") || table.parentElement;
  const toolbar = host?.querySelector(".registration-toolbar-left, .project-data-toolbar .registration-toolbar-left, .tools-toolbar .registration-toolbar-left, .modal-toolbar");
  let count = toolbar?.querySelector(".table-selection-count");
  if (toolbar && !count) {
    count = document.createElement("span");
    count.className = "muted table-selection-count";
    toolbar.appendChild(count);
  }
  const refresh = () => {
    const visibleRows = rows.filter((row) => !row.hidden);
    const visibleSelected = visibleRows.filter((row) => selected.has(row.dataset.selectionId));
    const all = head.querySelector("input");
    all.checked = Boolean(visibleRows.length && visibleSelected.length === visibleRows.length);
    all.indeterminate = Boolean(visibleSelected.length && visibleSelected.length < visibleRows.length);
    rows.forEach((row) => row.classList.toggle("selected", selected.has(row.dataset.selectionId)));
    if (count) {
      count.textContent = selected.size ? `${selected.size} selecionado(s)` : "";
      count.hidden = !selected.size;
    }
    table.classList.toggle("has-selection", selected.size > 0);
    renderTableActionsHead(actionsHead, selected.size, bulkProvider, () => [...selected], () => {
      selected.clear();
      rows.forEach((row) => { const box = row.querySelector(".secondary-row-select"); if (box) box.checked = false; });
      refresh();
    });
  };
  table._refreshSecondarySelection = () => { refresh(); };
  table.querySelectorAll(".secondary-row-select").forEach((box) => box.addEventListener("change", () => {
    const row = box.closest("tr");
    if (box.checked) selected.add(row.dataset.selectionId); else selected.delete(row.dataset.selectionId);
    refresh();
  }));
  head.querySelector("input").addEventListener("change", (event) => {
    rows.filter((row) => !row.hidden).forEach((row) => {
      if (event.target.checked) selected.add(row.dataset.selectionId); else selected.delete(row.dataset.selectionId);
      row.querySelector(".secondary-row-select").checked = event.target.checked;
    });
    refresh();
  });
  refresh();
}

function tabFilters(tab = state.tab) {
  if (!state.filters[tab]) state.filters[tab] = {};
  return state.filters[tab];
}
function orderedColumns(tab, c) {
  const prefs = colPrefs[tab] || {};
  const cols = columns(tab, c);
  const savedOrder = Array.isArray(prefs.__order) ? prefs.__order : [];
  const byKey = Object.fromEntries(cols.map((col) => [col.k, col]));
  return [
    ...savedOrder.map((key) => byKey[key]).filter(Boolean),
    ...cols.filter((col) => !savedOrder.includes(col.k))
  ];
}
function visibleColumns(tab, c) {
  const prefs = colPrefs[tab] || {};
  return orderedColumns(tab, c).filter((col) => prefs[col.k] !== false);
}
function displayValue(row, col, c) {
  const val = col.fmt ? col.fmt(row[col.k], row, c) : esc(row[col.k] ?? "—");
  return String(val ?? "").replace(/<[^>]+>/g, "");
}

function rowsFor(tab, c) {
  let rows = c[tab] || [];
  if (state.q) {
    const q = state.q.toLowerCase();
    const cols = columns(tab, c);
    rows = rows.filter((r) => cols.some((col) => displayValue(r, col, c).toLowerCase().includes(q)));
  }
  const filters = tabFilters(tab);
  for (const [k, vals] of Object.entries(filters)) {
    if (!vals || vals.size === 0) continue;
    rows = rows.filter((r) => vals.has(String(r[k] ?? "")));
  }
  if (state.sortK) {
    rows = [...rows].sort((a, b) => {
      const av = a[state.sortK], bv = b[state.sortK];
      if (av == null) return 1; if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * state.sortDir;
    });
  }
  return rows;
}

// ---------- Render tabela ----------
function renderTable(c) {
  const cols = visibleColumns(state.tab, c);
  let allRows = rowsFor(state.tab, c);
  const groupByClient = state.tab === "activities" && state.groupActivitiesByClient;
  if (groupByClient) {
    allRows = [...allRows].sort((a, b) => String(a.client_name || "Sem cliente").localeCompare(String(b.client_name || "Sem cliente"), "pt-BR", { sensitivity: "base" }));
  }
  const clientCounts = groupByClient ? allRows.reduce((counts, row) => {
    const client = String(row.client_name || "Sem cliente");
    counts.set(client, (counts.get(client) || 0) + 1);
    return counts;
  }, new Map()) : new Map();
  const clientNames = groupByClient ? [...clientCounts.keys()] : [];
  const paginated = true;
  const paginationLength = groupByClient ? clientNames.length : allRows.length;
  const totalPages = paginated ? Math.max(1, Math.ceil(paginationLength / state.pageSize)) : 1;
  if (paginated) state.pages[state.tab] = Math.min(Math.max(1, state.pages[state.tab] || 1), totalPages);
  const currentPage = paginated ? state.pages[state.tab] : 1;
  const pageStart = (currentPage - 1) * state.pageSize;
  const pageClientNames = groupByClient ? new Set(clientNames.slice(pageStart, pageStart + state.pageSize)) : null;
  const rows = groupByClient
    ? allRows.filter((row) => pageClientNames.has(String(row.client_name || "Sem cliente")))
    : paginated ? allRows.slice(pageStart, currentPage * state.pageSize) : allRows;
  const filters = tabFilters();
  const selectable = ["conversations", "contacts", "companies", "deals", "products", "projects", "activities"].includes(state.tab);
  const selectedSet = state.tab === "conversations" ? state.selectedConversations : state.bulkSelections[state.tab];
  const rowKey = pk(state.tab);
  const selectedVisible = selectable ? rows.filter((r) => selectedSet.has(String(r[rowKey]))) : [];
  const selectHead = selectable
    ? `<th class="select-head noclick"><input type="checkbox" id="select-all-rows"${rows.length && selectedVisible.length === rows.length ? " checked" : ""}></th>`
    : "";
  const actionHead = tableActionsHead();
  const expandableClients = groupByClient ? clientNames : [];
  const expandHead = `<th class="expand-head noclick">${tableExpandHeadInner(expandableClients.length > 0, expandableClients.length > 0 && expandableClients.every((client) => state.expandedActivityClients.has(client)))}</th>`;
  const head = selectHead + expandHead + cols.map((col) => {
    const isFiltered = filters[col.k]?.size > 0;
    const arr = isFiltered ? `<span class="arrow">▼</span>` : state.sortK === col.k ? `<span class="arrow">${state.sortDir > 0 ? "▲" : "▼"}</span>` : "";
    const cls = [isFiltered ? "filtered" : "", col.thCls || ""].filter(Boolean).join(" ");
    return `<th data-k="${col.k}" class="${cls}" title="Clique para ordenar. Ctrl+clique para filtrar.">${col.h}${arr}</th>`;
  }).join("") + actionHead;

  let previousClient = null;
  const body = rows.map((r) => {
    const rid = r[rowKey];
    const client = String(r.client_name || "Sem cliente");
    const clientExpanded = groupByClient && state.expandedActivityClients.has(client);
    const groupCells = groupByClient ? cols.map((col, index) => index === 0
      ? `<td data-k="${esc(col.k)}"><button class="client-group-toggle" type="button" data-client="${esc(client)}" title="${clientExpanded ? "Recolher" : "Expandir"} tarefas de ${esc(client)}"><strong>${esc(client)}</strong><span class="registration-subtask-count">${clientCounts.get(client) || 0}</span></button></td>`
      : `<td data-k="${esc(col.k)}"></td>`).join("") : "";
    const groupHeader = groupByClient && client !== previousClient
      ? `<tr class="client-group-row" data-client="${esc(client)}">${selectable ? '<td class="select-cell"></td>' : ""}<td class="expand-cell">${tableRowExpandInner(clientExpanded, "client-group-expand", ` data-client="${esc(client)}"`)}</td>${groupCells}<td class="act action-col table-actions-cell"></td></tr>`
      : "";
    const taskRowAttrs = groupByClient ? ` class="client-task-row" data-client="${esc(client)}"${clientExpanded ? "" : " hidden"}` : "";
    if (groupByClient) previousClient = client;
    if (groupByClient && !clientExpanded) return groupHeader;
    const selectTd = selectable
      ? `<td class="select-cell"><input type="checkbox" class="row-select" data-id="${esc(String(rid))}"${selectedSet.has(String(rid)) ? " checked" : ""}></td>`
      : "";
    const tds = cols.map((col) => {
      const val = col.fmt ? col.fmt(r[col.k], r, c) : esc(r[col.k] ?? "—");
      const cls = [col.num ? "num" : "", col.cls || ""].filter(Boolean).join(" ");
      return `<td class="${cls}" data-k="${esc(col.k)}">${val}</td>`;
    }).join("");
    if (state.tab === "conversations") {
      return groupHeader + `<tr${taskRowAttrs}>${selectTd}<td class="expand-cell"></td>${tds}<td class="act action-col table-actions-cell">${tableActionButtons({
        open: { className: "open-chat", attrs: { "data-id": rid }, title: "Abrir conversa", enabled: currentUserCan("conversations", "view") },
        delete: { className: "del-import", attrs: { "data-id": rid }, title: "Excluir conversa", enabled: currentUserCan("conversations", "delete") }
      })}</td></tr>`;
    }
    if (state.tab === "projects") {
      return groupHeader + `<tr${taskRowAttrs}>${selectTd}<td class="expand-cell"></td>${tds}<td class="act action-col table-actions-cell">${tableActionButtons({
        open: { className: "project-board-btn", attrs: { "data-id": rid }, title: "Abrir entrega", enabled: currentUserCan("projects", "view") },
        edit: { className: "edit", attrs: { "data-id": rid }, title: "Editar entrega", enabled: currentUserCan("projects", "edit") },
        delete: { className: "del", attrs: { "data-id": rid }, title: "Excluir entrega", enabled: currentUserCan("projects", "delete") }
      })}</td></tr>`;
    }
    if (state.tab === "activities") {
      const checklist = normalizeChecklist(r.checklist);
      return groupHeader + `<tr${taskRowAttrs}>${selectTd}<td class="expand-cell"></td>${tds}<td class="act action-col table-actions-cell">${tableActionButtons({
        open: checklist.length ? { className: "checklist-open", attrs: { "data-id": rid }, title: "Abrir checklist", enabled: currentUserCan("activities", "view") || currentUserCan("activities", "operate") } : null,
        edit: r.project_id ? { className: "main-task-edit", attrs: { "data-id": rid, "data-project-id": r.project_id }, title: "Editar tarefa", enabled: currentUserCan("activities", "edit") } : null
      })}</td></tr>`;
    }
    if (state.tab === "products") {
      return groupHeader + `<tr${taskRowAttrs}>${selectTd}<td class="expand-cell"></td>${tds}<td class="act action-col table-actions-cell">${tableActionButtons({
        open: { className: "product-activities-btn", attrs: { "data-id": rid }, title: "Abrir estrutura do produto", enabled: currentUserCan("products", "view") },
        edit: { className: "edit", attrs: { "data-id": rid }, title: "Editar produto", enabled: currentUserCan("products", "edit") },
        delete: { className: "del", attrs: { "data-id": rid }, title: "Excluir produto", enabled: currentUserCan("products", "delete") }
      })}</td></tr>`;
    }
    if (state.tab === "companies") {
      return groupHeader + `<tr${taskRowAttrs}>${selectTd}<td class="expand-cell"></td>${tds}<td class="act action-col table-actions-cell">${tableActionButtons({
        open: { className: "company-details-btn", attrs: { "data-id": rid }, title: "Abrir empresa", enabled: currentUserCan("companies", "view") },
        edit: { className: "edit", attrs: { "data-id": rid }, title: "Editar empresa", enabled: currentUserCan("companies", "edit") },
        delete: { className: "del", attrs: { "data-id": rid }, title: "Excluir empresa", enabled: currentUserCan("companies", "delete") }
      })}</td></tr>`;
    }
    return groupHeader + `<tr${taskRowAttrs}>${selectTd}<td class="expand-cell"></td>${tds}<td class="act action-col table-actions-cell">${tableActionButtons({
      edit: { className: "edit", attrs: { "data-id": rid }, title: "Editar registro", enabled: currentUserCan(state.tab, "edit") },
      delete: { className: "del", attrs: { "data-id": rid }, title: "Excluir registro", enabled: currentUserCan(state.tab, "delete") }
    })}</td></tr>`;
  }).join("");

  const pagination = paginated ? `<div class="table-pagination">
    <span>${paginationLength ? groupByClient
      ? `${pageStart + 1}-${Math.min(currentPage * state.pageSize, paginationLength)} de ${paginationLength} clientes · ${allRows.length} tarefas`
      : `${pageStart + 1}-${Math.min(currentPage * state.pageSize, paginationLength)} de ${paginationLength}` : "0 registros"}</span>
    <div><button class="btn" id="page-prev"${currentPage <= 1 ? " disabled" : ""}>‹</button><span>Página ${currentPage} de ${totalPages}</span><button class="btn" id="page-next"${currentPage >= totalPages ? " disabled" : ""}>›</button></div>
  </div>` : "";
  const emptyColspan = cols.length + (selectable ? 1 : 0) + 2;
  const tableBody = body || `<tr><td colspan="${emptyColspan}" class="empty">Nenhum registro. Clique em <b>+</b> para criar.</td></tr>`;
  document.getElementById("main").innerHTML = `<div class="data-table-wrap"><div class="table-scroll"><table class="data-table${selectable && selectedSet.size ? " has-selection" : ""}" data-tab="${esc(state.tab)}"><thead><tr>${head}</tr></thead><tbody>${tableBody}</tbody></table></div>${pagination}</div>`;

  document.querySelectorAll("thead th[data-k]").forEach((th) =>
    th.addEventListener("click", (e) => {
      const k = th.dataset.k;
      if (e.ctrlKey || e.metaKey) { openColumnFilter(th, k); return; }
      if (state.sortK === k) state.sortDir *= -1; else { state.sortK = k; state.sortDir = 1; }
      if (state.pages[state.tab]) state.pages[state.tab] = 1;
      render();
    }));
  document.querySelectorAll("#main .rowbtn.edit").forEach((b) =>
    b.addEventListener("click", () => openForm(state.tab, b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.del").forEach((b) =>
    b.addEventListener("click", () => confirmDelete(state.tab, b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.convert").forEach((b) =>
    b.addEventListener("click", () => convertImportToDeal(b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.del-import").forEach((b) =>
    b.addEventListener("click", () => deleteImport(b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.open-chat").forEach((b) =>
    b.addEventListener("click", () => openConversationPopup(b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.project-board-btn").forEach((b) =>
    b.addEventListener("click", () => openProjectBoard(b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.product-activities-btn").forEach((b) =>
    b.addEventListener("click", () => openProductActivities(b.dataset.id)));
  document.querySelectorAll("#main .rowbtn.company-details-btn").forEach((b) =>
    b.addEventListener("click", () => openCompanyDetails(b.dataset.id)));
  document.querySelectorAll("#main .inline-task-status").forEach((select) => select.addEventListener("change", async () => {
    const previous = cache.activityRecords.find((task) => task.id === select.dataset.id)?.status || "todo";
    try {
      const updated = await updateProjectTask(select.dataset.id, { status: select.value });
      if (!updated) select.value = previous;
      else { toast("Status atualizado."); render(); }
    } catch (err) { select.value = previous; toast("Erro ao atualizar status · " + err.message, true); }
  }));
  document.querySelectorAll(".checklist-open").forEach((button) =>
    button.addEventListener("click", () => openActivityChecklist(button.dataset.id)));
  document.querySelectorAll(".task-comments-open").forEach((button) =>
    button.addEventListener("click", () => openTaskComments(button.dataset.id)));
  document.querySelectorAll(".main-task-edit").forEach((button) =>
    button.addEventListener("click", () => openDeliveryTaskDrawer(button.dataset.projectId, button.dataset.id)));
  document.querySelectorAll(".row-select").forEach((box) =>
    box.addEventListener("change", () => {
      if (box.checked) selectedSet.add(box.dataset.id);
      else selectedSet.delete(box.dataset.id);
      render();
    }));
  document.querySelectorAll(".client-group-toggle,.client-group-expand").forEach((button) => button.addEventListener("click", () => {
    const client = button.dataset.client;
    if (state.expandedActivityClients.has(client)) state.expandedActivityClients.delete(client);
    else state.expandedActivityClients.add(client);
    render();
  }));
  document.querySelector("#main .expand-head .table-expand-all")?.addEventListener("click", () => {
    const expand = clientNames.some((client) => !state.expandedActivityClients.has(client));
    if (expand) clientNames.forEach((client) => state.expandedActivityClients.add(client));
    else state.expandedActivityClients.clear();
    render();
  });
  if (selectable) {
    renderTableActionsHead(document.querySelector("#main .data-table .table-actions-head"), selectedSet.size,
      state.tab === "conversations" ? null : tableBulkEditProvider(`main:${state.tab}`), () => [...selectedSet], () => { selectedSet.clear(); render(); });
  }
  document.getElementById("select-all-rows")?.addEventListener("change", (e) => {
    rows.forEach((r) => {
      const id = String(r[rowKey]);
      if (e.target.checked) selectedSet.add(id);
      else selectedSet.delete(id);
    });
    render();
  });
  document.getElementById("page-prev")?.addEventListener("click", () => { state.pages[state.tab] -= 1; render(); });
  document.getElementById("page-next")?.addEventListener("click", () => { state.pages[state.tab] += 1; render(); });
}

function dealCardHtml(d, c) {
  return `<div class="card" data-id="${esc(d.id)}">
      <div class="t">${esc(d.title)}</div>
      <div class="m">${esc(c.companyById[d.company_id]?.legal_name || c.companyById[d.company_id]?.name || "—")}</div>
      <div class="v">${brl(d.amount)}</div></div>`;
}
function dealColumnHtml(label, items, c, opts = {}) {
  const cards = items.map((d) => dealCardHtml(d, c)).join("");
  const stageAttr = opts.stage ? ` data-stage="${esc(opts.stage)}"` : "";
  const fixedCls = opts.won ? " won" : opts.lost ? " lost" : "";
  return `<div class="col${fixedCls}"${stageAttr}><h4>${esc(label)} <span>${items.length}</span></h4>
      <div class="cards">${cards || '<div class="m" style="padding:6px">—</div>'}</div></div>`;
}
// Matriz de Negócios = quadro por pipeline. Cada conta pode ter até 5
// pipelines (gerenciados em Cadastros); as etapas de cada
// um são configuráveis, mas "Ganho" e "Perdido" são fixos — não entram na
// lista de etapas do pipeline, sempre aparecem como as duas últimas colunas.
// Arrastar um card pra lá muda o status (e "Ganho" cria o projeto sozinho).
function renderKanban(c) {
  const pipelines = c.pipelines || [];
  if (!pipelines.length) {
    document.getElementById("main").innerHTML =
      `<div class="empty">Nenhum pipeline criado ainda.<br>Acesse <b>Cadastros → Pipeline</b> para criar um (até ${MAX_PIPELINES}).</div>`;
    return;
  }
  if (!state.kanbanPipelineId || !pipelines.some((p) => p.id === state.kanbanPipelineId)) {
    state.kanbanPipelineId = pipelines[0].id;
  }
  const activeId = state.kanbanPipelineId;
  const pipeline = c.pipelineById[activeId];
  const tabs = pipelines.map((p) =>
    `<button class="pipeline-tab${p.id === activeId ? " active" : ""}" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("");
  const rows = rowsFor("deals", c).filter((d) => d.pipeline_id === activeId);
  const stageCols = (pipeline?.stages || []).map((st) =>
    dealColumnHtml(st, rows.filter((d) => d.stage === st && d.status === "open"), c, { stage: st })).join("");
  const won = dealColumnHtml("Ganho", rows.filter((d) => d.status === "won"), c, { won: true });
  const lost = dealColumnHtml("Perdido", rows.filter((d) => d.status === "lost"), c, { lost: true });
  document.getElementById("main").innerHTML = `<div class="pipeline-tabs">${tabs}</div><div class="kanban">${stageCols}${won}${lost}</div>`;

  document.querySelectorAll(".pipeline-tab").forEach((btn) =>
    btn.addEventListener("click", () => { state.kanbanPipelineId = btn.dataset.id; render(); }));
  document.querySelectorAll(".card").forEach((el) =>
    el.addEventListener("click", () => openForm("deals", el.dataset.id)));
  wireKanbanDnD(activeId);
}
function renderActivityKanban(c) {
  const tasks = rowsFor("activities", c);
  const columnsHtml = TASK_STATUS.map((status) => {
    const items = tasks.filter((task) => (task.status || "todo") === status.id);
    const cards = items.map((task) => {
      const owner = userDisplayName(task.owner_id, c, "Sem responsável");
      const blocked = taskIsBlocked(task);
      return `<div class="card${blocked ? " blocked" : ""}" data-id="${esc(task.id)}">
        <div class="t">${esc(activityDisplayName(task))}</div>
        <div class="m">${esc(task.client_name)} · ${esc(task.project_name)}</div>
        <div class="m">${esc(owner)}${taskPlannedEnd(task) ? ` · ${esc(dt(taskPlannedEnd(task)))}` : ""}</div>
        ${blocked ? '<div class="task-dependency blocked">Aguardando tarefa anterior</div>' : ""}
      </div>`;
    }).join("");
    return `<div class="col" data-status="${status.id}"><h4>${status.label} <span>${items.length}</span></h4>
      <div class="cards">${cards || '<div class="m" style="padding:6px">—</div>'}</div></div>`;
  }).join("");
  document.getElementById("main").innerHTML = `<div class="kanban">${columnsHtml}</div>`;
  document.querySelectorAll("#main .card").forEach((card) => {
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll("#main .col").forEach((column) => {
    column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const taskId = event.dataTransfer.getData("text/plain");
      if (!taskId) return;
      try {
        await updateProjectTask(taskId, { status: column.dataset.status });
        render();
      } catch (err) { toast("Erro ao mover tarefa · " + err.message, true); }
    });
  });
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function deliveryGanttProgress(projectId) {
  const allTasks = operationalProjectTasks(projectId);
  const tasks = allTasks.filter((task) => task.status !== "canceled" && !allTasks.some((candidate) => candidate.parent_activity_id === task.id));
  const objectives = loadDeliveryObjectives().filter((objective) => objective.project_id === projectId && objective.status !== "canceled");
  const goals = loadDeliveryGoals().filter((goal) => goal.project_id === projectId && goal.status !== "canceled");
  const metric = (rows) => ({
    total: rows.length,
    done: rows.filter((row) => row.status === "done").length,
    percent: rows.length ? Math.round(rows.filter((row) => row.status === "done").length / rows.length * 100) : null
  });
  const taskMetric = metric(tasks);
  const objectiveMetric = metric(objectives);
  const goalMetric = metric(goals);
  const available = [taskMetric.percent, objectiveMetric.percent, goalMetric.percent].filter((value) => value != null);
  const percent = available.length ? Math.round(available.reduce((sum, value) => sum + value, 0) / available.length) : 0;
  return { percent, tasks: taskMetric, objectives: objectiveMetric, goals: goalMetric };
}

function deliveryGanttProgressLabel(progress) {
  const parts = [
    progress.tasks.total ? `Tarefas ${progress.tasks.done}/${progress.tasks.total} (${progress.tasks.percent}%)` : "",
    progress.objectives.total ? `Objetivos ${progress.objectives.done}/${progress.objectives.total} (${progress.objectives.percent}%)` : "",
    progress.goals.total ? `Metas ${progress.goals.done}/${progress.goals.total} (${progress.goals.percent}%)` : ""
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Sem tarefas, objetivos ou metas";
}

function timelineItem(tab, row, c) {
  if (tab === "deals") return {
    id: row.id, title: row.title, detail: c.companyById[row.company_id]?.legal_name || c.companyById[row.company_id]?.name || "Sem empresa",
    start: row.expected_close_date, end: row.expected_close_date, status: row.status
  };
  if (tab === "projects") {
    const progress = deliveryGanttProgress(row.id);
    return {
      id: row.id, title: c.productById[row.product_id]?.name || row.name || "Entrega",
      detail: c.companyById[row.company_id]?.legal_name || "Sem cliente", start: row.start_date, end: row.end_date || row.start_date, status: row.status,
      progress: { ...progress, label: deliveryGanttProgressLabel(progress) }
    };
  }
  if (tab === "activities") return {
    id: row.id, title: activityDisplayName(row), detail: `${row.client_name || "Sem cliente"} · ${row.product_name || "Sem produto"}`,
    start: taskPlannedStart(row) || taskPlannedEnd(row), end: taskPlannedEnd(row) || taskPlannedStart(row), status: row.status
  };
  return null;
}

const GANTT_DAY_MS = 86400000;

function ganttScale(items) {
  const starts = items.map((item) => dateOnly(item.start).getTime());
  const ends = items.map((item) => (dateOnly(item.end) || dateOnly(item.start)).getTime());
  const dataStart = new Date(Math.min(...starts));
  const dataEnd = new Date(Math.max(...ends));
  const dataDays = Math.max(1, Math.round((dataEnd - dataStart) / GANTT_DAY_MS) + 1);
  let start;
  let end;
  let cellWidth;
  const ticks = [];

  if (dataDays <= 45) {
    cellWidth = 42;
    start = new Date(dataStart);
    start.setDate(start.getDate() - 1);
    end = new Date(dataEnd);
    end.setDate(end.getDate() + 2);
    for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
      ticks.push(cursor.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }));
    }
  } else if (dataDays <= 180) {
    cellWidth = 112;
    start = new Date(dataStart);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end = new Date(dataEnd);
    end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7)));
    for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 7)) {
      ticks.push(`SEM ${cursor.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`);
    }
  } else {
    cellWidth = 128;
    start = new Date(dataStart.getFullYear(), dataStart.getMonth(), 1, 12);
    end = new Date(dataEnd.getFullYear(), dataEnd.getMonth() + 1, 1, 12);
    for (let cursor = new Date(start); cursor < end; cursor.setMonth(cursor.getMonth() + 1)) {
      ticks.push(cursor.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(".", ""));
    }
  }

  const width = Math.max(640, ticks.length * cellWidth);
  return {
    start,
    end,
    ticks,
    width,
    span: Math.max(GANTT_DAY_MS, end.getTime() - start.getTime())
  };
}

function ganttItemState(item) {
  if (["done", "won", "closed"].includes(item.status)) return "done";
  const end = dateOnly(item.end || item.start);
  if (end && end < dateOnly(isoDay(new Date()))) return "overdue";
  if (["active", "in_progress", "doing", "negotiation"].includes(item.status)) return "active";
  return "planned";
}

function ganttTimelineMarkup(items, label = "Registro", itemClass = "", footer = "") {
  const scale = ganttScale(items);
  const showsProgress = items.some((item) => item.progress);
  const grid = `<div class="gantt-grid" style="grid-template-columns:repeat(${scale.ticks.length},1fr)">${scale.ticks.map(() => "<span></span>").join("")}</div>`;
  const axis = `<div class="gantt-axis" style="width:${scale.width}px;grid-template-columns:repeat(${scale.ticks.length},1fr)">${scale.ticks.map((tick) => `<span>${esc(tick)}</span>`).join("")}</div>`;
  const today = dateOnly(isoDay(new Date()));
  const todayLeft = today >= scale.start && today < scale.end
    ? (today.getTime() - scale.start.getTime()) / scale.span * scale.width
    : null;
  const todayLine = todayLeft == null ? "" : `<span class="gantt-today" style="left:${todayLeft}px" title="Hoje"></span>`;
  const rows = [...items].sort((a, b) => dateOnly(a.start) - dateOnly(b.start)).map((item) => {
    const start = dateOnly(item.start);
    const end = dateOnly(item.end) || start;
    const isMilestone = isoDay(start) === isoDay(end);
    const left = Math.max(0, (start.getTime() - scale.start.getTime()) / scale.span * scale.width);
    const endExclusive = Math.min(scale.end.getTime(), end.getTime() + GANTT_DAY_MS);
    const width = Math.max(18, (endExclusive - start.getTime()) / scale.span * scale.width);
    const period = isMilestone ? dt(item.start) : `${dt(item.start)} a ${dt(item.end)}`;
    const stateClass = ganttItemState(item);
    const title = esc(`${item.title} · ${period}`);
    const progressPercent = Math.max(0, Math.min(100, Number(item.progress?.percent || 0)));
    const progressTitle = item.progress ? esc(`Andamento ${progressPercent}% · ${item.progress.label}`) : "";
    const control = item.progress
      ? `<button class="gantt-bar gantt-contract-bar ${stateClass} ${itemClass}" data-id="${esc(item.id)}" style="left:${left}px;width:${width}px" title="Contrato · ${title}">${esc(item.title)}</button>
        <button class="gantt-progress-rail ${itemClass}${progressPercent >= 100 ? " complete" : ""}" data-id="${esc(item.id)}" style="left:${left}px;width:${width}px" title="${progressTitle}"><span style="width:${progressPercent}%"></span><b>${progressPercent}%</b></button>`
      : isMilestone
        ? `<button class="gantt-milestone ${stateClass} ${itemClass}" data-id="${esc(item.id)}" style="left:${left}px" title="${title}"><span></span></button>`
        : `<button class="gantt-bar ${stateClass} ${itemClass}" data-id="${esc(item.id)}" style="left:${left}px;width:${width}px" title="${title}">${esc(item.title)}</button>`;
    return `<div class="gantt-row${item.progress ? " has-progress" : ""}"><div class="gantt-label"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small><span>${esc(period)}</span>${item.progress ? `<small class="gantt-progress-summary">${esc(`${progressPercent}% · ${item.progress.label}`)}</small>` : ""}</div>
      <div class="gantt-track${item.progress ? " has-progress" : ""}" style="width:${scale.width}px">${grid}${todayLine}${control}</div></div>`;
  }).join("");
  const legend = showsProgress
    ? '<span><i class="planned"></i>Contrato</span><span><i class="active"></i>Andamento</span><span><i class="done"></i>Concluído</span><span><i class="overdue"></i>Atrasado</span><span class="gantt-legend-note">Linha vermelha: hoje</span>'
    : '<span><i class="planned"></i>Planejado</span><span><i class="active"></i>Em andamento</span><span><i class="done"></i>Atendido</span><span><i class="overdue"></i>Atrasado</span><span class="gantt-legend-note">◆ data única</span>';
  return `<div class="gantt-shell"><div class="gantt-view"><div class="gantt-board">
    <div class="gantt-head"><div>${esc(label)}</div><div class="gantt-axis-wrap">${axis}</div></div>${rows}
    <div class="gantt-legend">${legend}</div>
  </div></div><div class="gantt-bottom-scroll" aria-label="Rolagem horizontal do Gantt"><div style="width:${scale.width + 262}px"></div></div>${footer}</div>`;
}

function wireGanttScrolling(root = document) {
  const view = root.querySelector(".gantt-view");
  const bottom = root.querySelector(".gantt-bottom-scroll");
  if (!view || !bottom) return;
  let syncing = false;
  const sync = (source, target) => {
    if (syncing) return;
    syncing = true;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => { syncing = false; });
  };
  view.addEventListener("scroll", () => sync(view, bottom), { passive: true });
  bottom.addEventListener("scroll", () => sync(bottom, view), { passive: true });
  bottom.scrollLeft = view.scrollLeft;
}

function openTimelineRecord(tab, id) {
  if (tab === "deals") openForm("deals", id);
  else if (tab === "projects") openProjectBoard(id);
  else if (tab === "activities") openActivityChecklist(id);
}

function renderCalendar(c) {
  const cursor = state.calendarCursor ? dateOnly(`${state.calendarCursor}-01`) : new Date();
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
  state.calendarCursor = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const items = rowsFor(state.tab, c).map((row) => timelineItem(state.tab, row, c)).filter((item) => item && dateOnly(item.start));
  const byDay = new Map();
  items.forEach((item) => {
    const key = String(item.start).slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  });
  const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
    .map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
  const today = isoDay(new Date());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = isoDay(date);
    const dayItems = byDay.get(key) || [];
    return `<div class="calendar-day${date.getMonth() !== monthStart.getMonth() ? " outside" : ""}${key === today ? " today" : ""}">
      <span class="calendar-date">${date.getDate()}</span>
      ${dayItems.map((item) => `<button class="calendar-item" data-id="${esc(item.id)}" title="${esc(item.detail)}">${esc(item.title)}</button>`).join("")}
    </div>`;
  }).join("");
  document.getElementById("main").innerHTML = `<div class="calendar-view">
    <div class="calendar-toolbar"><strong>${monthStart.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong>
      <div class="calendar-nav"><button class="btn" id="calendar-prev" title="Mês anterior">‹</button><button class="btn" id="calendar-today">Hoje</button><button class="btn" id="calendar-next" title="Próximo mês">›</button></div>
    </div><div class="calendar-grid">${weekdays}${days}</div></div>`;
  const move = (months) => {
    monthStart.setMonth(monthStart.getMonth() + months);
    state.calendarCursor = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
    render();
  };
  document.getElementById("calendar-prev").addEventListener("click", () => move(-1));
  document.getElementById("calendar-next").addEventListener("click", () => move(1));
  document.getElementById("calendar-today").addEventListener("click", () => { state.calendarCursor = null; render(); });
  document.querySelectorAll(".calendar-item").forEach((button) =>
    button.addEventListener("click", () => openTimelineRecord(state.tab, button.dataset.id)));
}

function renderGantt(c) {
  const allItems = rowsFor(state.tab, c).map((row) => timelineItem(state.tab, row, c)).filter((item) => item && dateOnly(item.start));
  if (!allItems.length) {
    document.getElementById("main").innerHTML = '<div class="empty">Nenhum registro com data para exibir no Gantt.</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(allItems.length / state.pageSize));
  state.pages[state.tab] = Math.min(Math.max(1, state.pages[state.tab] || 1), totalPages);
  const currentPage = state.pages[state.tab];
  const start = (currentPage - 1) * state.pageSize;
  const items = allItems.slice(start, start + state.pageSize);
  const pagination = `<div class="table-pagination gantt-pagination"><span>${start + 1}-${Math.min(start + state.pageSize, allItems.length)} de ${allItems.length}</span><div><button class="btn" id="gantt-page-prev"${currentPage <= 1 ? " disabled" : ""}>‹</button><span>Página ${currentPage} de ${totalPages}</span><button class="btn" id="gantt-page-next"${currentPage >= totalPages ? " disabled" : ""}>›</button></div></div>`;
  const main = document.getElementById("main");
  main.innerHTML = ganttTimelineMarkup(items, state.tab === "activities" ? "Tarefa" : "Registro", "", pagination);
  wireGanttScrolling(main);
  document.querySelectorAll(".gantt-bar,.gantt-milestone,.gantt-progress-rail").forEach((button) =>
    button.addEventListener("click", () => openTimelineRecord(state.tab, button.dataset.id)));
  document.getElementById("gantt-page-prev")?.addEventListener("click", () => { state.pages[state.tab] -= 1; render(); });
  document.getElementById("gantt-page-next")?.addEventListener("click", () => { state.pages[state.tab] += 1; render(); });
}

function wireKanbanDnD(pipelineId) {
  document.querySelectorAll(".card").forEach((card) => {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const isWon = col.classList.contains("won");
      const isLost = col.classList.contains("lost");
      await moveDealCard(id, { pipelineId, stage: col.dataset.stage || null, isWon, isLost });
    });
  });
}
async function moveDealCard(id, { pipelineId, stage, isWon, isLost }) {
  const deal = cache.deals.find((d) => d.id === id);
  if (!deal) return;
  const body = isWon ? { status: "won" } : isLost ? { status: "lost" } : { stage, status: "open" };
  try {
    await updateRow("deals", id, body);
    if (isWon) await createProjectFromDeal({ ...deal, ...body });
    await init();
  } catch (err) {
    toast("Erro ao mover negócio · " + err.message, true);
  }
}

function renderDashboard(c) {
  const deals = c.deals || [];
  const openDeals = deals.filter((d) => d.status === "open");
  const wonDeals = deals.filter((d) => d.status === "won");
  const totalOpen = openDeals.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const metrics = [
    ["Pessoas", c.contacts.length],
    ["Empresas", c.companies.length],
    ["Negócios abertos", openDeals.length],
    ["Pipeline", brl(totalOpen)],
    ["Produtos", c.products.length],
    ["Entregas", c.projects.length],
    ["Negócios ganhos", wonDeals.length],
    ["Receita ganha", brl(wonDeals.reduce((sum, d) => sum + Number(d.amount || 0), 0))]
  ].map(([k, v]) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");
  document.getElementById("main").innerHTML = `<div class="dashboard">${metrics}</div>`;
}

function refreshActivityCache() {
  if (!cache) return;
  const allTasks = loadProjectTasks();
  const tasks = operationalProjectTasks();
  const objectives = loadDeliveryObjectives();
  cache.deliveryObjectiveById = Object.fromEntries(objectives.map((objective) => [objective.id, objective]));
  cache.activityById = Object.fromEntries(allTasks.map((task) => [task.id, task]));
  cache.activities = tasks.map((task) => {
    const project = cache.projectById[task.project_id];
    const company = project ? cache.companyById[project.company_id] : null;
    const objective = cache.deliveryObjectiveById[task.objective_id];
    return {
      ...task,
      project_name: project?.name || "Entrega não encontrada",
      product_name: project ? cache.productById[project.product_id]?.name || "Sem produto" : "Sem produto",
      company_id: project?.company_id || null,
      client_name: project?.client_name || company?.legal_name || company?.trade_name || "Sem cliente",
      activity_origin: task.source_template_id ? "product" : "daily",
      objective_name: objective?.name || "—",
      deadline_state: taskDeadlineState(task),
      comment_count: taskCommentCount(task)
    };
  });
}

function renderHome(c) {
  refreshActivityCache();
  const today = new Date().toISOString().slice(0, 10);
  const activities = c.activities || [];
  const pending = activities.filter((task) => !["done", "canceled"].includes(task.status));
  const overdue = pending.filter((task) => taskPlannedEnd(task) && taskPlannedEnd(task) < today);
  const openDeals = (c.deals || []).filter((deal) => deal.status === "open");
  const activeProjects = (c.projects || []).filter((project) => project.status === "active");
  const revenue = (c.deals || []).filter((deal) => deal.status === "won").reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
  const metrics = [
    ["contacts", "Pessoas", c.contacts.length],
    ["companies", "Empresas", c.companies.length],
    ["deals", "Negócios abertos", openDeals.length],
    ["projects", "Entregas ativas", activeProjects.length],
    ["activities", "Tarefas pendentes", pending.length],
    ["deals", "Receita ganha", brl(revenue)]
  ].filter(([moduleId]) => currentUserCan(moduleId, "view"))
    .map(([, label, value]) => `<div class="metric"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div></div>`).join("");

  const upcoming = [...pending]
    .sort((a, b) => (taskPlannedEnd(a) || "9999-12-31").localeCompare(taskPlannedEnd(b) || "9999-12-31"))
    .slice(0, 8);
  const activityRows = upcoming.map((task) => `<tr>
    <td>${esc(activityDisplayName(task))}</td>
    <td>${esc(task.client_name)}</td>
    <td>${esc(task.project_name)}</td>
    <td>${esc(taskPlannedEnd(task) ? dt(taskPlannedEnd(task)) : "—")}</td>
    <td>${badge(taskStatusTone(task.status), taskStatusLabel(task.status))}</td>
  </tr>`).join("");
  const projectStatuses = PROJECT_STATUSES.map((status) => {
    const count = (c.projects || []).filter((project) => project.status === status).length;
    return `<div class="home-status-row"><span>${esc(PROJECT_STATUS_LABEL[status])}</span><strong>${count}</strong></div>`;
  }).join("");

  const tasksPanel = currentUserCan("activities", "view") ? `<section class="home-panel">
        <h3>Próximas tarefas</h3>
        <div class="task-table-wrap"><table><thead><tr><th>Tarefa</th><th>Cliente</th><th>Entrega</th><th>Término previsto</th><th>Status</th></tr></thead>
        <tbody>${activityRows || '<tr><td colspan="5" class="empty">Nenhuma tarefa pendente.</td></tr>'}</tbody></table></div>
      </section>` : "";
  const projectsPanel = currentUserCan("projects", "view") ? `<section class="home-panel">
        <h3>Entregas por status</h3>
        <div class="home-status-list">${projectStatuses}${currentUserCan("activities", "view") ? `<div class="home-status-row"><span>Tarefas atrasadas</span><strong class="neg">${overdue.length}</strong></div>` : ""}</div>
      </section>` : "";
  document.getElementById("main").innerHTML = `<div class="home">
    <div class="home-metrics">${metrics}</div>
    <div class="home-grid">
      ${tasksPanel}${projectsPanel}
    </div>
  </div>`;
  document.querySelectorAll(".home-project-btn").forEach((button) =>
    button.addEventListener("click", () => openProjectBoard(button.dataset.projectId)));
}

function renderMatrix(c) {
  if (state.tab === "deals") { renderKanban(c); return; }
  const rows = rowsFor(state.tab, c);
  const cols = columns(state.tab, c).slice(0, 4);
  const cards = rows.map((r) => {
    const lines = cols.map((col) => {
      const val = col.fmt ? col.fmt(r[col.k], r, c) : esc(r[col.k] ?? "—");
      return `<div class="line"><span class="muted">${esc(col.h)}</span><strong>${val}</strong></div>`;
    }).join("");
    return `<div class="matrix-card"><h4>${esc(r.name || r.legal_name || r.title || r.trade_name || "Registro sem nome")}</h4>${lines}</div>`;
  }).join("");
  document.getElementById("main").innerHTML = cards ? `<div class="matrix">${cards}</div>` : `<div class="empty">Nenhum registro.</div>`;
}

let productActivityState = { productId: null, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
let productActivityChecklistDraft = [];
let productActivityRelatedIds = [];
let productActivityDraftGroupId = null;
let productActivityParentGroupId = null;
let productActivitySavePending = false;
let productObjectiveSavePending = false;
let productGoalSavePending = false;
const registrationExpandedTaskGroups = new Set();
const registrationMindMapCollapsedBranches = new Set();
const REGISTRATION_MIND_MAP_LEVELS = [
  { key: "category", empty: "Sem categoria" },
  { key: "channel", empty: "Sem canal" },
  { key: "module", empty: "Sem módulo" },
  { key: "submodule", empty: "Sem submódulo" }
];
let registrationMindMapFullscreen = false;
let registrationMindMapHandMode = false;
let registrationMindMapZoom = 1;
let registrationMindMapPointerPressed = false;
let registrationMindMapPointerWired = false;
const REGISTRATION_MIND_MAP_ZOOM_LIMITS = [0.3, 2];
let registrationMindMapOrientation = (() => {
  try { return localStorage.getItem("registrationMindMapOrientation") === "vertical" ? "vertical" : "horizontal"; } catch { return "horizontal"; }
})();

function productTemplateSubtasks(templateId, templates = loadProductActivities()) {
  return templates.filter((item) => item.parent_template_id === templateId);
}

function productTemplateParent(template, templates = loadProductActivities()) {
  return template?.parent_template_id ? templates.find((item) => item.id === template.parent_template_id) || null : null;
}

function productTemplateDescendantIds(templateId, templates = loadProductActivities(), ids = new Set()) {
  productTemplateSubtasks(templateId, templates).forEach((item) => {
    if (ids.has(item.id)) return;
    ids.add(item.id);
    productTemplateDescendantIds(item.id, templates, ids);
  });
  return ids;
}

function productActivityIdentity(item) {
  return [item?.group, item?.subgroup, item?.sector, item?.subsector, item?.module, item?.submodule, item?.category, item?.channel, item?.type, item?.activity, item?.recurrence || "once"]
    .map((value) => String(value || "").trim().toLocaleLowerCase("pt-BR"))
    .join("|");
}

function renderProductActivityChecklistEditor() {
  const root = document.getElementById("pa-checklist");
  if (!root) return;
  root.innerHTML = productActivityChecklistDraft.map((item) => `<div class="checklist-edit-row" data-id="${esc(item.id)}">
    <input type="text" value="${esc(item.text)}" placeholder="Item do checklist">
    <button class="rowbtn checklist-draft-remove" type="button" title="Remover item">✕</button>
  </div>`).join("") || '<span class="muted">Nenhum item cadastrado.</span>';
  root.querySelectorAll(".checklist-edit-row").forEach((row) => {
    row.querySelector("input").addEventListener("input", (event) => {
      const item = productActivityChecklistDraft.find((candidate) => candidate.id === row.dataset.id);
      if (item) item.text = event.target.value;
    });
    row.querySelector(".checklist-draft-remove").addEventListener("click", () => {
      productActivityChecklistDraft = productActivityChecklistDraft.filter((item) => item.id !== row.dataset.id);
      renderProductActivityChecklistEditor();
    });
  });
}

function openProductActivities(productId, opts = {}) {
  if (!requireCurrentUserPermission("products", "view", "Produtos")) return;
  const product = cache.productById[productId];
  if (!product) return;
  productActivityState = { productId, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Configuração do produto">
    <button class="modal-header-tab active" data-product-tab="activities" role="tab">Tarefas</button>
    <button class="modal-header-tab" data-product-tab="objectives" role="tab">Objetivos</button>
    <button class="modal-header-tab" data-product-tab="goals" role="tab">Metas</button>
  </div>`;
  const returnSection = opts.returnToRegistrations || null;
  shell(`Produto · ${product.name}`, `<div id="product-activities-root"></div>`, {
    cls: "full",
    headerCenter,
    onClose: returnSection ? () => openRegistrationsModal(returnSection) : null
  });
  document.querySelectorAll("[data-product-tab]").forEach((button) => button.addEventListener("click", () => {
    closeProductActivityDrawer();
    productActivityState.tab = button.dataset.productTab;
    document.querySelectorAll("[data-product-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderProductWorkspace();
  }));
  renderProductWorkspace();
}

function renderProductWorkspace() {
  if (productActivityState.tab === "objectives") renderProductObjectives();
  else if (productActivityState.tab === "goals") renderProductGoals();
  else renderProductActivities();
  wireSecondaryTableSelection(
    document.querySelector("#product-activities-root table"),
    `product:${productActivityState.productId}:${productActivityState.tab}`
  );
}

function renderProductActivities() {
  const root = document.getElementById("product-activities-root");
  if (!root) return;
  const productTemplates = loadProductActivities().filter((item) => item.product_id === productActivityState.productId);
  const compareTemplates = (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.created_at || "").localeCompare(String(b.created_at || ""));
  const productTemplateIds = new Set(productTemplates.map((item) => item.id));
  const templates = productTemplates.filter((item) => !item.parent_template_id || !productTemplateIds.has(item.parent_template_id))
    .sort(compareTemplates)
    .flatMap((item) => [item, ...productTemplateSubtasks(item.id, productTemplates).sort(compareTemplates)]);
  const rows = templates.map((item) => `<tr class="pa-row${item.parent_template_id ? " pa-subtask-row" : ""}" data-id="${esc(item.id)}" draggable="true">
    <td class="pa-drag" title="Arraste para mudar a ordem">⠿</td>
    <td>${esc(item.group || "—")}</td><td>${esc(item.subgroup || "—")}</td><td>${esc(item.sector || "—")}</td><td>${esc(item.subsector || "—")}</td><td>${esc(item.module || "—")}</td><td>${esc(item.submodule || "—")}</td>
    <td>${esc(item.category || "—")}</td><td>${esc(item.channel || "—")}</td><td>${esc(item.type || "—")}</td><td>${esc(RECURRENCE_LABEL[item.recurrence] || "Única")}</td><td>${item.consider_business_days ? "Sim" : "Não"}</td><td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td>
    <td>${item.parent_template_id ? '<span class="task-subtask-branch">↳</span> ' : ""}${esc(activityDisplayName(item))}</td><td>${esc(item.information || "—")}</td>
    <td>${productTemplateSubtasks(item.id, productTemplates).length ? '<span class="muted">Nas subtarefas</span>' : `${normalizeChecklist(item.checklist).length} item(ns)`}</td>
    <td>${esc(loadProductObjectives().find((objective) => objective.id === item.objective_template_id)?.name || "—")}</td>
    <td>${priorityBadge(item.priority)}</td>
    <td>${esc(responsibilityNames(item.default_assignee_ids, item.default_owner_id, item.default_assignee_job_titles, item.assign_to_client))}</td>
    <td>${esc(dependencyNames(item.dependency_template_ids, item.depends_on_template_id, templates))}</td>
    <td>${taskReferencesHtml(item)}</td>
    <td class="act table-actions-cell">${tableActionButtons({
      edit: { className: "pa-edit", attrs: { "data-id": item.id }, title: item.parent_template_id ? "Editar subtarefa" : "Editar tarefa" },
      clone: { className: "pa-clone", attrs: { "data-id": item.id }, title: item.parent_template_id ? "Clonar subtarefa" : "Clonar tarefa" },
      delete: { className: "pa-delete", attrs: { "data-id": item.id }, title: "Desvincular do produto" }
    })}</td></tr>`).join("");
  root.innerHTML = `<div class="modal-toolbar"><span class="muted">${templates.length} tarefa(s) vinculada(s)</span><div class="modal-toolbar-actions"><button class="btn primary" id="pa-ready">Vincular tarefas</button></div></div>
    <div class="product-activity-list"><table><thead><tr>
      <th class="noclick"></th><th>Grupo</th><th>Subgrupo</th><th>Setor</th><th>Subsetor</th><th>Módulo</th><th>Submódulo</th><th>Categoria</th><th>Canal</th><th>Tipo</th><th>Recorrência</th><th>Dias úteis</th><th>Prazo sugerido</th><th>Tarefa</th><th>Informação</th><th>Checklist</th><th>Objetivo</th><th>Prioridade</th><th>Responsáveis padrão</th><th>Depende de</th><th>Referências</th>${tableActionsHead()}
    </tr></thead><tbody id="pa-tbody">${rows || '<tr><td colspan="22" class="empty">Nenhuma tarefa cadastrada para este produto.</td></tr>'}</tbody></table></div>`;
  document.getElementById("pa-ready").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openReadyActivityPicker();
  });
  document.querySelectorAll(".pa-edit").forEach((button) => button.addEventListener("click", () => openProductActivityDrawer(button.dataset.id)));
  document.querySelectorAll(".pa-clone").forEach((button) => button.addEventListener("click", () => cloneProductActivity(button.dataset.id)));
  document.querySelectorAll(".pa-delete").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm("Desvincular esta tarefa do produto? Entregas que já receberam a tarefa manterão a cópia existente.")) return;
    try {
       const allTemplates = loadProductActivities();
       const currentTemplate = allTemplates.find((item) => item.id === button.dataset.id);
       const removedIds = new Set([button.dataset.id, ...productTemplateDescendantIds(button.dataset.id, allTemplates)]);
       const parentTemplate = productTemplateParent(currentTemplate, allTemplates);
       const siblings = parentTemplate ? productTemplateSubtasks(parentTemplate.id, allTemplates).filter((item) => item.id !== button.dataset.id) : [];
       if (parentTemplate && !siblings.length) {
         const changes = { checklist: normalizeChecklist(currentTemplate.checklist), updated_at: new Date().toISOString() };
         if (isLive()) await updateRow("productActivities", parentTemplate.id, changes);
         Object.assign(parentTemplate, changes);
       }
       if (isLive()) {
         const dependents = cache.productActivities.filter((item) => normalizeIdList(item.dependency_template_ids, item.depends_on_template_id).some((id) => removedIds.has(id)));
         for (const item of dependents) {
           item.dependency_template_ids = normalizeIdList(item.dependency_template_ids, item.depends_on_template_id).filter((id) => !removedIds.has(id));
           item.depends_on_template_id = item.dependency_template_ids[0] || null;
           await updateRow("productActivities", item.id, { dependency_template_ids: item.dependency_template_ids, depends_on_template_id: item.depends_on_template_id });
         }
         await deleteRow("productActivities", button.dataset.id);
         cache.productActivities = cache.productActivities.filter((item) => !removedIds.has(item.id));
       } else {
         const remaining = allTemplates.filter((item) => !removedIds.has(item.id));
         remaining.forEach((item) => {
           item.dependency_template_ids = normalizeIdList(item.dependency_template_ids, item.depends_on_template_id).filter((id) => !removedIds.has(id));
           item.depends_on_template_id = item.dependency_template_ids[0] || null;
         });
         saveProductActivities(remaining);
      }
      const tasks = loadProjectTasks();
      tasks.forEach((task) => {
        if (removedIds.has(task.source_template_id)) task.source_template_id = null;
      });
      if (isLive()) cache.activityRecords = tasks;
      else saveProjectTasks(tasks);
      refreshActivityCache();
      renderProductActivities();
      toast("Tarefa desvinculada do produto.");
    } catch (err) { toast("Erro ao excluir tarefa · " + err.message, true); }
  }));
  wireProductActivityDragAndDrop();
}

function renderProductObjectives() {
  const root = document.getElementById("product-activities-root");
  if (!root) return;
  const objectives = loadProductObjectives()
    .filter((item) => item.product_id === productActivityState.productId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const activities = loadProductActivities().filter((item) => item.product_id === productActivityState.productId);
  const rows = objectives.map((item) => {
    const owners = assigneeNameList(item.default_assignee_ids, item.default_owner_id, item.assign_to_client);
    const activityCount = activities.filter((activity) => activity.objective_template_id === item.id).length;
    const dependencyObjectives = normalizeIdList(item.dependency_objective_template_ids)
      .map((id) => objectives.find((objective) => objective.id === id)?.name).filter(Boolean);
    const dependencyActivities = normalizeIdList(item.dependency_activity_template_ids)
      .map((id) => activities.find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName);
    const dependencies = [...dependencyObjectives, ...dependencyActivities];
    return `<tr>
      <td><strong>${esc(item.name)}</strong></td>
      <td>${esc(item.completion_criteria || "—")}</td>
      <td>${esc(item.comments || "—")}</td>
      <td class="compact-multi-cell">${stackedCell(dependencies)}</td>
      <td class="compact-multi-cell">${stackedCell(owners)}</td>
      <td>${item.target_days == null || item.target_days === "" ? "—" : `${esc(item.target_days)} dia(s)`}</td>
      <td>${activityCount}</td>
      <td class="act table-actions-cell">${tableActionButtons({
        edit: { className: "po-edit", attrs: { "data-id": item.id }, title: "Editar objetivo" },
        clone: { className: "po-clone", attrs: { "data-id": item.id }, title: "Clonar objetivo" },
        delete: { className: "po-delete", attrs: { "data-id": item.id }, title: "Excluir objetivo" }
      })}</td>
    </tr>`;
  }).join("");
  root.innerHTML = `<div class="modal-toolbar"><span class="muted">${objectives.length} objetivo(s) do produto</span><button class="btn primary" id="po-new">+ Objetivo</button></div>
    <div class="product-activity-list"><table><thead><tr>
      <th>Objetivo</th><th>Critério de conclusão</th><th>Comentários</th><th class="compact-multi-cell">Depende de</th><th class="compact-multi-cell">Responsável padrão</th><th>Prazo sugerido</th><th>Tarefas</th>${tableActionsHead()}
    </tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">Nenhum objetivo cadastrado para este produto.</td></tr>'}</tbody></table></div>`;
  document.getElementById("po-new").addEventListener("click", () => openProductObjectiveDrawer());
  document.querySelectorAll(".po-edit").forEach((button) => button.addEventListener("click", () => openProductObjectiveDrawer(button.dataset.id)));
  document.querySelectorAll(".po-clone").forEach((button) => button.addEventListener("click", () => openProductObjectiveDrawer(null, button.dataset.id)));
  document.querySelectorAll(".po-delete").forEach((button) => button.addEventListener("click", () => deleteProductObjective(button.dataset.id)));
}

function openProductObjectiveDrawer(editId = null, cloneSourceId = null) {
  if (!requireCurrentUserPermission("objectiveTemplates", cloneSourceId ? "clone" : editId ? "edit" : "create", "Objetivos")) return;
  closeProductActivityDrawer();
  productActivityState.objectiveEditId = editId;
  const objectives = loadProductObjectives().filter((item) => item.product_id === productActivityState.productId);
  const cloneSource = objectives.find((item) => item.id === cloneSourceId);
  const current = objectives.find((item) => item.id === editId) || cloneSource || {};
  const selectedAssignees = assigneePickerSelection(current.default_assignee_ids, current.default_owner_id, current.assign_to_client);
  const objectiveDependencyOptions = objectives
    .filter((item) => item.id !== editId)
    .map((item) => ({ value: item.id, label: item.name }));
  const activityDependencyOptions = loadProductActivities()
    .filter((item) => item.product_id === productActivityState.productId)
    .map((item) => ({ value: item.id, label: activityDisplayName(item) }));
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer">
    <h3>${editId ? "Editar objetivo" : cloneSource ? "Clonar objetivo" : "Novo objetivo"}<button class="modal-close-x" id="po-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form">
      <div class="field"><label>Objetivo *</label><input id="po-name" value="${esc(cloneSource ? `${current.name || "Objetivo"} - Cópia` : current.name || "")}" placeholder="Ex.: Entrar no Full do Mercado Livre"></div>
      <div class="field"><label>Categoria</label><input id="po-category" value="${esc(current.category || "")}"></div>
      <div class="field"><label>Canal</label><input id="po-channel" value="${esc(current.channel || "")}"></div>
      <div class="field"><label>Critério de conclusão</label><textarea id="po-criteria" rows="5" placeholder="Como saberemos que este objetivo foi alcançado?">${esc(current.completion_criteria || "")}</textarea></div>
      <div class="field"><label>Comentários</label><textarea id="po-comments" rows="4" placeholder="Contexto do objetivo">${esc(current.comments || "")}</textarea></div>
      <div class="field"><label>Observações</label><textarea id="po-notes" rows="3" placeholder="Observações do objetivo">${esc(current.notes || "")}</textarea></div>
      <div class="field"><label>Responsáveis padrão</label>${multiPickerHtml("po-assignees", assigneePickerOptions(selectedAssignees), selectedAssignees, "Selecionar responsáveis")}</div>
      <div class="field"><label>Prazo sugerido (dias)</label><input id="po-target-days" type="number" min="0" step="1" value="${esc(current.target_days ?? "")}" placeholder="Ex.: 30"></div>
      <div class="field"><label>Depende de objetivos</label>${multiPickerHtml("po-objective-dependencies", objectiveDependencyOptions, new Set(normalizeIdList(current.dependency_objective_template_ids)), "Selecionar objetivos")}</div>
      <div class="field"><label>Depende de tarefas</label>${multiPickerHtml("po-activity-dependencies", activityDependencyOptions, new Set(normalizeIdList(current.dependency_activity_template_ids)), "Selecionar tarefas")}</div>
    </div>
    <div class="modal-foot"><button class="btn" id="po-cancel">Cancelar</button><button class="btn primary" id="po-save">${editId ? "Salvar" : cloneSource ? "Criar cópia" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  document.getElementById("po-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("po-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("po-save").addEventListener("click", saveProductObjective);
  wireMultiPicker("po-assignees");
  wireMultiPicker("po-objective-dependencies");
  wireMultiPicker("po-activity-dependencies");
  document.getElementById("po-name")?.focus();
}

function createsObjectiveDependencyCycle(rows, currentId, dependencyIds) {
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (!candidateId) return false;
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const candidate = rows.find((item) => item.id === candidateId);
    const nextPath = new Set(path).add(candidateId);
    return normalizeIdList(candidate?.dependency_objective_template_ids)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

async function saveProductObjective() {
  if (productActivityState.objectiveEditId ? !requireCurrentUserPermission("objectiveTemplates", "edit", "Objetivos") : !(currentUserCan("objectiveTemplates", "create") || currentUserCan("objectiveTemplates", "clone"))) { if (!productActivityState.objectiveEditId) toast("Sem permissão para cadastrar objetivos.", true); return; }
  if (productObjectiveSavePending) return;
  const name = document.getElementById("po-name").value.trim();
  if (!name) { toast("Informe o objetivo.", true); return; }
  const rows = loadProductObjectives();
  const current = rows.find((item) => item.id === productActivityState.objectiveEditId);
  const duplicate = rows.find((item) => item.id !== current?.id
    && item.product_id === productActivityState.productId
    && String(item.name || "").trim().toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"));
  if (duplicate) { toast("Já existe um objetivo com este nome neste produto.", true); return; }
  const recordId = current?.id || crypto.randomUUID();
  const dependencyObjectiveIds = multiPickerValues("po-objective-dependencies");
  const dependencyActivityIds = multiPickerValues("po-activity-dependencies");
  const assignees = assigneePickerValue("po-assignees");
  if (createsObjectiveDependencyCycle(rows, recordId, dependencyObjectiveIds)) {
    toast("Essa dependência criaria um ciclo entre os objetivos.", true);
    return;
  }
  const productRows = rows.filter((item) => item.product_id === productActivityState.productId);
  const targetValue = document.getElementById("po-target-days").value;
  const body = {
    product_id: productActivityState.productId,
    name,
    completion_criteria: document.getElementById("po-criteria").value.trim(),
    comments: document.getElementById("po-comments").value.trim(),
    category: document.getElementById("po-category").value.trim(),
    channel: document.getElementById("po-channel").value.trim(),
    notes: document.getElementById("po-notes").value.trim(),
    default_owner_id: assignees.ids[0] || null,
    default_assignee_ids: assignees.ids,
    assign_to_client: assignees.assignToClient,
    dependency_objective_template_ids: dependencyObjectiveIds,
    dependency_activity_template_ids: dependencyActivityIds,
    target_days: targetValue === "" ? null : Number(targetValue),
    sort_order: current?.sort_order ?? (Math.max(-1, ...productRows.map((item) => Number(item.sort_order || 0))) + 1),
    updated_at: new Date().toISOString()
  };
  const saveButton = document.getElementById("po-save");
  const saveButtonLabel = saveButton?.textContent || "Salvar";
  let objectiveSaved = false;
  productObjectiveSavePending = true;
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
  try {
    if (current) {
      const saved = isLive() ? await updateRow("productObjectives", current.id, body) : { ...current, ...body };
      Object.assign(current, saved);
    } else {
      const draft = { id: recordId, ...body, created_at: new Date().toISOString() };
      rows.push(isLive() ? await createRow("productObjectives", draft) : draft);
    }
    if (isLive()) cache.productObjectives = rows;
    else saveProductObjectives(rows);
    objectiveSaved = true;
    closeProductActivityDrawer();
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    else renderProductObjectives();
    toast("Objetivo do produto salvo.");
    await syncProductObjectives();
    await syncProductActivities();
    refreshActivityCache();
  } catch (err) { toast(`${objectiveSaved ? "Objetivo salvo, mas houve erro ao sincronizar" : "Erro ao salvar objetivo"} · ${err.message}`, true); }
  finally {
    productObjectiveSavePending = false;
    if (saveButton?.isConnected) { saveButton.disabled = false; saveButton.textContent = saveButtonLabel; }
  }
}

async function deleteProductObjective(objectiveId) {
  if (!requireCurrentUserPermission("objectiveTemplates", "delete", "Objetivos")) return;
  const linked = loadProductActivities().filter((item) => item.objective_template_id === objectiveId).length;
  const detail = linked ? ` ${linked} tarefa(s) ficarão sem objetivo.` : "";
  if (!window.confirm(`Excluir este objetivo?${detail}`)) return;
  try {
    if (isLive()) await deleteRow("productObjectives", objectiveId);
    const objectives = loadProductObjectives().filter((item) => item.id !== objectiveId);
    const activities = loadProductActivities();
    activities.forEach((item) => { if (item.objective_template_id === objectiveId) item.objective_template_id = null; });
    if (isLive()) {
      cache.productObjectives = objectives;
      cache.productActivities = activities;
    } else {
      saveProductObjectives(objectives);
      saveProductActivities(activities);
    }
    renderProductObjectives();
    toast("Objetivo removido.");
  } catch (err) { toast("Erro ao excluir objetivo · " + err.message, true); }
}

const GOAL_COMPARISON_LABEL = { at_least: "No mínimo", at_most: "No máximo", exactly: "Igual a" };

function renderProductGoals() {
  const root = document.getElementById("product-activities-root");
  if (!root) return;
  const goals = loadProductGoals()
    .filter((item) => item.product_id === productActivityState.productId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const rows = goals.map((item) => {
    const owners = assigneeNameList(item.default_assignee_ids, item.default_owner_id, item.assign_to_client);
    const target = `${GOAL_COMPARISON_LABEL[item.comparison] || "No mínimo"} ${Number(item.target_value).toLocaleString("pt-BR")} ${item.unit || ""}`.trim();
    const dependencyGoals = normalizeIdList(item.dependency_goal_template_ids)
      .map((id) => goals.find((goal) => goal.id === id)?.name).filter(Boolean);
    const dependencyActivities = normalizeIdList(item.dependency_activity_template_ids)
      .map((id) => loadProductActivities().find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName);
    const dependencies = [...dependencyGoals, ...dependencyActivities];
    return `<tr>
      <td><strong>${esc(item.name)}</strong></td>
      <td>${esc(item.metric)}</td>
      <td>${esc(target)}</td>
      <td>${esc(item.comments || "—")}</td>
      <td class="compact-multi-cell">${stackedCell(dependencies)}</td>
      <td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td>
      <td class="compact-multi-cell">${stackedCell(owners)}</td>
      <td class="act table-actions-cell">${tableActionButtons({
        edit: { className: "pg-edit", attrs: { "data-id": item.id }, title: "Editar meta" },
        clone: { className: "pg-clone", attrs: { "data-id": item.id }, title: "Clonar meta" },
        delete: { className: "pg-delete", attrs: { "data-id": item.id }, title: "Excluir meta" }
      })}</td>
    </tr>`;
  }).join("");
  root.innerHTML = `<div class="modal-toolbar"><span class="muted">${goals.length} meta(s) do produto</span><button class="btn primary" id="pg-new">+ Meta</button></div>
    <div class="product-activity-list"><table><thead><tr>
    <th>Meta</th><th>Indicador</th><th>Valor-alvo</th><th>Comentários</th><th class="compact-multi-cell">Depende de</th><th>Prazo sugerido</th><th class="compact-multi-cell">Responsável padrão</th>${tableActionsHead()}
  </tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">Nenhuma meta cadastrada para este produto.</td></tr>'}</tbody></table></div>`;
  document.getElementById("pg-new").addEventListener("click", () => openProductGoalDrawer());
  document.querySelectorAll(".pg-edit").forEach((button) => button.addEventListener("click", () => openProductGoalDrawer(button.dataset.id)));
  document.querySelectorAll(".pg-clone").forEach((button) => button.addEventListener("click", () => openProductGoalDrawer(null, button.dataset.id)));
  document.querySelectorAll(".pg-delete").forEach((button) => button.addEventListener("click", () => deleteProductGoal(button.dataset.id)));
}

function openProductGoalDrawer(editId = null, cloneSourceId = null) {
  if (!requireCurrentUserPermission("goalTemplates", cloneSourceId ? "clone" : editId ? "edit" : "create", "Metas")) return;
  closeProductActivityDrawer();
  productActivityState.goalEditId = editId;
  const goals = loadProductGoals();
  const cloneSource = goals.find((item) => item.id === cloneSourceId);
  const current = goals.find((item) => item.id === editId) || cloneSource || {};
  const selectedAssignees = assigneePickerSelection(current.default_assignee_ids, current.default_owner_id, current.assign_to_client);
  const comparisonOptions = Object.entries(GOAL_COMPARISON_LABEL).map(([value, label]) =>
    `<option value="${value}"${value === (current.comparison || "at_least") ? " selected" : ""}>${label}</option>`).join("");
  const goalDependencyOptions = loadProductGoals()
    .filter((item) => item.product_id === productActivityState.productId && item.id !== editId)
    .map((item) => ({ value: item.id, label: item.name }));
  const activityDependencyOptions = loadProductActivities()
    .filter((item) => item.product_id === productActivityState.productId)
    .map((item) => ({ value: item.id, label: activityDisplayName(item) }));
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer">
    <h3>${editId ? "Editar meta" : cloneSource ? "Clonar meta" : "Nova meta"}<button class="modal-close-x" id="pg-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form">
      <div class="field"><label>Meta *</label><input id="pg-name" value="${esc(cloneSource ? `${current.name || "Meta"} - Cópia` : current.name || "")}" placeholder="Ex.: Atingir 500 pedidos mensais"></div>
      <div class="field"><label>Categoria</label><input id="pg-category" value="${esc(current.category || "")}"></div>
      <div class="field"><label>Canal</label><input id="pg-channel" value="${esc(current.channel || "")}"></div>
      <div class="field"><label>Indicador *</label><input id="pg-metric" value="${esc(current.metric || "")}" placeholder="Ex.: Pedidos por mês"></div>
      <div class="field"><label>Condição</label><select id="pg-comparison">${comparisonOptions}</select></div>
      <div class="field"><label>Valor-alvo *</label><input id="pg-target" type="number" step="any" value="${esc(current.target_value ?? "")}" placeholder="Ex.: 500"></div>
      <div class="field"><label>Unidade</label><input id="pg-unit" value="${esc(current.unit || "")}" placeholder="Ex.: pedidos/mês, %, R$"></div>
      <div class="field"><label>Comentários</label><textarea id="pg-comments" rows="4" placeholder="Contexto da meta">${esc(current.comments || "")}</textarea></div>
      <div class="field"><label>Observações</label><textarea id="pg-notes" rows="3" placeholder="Observações da meta">${esc(current.notes || "")}</textarea></div>
      <div class="field"><label>Prazo sugerido (dias)</label><input id="pg-target-days" type="number" min="0" step="1" value="${esc(current.target_days ?? "")}" placeholder="Ex.: 90"></div>
      <div class="field"><label>Responsáveis padrão</label>${multiPickerHtml("pg-assignees", assigneePickerOptions(selectedAssignees), selectedAssignees, "Selecionar responsáveis")}</div>
      <div class="field"><label>Depende de metas</label>${multiPickerHtml("pg-goal-dependencies", goalDependencyOptions, new Set(normalizeIdList(current.dependency_goal_template_ids)), "Selecionar metas")}</div>
      <div class="field"><label>Depende de tarefas</label>${multiPickerHtml("pg-activity-dependencies", activityDependencyOptions, new Set(normalizeIdList(current.dependency_activity_template_ids)), "Selecionar tarefas")}</div>
    </div>
    <div class="modal-foot"><button class="btn" id="pg-cancel">Cancelar</button><button class="btn primary" id="pg-save">${editId ? "Salvar" : cloneSource ? "Criar cópia" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  document.getElementById("pg-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pg-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pg-save").addEventListener("click", saveProductGoal);
  wireMultiPicker("pg-assignees");
  wireMultiPicker("pg-goal-dependencies");
  wireMultiPicker("pg-activity-dependencies");
  document.getElementById("pg-name")?.focus();
}

function createsGoalDependencyCycle(rows, currentId, dependencyIds) {
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (!candidateId) return false;
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const candidate = rows.find((item) => item.id === candidateId);
    const nextPath = new Set(path).add(candidateId);
    return normalizeIdList(candidate?.dependency_goal_template_ids)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

async function saveProductGoal() {
  if (productActivityState.goalEditId ? !requireCurrentUserPermission("goalTemplates", "edit", "Metas") : !(currentUserCan("goalTemplates", "create") || currentUserCan("goalTemplates", "clone"))) { if (!productActivityState.goalEditId) toast("Sem permissão para cadastrar metas.", true); return; }
  if (productGoalSavePending) return;
  const name = document.getElementById("pg-name").value.trim();
  const metric = document.getElementById("pg-metric").value.trim();
  const targetValue = document.getElementById("pg-target").value;
  if (!name || !metric || targetValue === "") { toast("Informe a meta, o indicador e o valor-alvo.", true); return; }
  const rows = loadProductGoals();
  const current = rows.find((item) => item.id === productActivityState.goalEditId);
  const duplicate = rows.find((item) => item.id !== current?.id
    && item.product_id === productActivityState.productId
    && String(item.name || "").trim().toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"));
  if (duplicate) { toast("Já existe uma meta com este nome neste produto.", true); return; }
  const recordId = current?.id || crypto.randomUUID();
  const dependencyGoalIds = multiPickerValues("pg-goal-dependencies");
  const dependencyActivityIds = multiPickerValues("pg-activity-dependencies");
  const assignees = assigneePickerValue("pg-assignees");
  if (createsGoalDependencyCycle(rows, recordId, dependencyGoalIds)) {
    toast("Essa dependência criaria um ciclo entre as metas.", true);
    return;
  }
  const productRows = rows.filter((item) => item.product_id === productActivityState.productId);
  const targetDays = document.getElementById("pg-target-days").value;
  const body = {
    product_id: productActivityState.productId,
    name,
    metric,
    comparison: document.getElementById("pg-comparison").value,
    target_value: Number(targetValue),
    unit: document.getElementById("pg-unit").value.trim(),
    comments: document.getElementById("pg-comments").value.trim(),
    category: document.getElementById("pg-category").value.trim(),
    channel: document.getElementById("pg-channel").value.trim(),
    notes: document.getElementById("pg-notes").value.trim(),
    target_days: targetDays === "" ? null : Number(targetDays),
    default_owner_id: assignees.ids[0] || null,
    default_assignee_ids: assignees.ids,
    assign_to_client: assignees.assignToClient,
    dependency_goal_template_ids: dependencyGoalIds,
    dependency_activity_template_ids: dependencyActivityIds,
    sort_order: current?.sort_order ?? (Math.max(-1, ...productRows.map((item) => Number(item.sort_order || 0))) + 1),
    updated_at: new Date().toISOString()
  };
  const saveButton = document.getElementById("pg-save");
  const saveButtonLabel = saveButton?.textContent || "Salvar";
  let goalSaved = false;
  productGoalSavePending = true;
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
  try {
    if (current) {
      const saved = isLive() ? await updateRow("productGoals", current.id, body) : { ...current, ...body };
      Object.assign(current, saved);
    } else {
      const draft = { id: recordId, ...body, created_at: new Date().toISOString() };
      rows.push(isLive() ? await createRow("productGoals", draft) : draft);
    }
    if (isLive()) cache.productGoals = rows;
    else saveProductGoals(rows);
    goalSaved = true;
    closeProductActivityDrawer();
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    else renderProductGoals();
    toast("Meta do produto salva.");
    await syncProductGoals();
    await syncDeliveryGoalDependencies();
  } catch (err) { toast(`${goalSaved ? "Meta salva, mas houve erro ao sincronizar" : "Erro ao salvar meta"} · ${err.message}`, true); }
  finally {
    productGoalSavePending = false;
    if (saveButton?.isConnected) { saveButton.disabled = false; saveButton.textContent = saveButtonLabel; }
  }
}

async function deleteProductGoal(goalId) {
  if (!requireCurrentUserPermission("goalTemplates", "delete", "Metas")) return;
  if (!window.confirm("Excluir esta meta do produto?")) return;
  try {
    if (isLive()) await deleteRow("productGoals", goalId);
    const rows = loadProductGoals().filter((item) => item.id !== goalId);
    if (isLive()) cache.productGoals = rows;
    else saveProductGoals(rows);
    renderProductGoals();
    toast("Meta removida.");
  } catch (err) { toast("Erro ao excluir meta · " + err.message, true); }
}

function cloneProductActivity(templateId) {
  openProductActivityDrawer(null, templateId);
}

function openReadyActivityPicker() {
  document.getElementById("product-activity-drawer-overlay")?.remove();
  const current = loadProductActivities().filter((item) => item.product_id === productActivityState.productId);
  const currentSignatures = new Set(current.map(productActivityIdentity));
  const seen = new Set();
  const available = loadProductActivities().filter((item) => {
    if (item.product_id === productActivityState.productId) return false;
    const signature = productActivityIdentity(item);
    if (seen.has(signature) || currentSignatures.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer ready-activity-drawer">
    <h3>Escolher tarefa pronta<button class="modal-close-x" id="ready-close" title="Fechar">✕</button></h3>
    <div class="ready-activity-search"><input id="ready-activity-search" placeholder="Buscar tarefa..."></div>
    <div class="ready-activity-list" id="ready-activity-list"></div>
    <div class="modal-foot"><button class="btn" id="ready-cancel">Cancelar</button><button class="btn primary" id="ready-add">Adicionar selecionadas</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  const list = document.getElementById("ready-activity-list");
  const draw = () => {
    const query = document.getElementById("ready-activity-search").value.trim().toLocaleLowerCase("pt-BR");
    const filtered = available.filter((item) => !query || activityDisplayName(item).toLocaleLowerCase("pt-BR").includes(query));
    list.innerHTML = filtered.map((item) => {
      const product = cache.productById[item.product_id]?.name || "Produto não encontrado";
      return `<label class="ready-activity-item"><input type="checkbox" value="${esc(item.id)}"><span><strong>${esc(activityDisplayName(item))}</strong><small>${esc(product)} · ${esc(RECURRENCE_LABEL[item.recurrence] || "Única")}</small></span></label>`;
    }).join("") || '<div class="empty">Nenhuma tarefa pronta disponível.</div>';
  };
  draw();
  document.getElementById("ready-activity-search").addEventListener("input", draw);
  document.getElementById("ready-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("ready-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("ready-add").addEventListener("click", async () => {
    const selectedIds = [...list.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    if (!selectedIds.length) { toast("Selecione pelo menos uma tarefa.", true); return; }
    if (isLive()) {
      try {
        const [latestActivities, latestObjectives] = await Promise.all([
          fetchTable("productActivities"),
          fetchTable("productObjectives")
        ]);
        cache.productActivities = latestActivities;
        cache.productObjectives = latestObjectives;
      } catch (err) {
        toast("Erro ao atualizar os vínculos antes da inclusão · " + err.message, true);
        return;
      }
    }
    const rows = loadProductActivities();
    const targetCurrent = rows.filter((item) => item.product_id === productActivityState.productId);
    const signatureOf = productActivityIdentity;
    const targetBySignature = new Map(targetCurrent.map((item) => [signatureOf(item), item]));
    const orderedSources = [];
    const visited = new Set();
    const visitSource = (sourceId) => {
      if (!sourceId || visited.has(sourceId)) return;
      visited.add(sourceId);
      const source = rows.find((item) => item.id === sourceId);
      if (!source) return;
      if (source.parent_template_id) visitSource(source.parent_template_id);
      normalizeIdList(source.dependency_template_ids, source.depends_on_template_id).forEach(visitSource);
      orderedSources.push(source);
    };
    selectedIds.forEach(visitSource);
    let nextOrder = Math.max(-1, ...targetCurrent.map((item) => Number(item.sort_order || 0))) + 1;
    try {
      const objectiveRows = loadProductObjectives();
      const targetObjectives = objectiveRows.filter((item) => item.product_id === productActivityState.productId);
      const objectiveMap = new Map();
      for (const source of orderedSources) {
        if (!source.objective_template_id || objectiveMap.has(source.objective_template_id)) continue;
        const sourceObjective = objectiveRows.find((item) => item.id === source.objective_template_id);
        if (!sourceObjective) { objectiveMap.set(source.objective_template_id, null); continue; }
        let targetObjective = targetObjectives.find((item) => item.name.trim().toLocaleLowerCase("pt-BR") === sourceObjective.name.trim().toLocaleLowerCase("pt-BR"));
        if (!targetObjective) {
          const now = new Date().toISOString();
          const objectiveDraft = {
            id: crypto.randomUUID(), product_id: productActivityState.productId,
            name: sourceObjective.name, completion_criteria: sourceObjective.completion_criteria || "",
            category: sourceObjective.category || "", channel: sourceObjective.channel || "", notes: sourceObjective.notes || "", comments: sourceObjective.comments || "",
            default_owner_id: sourceObjective.default_owner_id || null,
            target_days: sourceObjective.target_days ?? null,
            sort_order: Math.max(-1, ...targetObjectives.map((item) => Number(item.sort_order || 0))) + 1,
            created_at: now, updated_at: now
          };
          targetObjective = isLive() ? await createRow("productObjectives", objectiveDraft) : objectiveDraft;
          objectiveRows.push(targetObjective);
          targetObjectives.push(targetObjective);
        }
        objectiveMap.set(source.objective_template_id, targetObjective.id);
      }
      const targetIdBySignature = new Map(targetCurrent.map((item) => [signatureOf(item), item.id]));
      const activityMap = new Map();
      for (const source of orderedSources) {
        const signature = signatureOf(source);
        if (!targetIdBySignature.has(signature)) targetIdBySignature.set(signature, crypto.randomUUID());
        activityMap.set(source.id, targetIdBySignature.get(signature));
      }
      let createdCount = 0;
      const createdSignatures = new Set(targetCurrent.map(signatureOf));
      for (const source of orderedSources) {
        const signature = signatureOf(source);
        if (createdSignatures.has(signature)) continue;
        const now = new Date().toISOString();
        const dependencyIds = normalizeIdList(source.dependency_template_ids, source.depends_on_template_id)
          .map((id) => activityMap.get(id)).filter(Boolean);
        const draft = {
          ...source, id: activityMap.get(source.id), product_id: productActivityState.productId,
          parent_template_id: activityMap.get(source.parent_template_id) || null,
          dependency_template_ids: dependencyIds,
          depends_on_template_id: dependencyIds[0] || null,
          objective_template_id: objectiveMap.get(source.objective_template_id) || null,
          checklist: normalizeChecklist(source.checklist).map((item) => ({ ...item, checked: false })),
          sort_order: nextOrder++,
          created_at: now, updated_at: now
        };
        const saved = isLive() ? await createRow("productActivities", draft) : draft;
        rows.push(saved);
        targetBySignature.set(signature, saved);
        createdSignatures.add(signature);
        createdCount += 1;
      }
      if (isLive()) {
        cache.productActivities = rows;
        cache.productObjectives = objectiveRows;
      } else {
        saveProductActivities(rows);
        saveProductObjectives(objectiveRows);
      }
      await syncProductObjectives();
      await syncProductActivities();
      refreshActivityCache();
      closeProductActivityDrawer();
      renderProductActivities();
      toast(`${createdCount} tarefa(s) adicionada(s) com todos os vínculos.`);
    } catch (err) { toast("Erro ao adicionar tarefas · " + err.message, true); }
  });
  document.getElementById("ready-activity-search").focus();
}

function wireProductActivityDragAndDrop() {
  const tbody = document.getElementById("pa-tbody");
  if (!tbody) return;
  let dragged = null;
  tbody.querySelectorAll(".pa-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      if (event.target.closest("button")) { event.preventDefault(); return; }
      dragged = row;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.id);
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === row) return;
      const rect = row.getBoundingClientRect();
      tbody.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      await persistProductActivityOrder();
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragged = null;
    });
  });
}

async function persistProductActivityOrder() {
  const ids = [...document.querySelectorAll("#pa-tbody .pa-row")].map((row) => row.dataset.id);
  const rows = loadProductActivities();
  const changed = [];
  ids.forEach((id, sortOrder) => {
    const item = rows.find((row) => row.id === id);
    if (!item || Number(item.sort_order || 0) === sortOrder) return;
    item.sort_order = sortOrder;
    item.updated_at = new Date().toISOString();
    changed.push(item);
  });
  if (!changed.length) return;
  try {
    if (isLive()) {
      await Promise.all(changed.map((item) => updateRow("productActivities", item.id, {
        sort_order: item.sort_order,
        updated_at: item.updated_at
      })));
      cache.productActivities = rows;
    } else saveProductActivities(rows);
    await syncProductActivities();
    refreshActivityCache();
    toast("Ordem das tarefas salva.");
  } catch (err) {
    toast("Erro ao salvar a ordem · " + err.message, true);
    renderProductActivities();
  }
}

function closeProductActivityDrawer() {
  document.getElementById("product-activity-drawer-overlay")?.remove();
  productActivityState.editId = null;
  productActivityState.objectiveEditId = null;
  productActivityState.goalEditId = null;
  productActivityParentGroupId = null;
}

async function openProductActivityDrawer(editId = null, cloneSourceId = null, parentTemplateId = null) {
  if (!requireCurrentUserPermission("activityTemplates", cloneSourceId ? "clone" : editId ? "edit" : "create", "Tarefas")) return;
  await ensureTaskReferenceSources();
  closeProductActivityDrawer();
  productActivityState.editId = editId;
  const allTemplates = loadProductActivities();
  const templates = allTemplates.filter((item) => item.product_id === productActivityState.productId);
  const editing = templates.find((item) => item.id === editId) || null;
  const cloneSource = templates.find((item) => item.id === cloneSourceId) || null;
  const current = editing || (cloneSource ? { ...cloneSource, id: null, activity: cloneSource.activity ? `${cloneSource.activity} (cópia)` : "" } : {});
  const useStructure = Boolean((editing || cloneSource) && !String(current.activity || "").trim());
  const requestedParent = allTemplates.find((item) => item.id === (editing?.parent_template_id || cloneSource?.parent_template_id || parentTemplateId)) || null;
  if (requestedParent?.parent_template_id) {
    toast("Uma subtarefa não pode receber outra subtarefa.", true);
    return;
  }
  if (!editing && !cloneSource && requestedParent) {
    Object.assign(current, {
      group: requestedParent.group || "",
      subgroup: requestedParent.subgroup || "",
      sector: requestedParent.sector || "",
      subsector: requestedParent.subsector || "",
      module: requestedParent.module || "",
      submodule: requestedParent.submodule || "",
      category: requestedParent.category || "",
      channel: requestedParent.channel || "",
      type: requestedParent.type || "",
      recurrence: requestedParent.recurrence || "once",
      priority: requestedParent.priority || "normal",
      target_days: requestedParent.target_days ?? null,
      consider_business_days: Boolean(requestedParent.consider_business_days),
      objective_template_id: requestedParent.objective_template_id || null,
      default_owner_id: requestedParent.default_owner_id || null,
      default_assignee_ids: normalizeIdList(requestedParent.default_assignee_ids, requestedParent.default_owner_id),
      default_assignee_job_titles: normalizeTextList(requestedParent.default_assignee_job_titles),
      assign_to_client: Boolean(requestedParent.assign_to_client)
    });
  }
  productActivityParentGroupId = requestedParent ? (requestedParent.template_group_id || requestedParent.id) : null;
  productActivityDraftGroupId = editing?.template_group_id || crypto.randomUUID();
  productActivityRelatedIds = editing
    ? loadProductActivities().filter((item) => item.template_group_id
      ? item.template_group_id === editing.template_group_id
      : item.id === editing.id).map((item) => item.id)
    : [];
  const selectedProductIds = new Set(editing
    ? loadProductActivities().filter((item) => productActivityRelatedIds.includes(item.id)).map((item) => item.product_id)
    : requestedParent
      ? allTemplates.filter((item) => (item.template_group_id || item.id) === productActivityParentGroupId).map((item) => item.product_id)
      : [productActivityState.productId]);
  const hasSubtasks = editing && allTemplates.some((item) => productActivityRelatedIds.includes(item.parent_template_id));
  productActivityChecklistDraft = normalizeChecklist(current.checklist || requestedParent?.checklist).map((item) => ({ ...item, checked: false }));
  const selectedDependencies = new Set(normalizeIdList(current.dependency_template_ids, current.depends_on_template_id));
  const dependencyOptions = templates.filter((item) => item.id !== editId).map((item) => ({ value: item.id, label: activityDisplayName(item) }));
  const selectedAssignees = assigneePickerSelection(current.default_assignee_ids, current.default_owner_id, current.assign_to_client);
  const selectedJobTitles = new Set(normalizeTextList(current.default_assignee_job_titles));
  const selectedDocuments = new Set(normalizeIdList(current.document_ids));
  const selectedTables = new Set(normalizeIdList(current.custom_table_ids));
  const objectiveOptions = ['<option value="">Sem objetivo</option>'].concat(
    loadProductObjectives().filter((item) => item.product_id === productActivityState.productId).map((item) =>
      `<option value="${esc(item.id)}"${item.id === current.objective_template_id ? " selected" : ""}>${esc(item.name)}</option>`)
  ).join("");
  const recurrenceOptions = RECURRENCE_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${value === (current.recurrence || "once") ? " selected" : ""}>${label}</option>`).join("");
  const priorityOptions = PRIORITY_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${value === (current.priority || "normal") ? " selected" : ""}>${label}</option>`).join("");
  const productOptions = (cache.products || []).map((product) => ({ value: product.id, label: product.name }));
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer task-form-drawer">
    <h3>${current.id ? (productActivityParentGroupId ? "Editar subtarefa" : "Editar tarefa") : cloneSource ? "Clonar tarefa" : productActivityParentGroupId ? "Nova subtarefa" : "Nova tarefa"}<button class="modal-close-x" id="pa-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form task-form-grid">
      ${requestedParent ? `<div class="field task-form-wide"><label>Tarefa principal</label><input value="${esc(activityDisplayName(requestedParent))}" disabled></div>` : ""}
      <div class="field task-form-wide"><label>Produtos *</label>${multiPickerHtml("pa-products", productOptions, selectedProductIds, "Selecionar produtos", false, Boolean(requestedParent))}</div>
      <div class="field"><label>Grupo</label><select id="pa-group">${taskSelectOptions(TASK_GROUP_OPTIONS, current.group, "Sem grupo")}</select></div>
      <div class="field"><label>Subgrupo</label><select id="pa-subgroup">${taskSelectOptions(TASK_GROUP_SUBGROUP_OPTIONS[canonicalTaskChoice(current.group, TASK_GROUP_OPTIONS)] || [], current.subgroup, "Sem subgrupo")}</select></div>
      <div class="field"><label>Setor</label><select id="pa-sector">${taskSelectOptions(TASK_SECTOR_OPTIONS, current.sector, "Sem setor")}</select></div>
      <div class="field"><label>Subsetor</label><input id="pa-subsector" value="${esc(current.subsector || "")}" placeholder="Subsetor opcional"></div>
      <div class="field"><label>Categoria</label><input id="pa-category" value="${esc(current.category || "")}"></div>
      <div class="field"><label>Canal</label><input id="pa-channel" value="${esc(current.channel || "")}"></div>
      <div class="field"><label>Módulo</label><input id="pa-module" value="${esc(current.module || "")}" placeholder="Módulo opcional"></div>
      <div class="field"><label>Submódulo</label><input id="pa-submodule" value="${esc(current.submodule || "")}" placeholder="Submódulo opcional"></div>
      <div class="task-schedule-row task-schedule-row-wide">
        <div class="field"><label>Recorrência</label><select id="pa-recurrence">${recurrenceOptions}</select></div>
        <div class="field"><label>Prioridade</label><select id="pa-priority">${priorityOptions}</select></div>
        <div class="field"><label>Prazo sugerido (dias)</label><input id="pa-target-days" type="number" min="0" step="1" value="${esc(current.target_days ?? "")}" placeholder="Ex.: 7"></div>
        <div class="field" title="Dias para iniciar depois que a tarefa da qual esta depende terminar (data real se concluída; senão, a prevista)."><label>Iniciar após dependência (dias)</label><input id="pa-start-after" type="number" min="0" step="1" value="${esc(current.start_after_days ?? "")}" placeholder="Ex.: 2"></div>
        <label class="task-business-days" for="pa-business-days"><input id="pa-business-days" type="checkbox"${current.consider_business_days ? " checked" : ""}><span>Dias úteis</span></label>
      </div>
      <div class="task-name-row">
        <div class="field"><label id="pa-activity-label">${productActivityParentGroupId ? "Subtarefa" : "Tarefa"}${useStructure ? "" : " *"}</label><input id="pa-activity" value="${esc(current.activity || "")}" placeholder="Nome da ${productActivityParentGroupId ? "subtarefa" : "tarefa"}"></div>
        <div class="field"><label>Tipo</label><input id="pa-type" value="${esc(current.type || "")}"></div>
        <label class="task-use-structure" for="pa-use-structure"><input id="pa-use-structure" type="checkbox"${useStructure ? " checked" : ""}><span>Usar estrutura</span></label>
      </div>
      <div class="field task-form-wide"><label>Informação</label><textarea id="pa-information" rows="3" placeholder="Instruções, contexto ou informações importantes">${esc(current.information || "")}</textarea></div>
      <div class="field task-form-wide"><label>Checklist</label>${hasSubtasks ? '<div class="panel-list">O checklist desta tarefa fica nas subtarefas.</div>' : '<div class="checklist-editor" id="pa-checklist"></div><button class="btn checklist-add" id="pa-checklist-add" type="button">+ Item</button>'}</div>
      <div class="field"><label>Objetivo</label><select id="pa-objective">${objectiveOptions}</select></div>
      <div class="field"><label>Responsáveis padrão</label>${multiPickerHtml("pa-assignees", assigneePickerOptions(selectedAssignees), selectedAssignees, "Selecionar responsáveis")}</div>
      <div class="field"><label>Cargos responsáveis</label>${multiPickerHtml("pa-assignee-job-titles", assigneeJobTitleOptions(), selectedJobTitles, "Selecionar cargos")}</div>
      <div class="field task-form-wide"><label>Depende de</label>${multiPickerHtml("pa-dependencies", dependencyOptions, selectedDependencies, "Selecionar dependências")}</div>
      <div class="field"><label>Documentos de apoio</label>${multiPickerHtml("pa-documents", taskDocumentOptions(), selectedDocuments, "Selecionar documentos")}</div>
      <div class="field"><label>Tabelas de apoio</label>${multiPickerHtml("pa-tables", taskTableOptions(), selectedTables, "Selecionar tabelas")}</div>
    </div>
    <div class="modal-foot">${editing && !productActivityParentGroupId ? '<button class="btn" id="pa-add-subtask">+ Subtarefa</button>' : ""}<button class="btn" id="pa-cancel">Cancelar</button><button class="btn primary" id="pa-save">${current.id ? "Salvar" : cloneSource ? "Criar cópia" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  document.getElementById("pa-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pa-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pa-save").addEventListener("click", saveProductActivity);
  document.getElementById("pa-add-subtask")?.addEventListener("click", () => openProductActivityDrawer(null, null, editing.id));
  document.getElementById("pa-checklist-add")?.addEventListener("click", () => {
    productActivityChecklistDraft.push({ id: crypto.randomUUID(), text: "", checked: false });
    renderProductActivityChecklistEditor();
    document.querySelector("#pa-checklist .checklist-edit-row:last-child input")?.focus();
  });
  wireMultiPicker("pa-products");
  wireTaskGroupSelect("pa-group", "pa-subgroup");
  wireMultiPicker("pa-assignees");
  wireMultiPicker("pa-assignee-job-titles");
  wireMultiPicker("pa-dependencies");
  wireMultiPicker("pa-documents");
  wireMultiPicker("pa-tables");
  wireTaskStructureToggle("pa-use-structure", "pa-activity", "pa-activity-label", ["pa-category", "pa-channel", "pa-module", "pa-type"]);
  renderProductActivityChecklistEditor();
  (document.getElementById("pa-activity")?.disabled ? document.getElementById("pa-category") : document.getElementById("pa-activity"))?.focus({ preventScroll: true });
}

function createsTemplateDependencyCycle(rows, currentId, dependencyIds) {
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (!candidateId) return false;
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const nextPath = new Set(path).add(candidateId);
    const candidate = rows.find((item) => item.id === candidateId);
    return normalizeIdList(candidate?.dependency_template_ids, candidate?.depends_on_template_id)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

async function saveProductActivity() {
  if (productActivityState.editId ? !requireCurrentUserPermission("activityTemplates", "edit", "Tarefas") : !(currentUserCan("activityTemplates", "create") || currentUserCan("activityTemplates", "clone"))) { if (!productActivityState.editId) toast("Sem permissão para cadastrar tarefas.", true); return; }
  if (productActivitySavePending) return;
  const useStructure = document.getElementById("pa-use-structure").checked;
  const activity = useStructure ? "" : document.getElementById("pa-activity").value.trim();
  if (!useStructure && !activity) { toast("Informe a tarefa ou marque Usar estrutura.", true); return; }
  if (useStructure && !taskStructureFieldsFilled(["pa-category", "pa-channel", "pa-module", "pa-type"])) { toast(`Preencha ${TASK_STRUCTURE_REQUIRED_LABEL} para usar a estrutura.`, true); return; }
  const rows = loadProductActivities();
  const current = rows.find((item) => item.id === productActivityState.editId);
  const recordId = current?.id || crypto.randomUUID();
  const dependencyIds = multiPickerValues("pa-dependencies");
  const assignees = assigneePickerValue("pa-assignees");
  const assigneeJobTitles = multiPickerValues("pa-assignee-job-titles");
  const selectedProductIds = multiPickerValues("pa-products");
  if (!selectedProductIds.length) { toast("Selecione pelo menos um produto.", true); return; }
  const parentTemplates = productActivityParentGroupId
    ? rows.filter((item) => (item.template_group_id || item.id) === productActivityParentGroupId)
    : [];
  const parentsToClear = parentTemplates.filter((parent) => !rows.some((item) => item.parent_template_id === parent.id));
  if (productActivityParentGroupId && selectedProductIds.some((productId) => !parentTemplates.some((item) => item.product_id === productId))) {
    toast("A subtarefa só pode ser vinculada aos produtos da tarefa principal.", true);
    return;
  }
  if (createsTemplateDependencyCycle(rows, recordId, dependencyIds)) {
    toast("Essa dependência criaria um ciclo entre as tarefas.", true);
    return;
  }
  const baseBody = {
    group: document.getElementById("pa-group").value,
    subgroup: document.getElementById("pa-subgroup").value,
    sector: document.getElementById("pa-sector").value,
    subsector: document.getElementById("pa-subsector").value.trim(),
    module: document.getElementById("pa-module").value.trim(),
    submodule: document.getElementById("pa-submodule").value.trim(),
    category: document.getElementById("pa-category").value.trim(),
    channel: document.getElementById("pa-channel").value.trim(),
    type: document.getElementById("pa-type").value.trim(),
    recurrence: document.getElementById("pa-recurrence").value || "once",
    priority: document.getElementById("pa-priority").value || "normal",
    target_days: document.getElementById("pa-target-days").value === "" ? null : Number(document.getElementById("pa-target-days").value),
    start_after_days: document.getElementById("pa-start-after").value === "" ? null : Number(document.getElementById("pa-start-after").value),
    consider_business_days: document.getElementById("pa-business-days").checked,
    activity,
    information: document.getElementById("pa-information").value.trim(),
    document_ids: multiPickerValues("pa-documents"),
    custom_table_ids: multiPickerValues("pa-tables"),
    checklist: productActivityChecklistDraft
      .map((item) => ({ id: item.id || crypto.randomUUID(), text: item.text.trim(), checked: false }))
      .filter((item) => item.text),
    default_owner_id: assignees.ids[0] || null,
    default_assignee_ids: assignees.ids,
    default_assignee_job_titles: assigneeJobTitles,
    assign_to_client: assignees.assignToClient,
    template_group_id: productActivityDraftGroupId || crypto.randomUUID(),
    updated_at: new Date().toISOString()
  };
  const saveButton = document.getElementById("pa-save");
  const saveButtonLabel = saveButton?.textContent || "Salvar";
  let activitySaved = false;
  productActivitySavePending = true;
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
  try {
    const related = productActivityRelatedIds.map((id) => rows.find((item) => item.id === id)).filter(Boolean);
    const taskRows = loadProjectTasks();
    const selectedObjective = loadProductObjectives().find((item) => item.id === (document.getElementById("pa-objective").value || null));
    const selectedDependencies = dependencyIds.map((id) => rows.find((item) => item.id === id)).filter(Boolean);
    for (const productId of selectedProductIds) {
      const productRows = rows.filter((item) => item.product_id === productId);
      const existing = related.find((item) => item.product_id === productId) || (current?.product_id === productId ? current : null);
      const targetObjective = productId === productActivityState.productId
        ? selectedObjective
        : loadProductObjectives().find((item) => item.product_id === productId && selectedObjective && item.name.trim().toLocaleLowerCase("pt-BR") === selectedObjective.name.trim().toLocaleLowerCase("pt-BR"));
      const targetDependencies = selectedDependencies.map((selectedDependency) => productId === productActivityState.productId
        ? selectedDependency
        : productRows.find((item) => productActivityIdentity(item) === productActivityIdentity(selectedDependency))).filter(Boolean);
      const targetParent = parentTemplates.find((item) => item.product_id === productId) || null;
      const body = {
        ...baseBody,
        product_id: productId,
        parent_template_id: targetParent?.id || null,
        depends_on_template_id: targetDependencies[0]?.id || null,
        dependency_template_ids: targetDependencies.map((item) => item.id),
        objective_template_id: targetObjective?.id || null,
        sort_order: existing?.sort_order ?? (Math.max(-1, ...productRows.map((item) => Number(item.sort_order || 0))) + 1)
      };
      if (existing) {
        const saved = isLive() ? await updateRow("productActivities", existing.id, body) : { ...existing, ...body };
        Object.assign(existing, saved);
      } else {
        const draft = { id: productId === productActivityState.productId ? recordId : crypto.randomUUID(), ...body, created_at: new Date().toISOString() };
        rows.push(isLive() ? await createRow("productActivities", draft) : draft);
      }
    }
    if (productActivityParentGroupId) {
      for (const parent of parentsToClear) {
        if (!normalizeChecklist(parent.checklist).length) continue;
        const changes = { checklist: [], updated_at: new Date().toISOString() };
        if (isLive()) await updateRow("productActivities", parent.id, changes);
        Object.assign(parent, changes);
      }
    }
    for (const removed of related.filter((item) => !selectedProductIds.includes(item.product_id))) {
      if (isLive()) await deleteRow("productActivities", removed.id);
      const index = rows.findIndex((item) => item.id === removed.id);
      if (index >= 0) rows.splice(index, 1);
      const linkedTasks = taskRows.filter((task) => task.source_template_id === removed.id);
      for (const task of linkedTasks) {
        task.source_template_id = null;
        if (isLive()) await updateRow("activities", task.id, { source_template_id: null });
      }
    }
    if (!isLive() && related.some((item) => !selectedProductIds.includes(item.product_id))) saveProjectTasks(taskRows);
    if (isLive()) cache.productActivities = rows;
    else saveProductActivities(rows);
    activitySaved = true;
    closeProductActivityDrawer();
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    else renderProductActivities();
    toast(`Tarefa salva em ${selectedProductIds.length} produto(s). Sincronizando com as entregas...`);
    await syncProductActivities();
    refreshActivityCache();
  } catch (err) { toast(`${activitySaved ? "Tarefa salva, mas houve erro ao sincronizar" : "Erro ao salvar tarefa"} · ${err.message}`, true); }
  finally {
    productActivitySavePending = false;
    if (saveButton?.isConnected) { saveButton.disabled = false; saveButton.textContent = saveButtonLabel; }
  }
}

const TASK_STATUS = [
  { id: "todo", label: "Em aberto" },
  { id: "doing", label: "Em andamento" },
  { id: "done", label: "Atendido" },
  { id: "canceled", label: "Cancelado" }
];
const CLIENT_ASSIGNEE_VALUE = "__client__";
let projectBoardState = { projectId: null, view: "table", section: "activities", search: "", page: 1, pageSize: 50, calendarCursor: null, sortKey: null, sortDir: 1, filters: {} };

function internalAssigneeUser(user) {
  return ["admin", "collaborator"].includes(normalizedProfileRole(user?.role)) && (user?.status || "active") === "active";
}

function assigneePickerOptions(selected = []) {
  const keep = new Set(selected instanceof Set ? selected : normalizeIdList(selected));
  return [
    ...(cache?.users || []).filter((user) => internalAssigneeUser(user) || keep.has(user.id))
      .map((user) => ({ value: user.id, label: userDisplayName(user.id) })),
    { value: CLIENT_ASSIGNEE_VALUE, label: "Cliente", detail: "Responsável da empresa" }
  ];
}

function assigneePickerSelection(ids, fallbackId = null, assignToClient = false) {
  const selected = new Set(normalizeIdList(ids, fallbackId));
  if (assignToClient) selected.add(CLIENT_ASSIGNEE_VALUE);
  return selected;
}

function assigneePickerValue(id) {
  const values = multiPickerValues(id);
  return {
    ids: values.filter((value) => value !== CLIENT_ASSIGNEE_VALUE),
    assignToClient: values.includes(CLIENT_ASSIGNEE_VALUE)
  };
}

function userOptions(selected = "") {
  const users = cache?.users || [];
  const options = users.map((user) => {
    const id = user.id;
    return `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(userDisplayName(id))}</option>`;
  });
  if (selected && !users.some((user) => user.id === selected)) {
    options.unshift(`<option value="${esc(selected)}" selected>${esc(userDisplayName(selected))}</option>`);
  }
  return ['<option value="">Sem responsável</option>', ...options].join("");
}

function assigneeNameList(ids, fallbackId = null, assignToClient = false) {
  const names = normalizeIdList(ids, fallbackId).map((id) => userDisplayName(id));
  if (assignToClient) names.push("Cliente");
  return [...new Set(names.filter((name) => name && name !== "—"))];
}

function assigneeNames(ids, fallbackId = null, assignToClient = false) {
  return assigneeNameList(ids, fallbackId, assignToClient).join(", ") || "—";
}

function assigneeJobTitleOptions() {
  return [...new Map((cache?.users || [])
    .filter((user) => internalAssigneeUser(user) && String(user.job_title || "").trim())
    .map((user) => {
      const title = String(user.job_title).trim();
      return [title.toLocaleLowerCase("pt-BR"), { value: title, label: title }];
    })).values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }));
}

function responsibilityNameList(ids, fallbackId = null, jobTitles = [], assignToClient = false) {
  const direct = assigneeNameList(ids, fallbackId, assignToClient);
  const roles = normalizeTextList(jobTitles).map((title) => {
    const eligible = (cache?.users || []).filter((user) =>
      user.status === "active" && String(user.job_title || "").trim().toLocaleLowerCase("pt-BR") === title.toLocaleLowerCase("pt-BR")
    ).map((user) => user.nickname || user.full_name || user.name || user.email).filter(Boolean);
    return eligible.length ? `Cargo: ${title} (${eligible.join(", ")})` : `Cargo: ${title}`;
  });
  return [...new Set([...direct, ...roles])];
}

function responsibilityNames(ids, fallbackId = null, jobTitles = [], assignToClient = false) {
  return responsibilityNameList(ids, fallbackId, jobTitles, assignToClient).join(", ") || "—";
}

function dependencyNameList(ids, fallbackId, rows = loadProjectTasks()) {
  return [...new Set(normalizeIdList(ids, fallbackId).map((id) => activityDisplayName(rows.find((item) => item.id === id))).filter((name) => name !== "—"))];
}

function dependencyNames(ids, fallbackId, rows = loadProjectTasks()) {
  return dependencyNameList(ids, fallbackId, rows).join(", ") || "—";
}

function multiPickerHtml(id, options, selectedIds, placeholder, searchOnly = false, disabled = false, lockedIds = new Set(), allowCreate = false) {
  const selected = new Set(selectedIds);
  const locked = new Set(lockedIds);
  const rows = options.map((option) => {
    const optionLocked = locked.has(option.value);
    return `<button type="button" class="multi-picker-option${selected.has(option.value) ? " active" : ""}${optionLocked ? " locked" : ""}" data-value="${esc(option.value)}" data-label="${esc(option.label)}" data-search="${esc(option.search || [option.label, option.detail, option.value].filter(Boolean).join(" "))}" data-locked="${optionLocked}"${disabled || optionLocked ? " disabled" : ""}><span>${esc(option.label)}</span>${option.detail ? `<small>${esc(option.detail)}</small>` : ""}<b>✓</b></button>`;
  }).join("");
  return `<div class="multi-picker${disabled ? " is-disabled" : ""}" id="${esc(id)}" data-placeholder="${esc(placeholder)}" data-search-only="${searchOnly}" data-disabled="${disabled}" data-allow-create="${allowCreate}">
    <div class="multi-picker-control" role="button" tabindex="${disabled ? "-1" : "0"}" aria-expanded="false" aria-disabled="${disabled}"><div class="multi-picker-selection"></div><span class="multi-picker-chevron">▾</span></div>
    <div class="multi-picker-menu" hidden><input class="multi-picker-search" type="search" placeholder="${searchOnly ? "Digite o nome ou CNPJ..." : allowCreate ? "Buscar ou adicionar..." : "Buscar..."}"><div class="multi-picker-search-hint"${searchOnly ? "" : " hidden"}>Digite para pesquisar.</div>${allowCreate ? '<div class="multi-picker-create-hint">Pressione Enter para adicionar uma nova badge.</div>' : ""}<div class="multi-picker-options">${rows || '<div class="multi-picker-empty">Nenhuma opção disponível.</div>'}</div></div>
  </div>`;
}

function multiPickerValues(id) {
  return [...document.querySelectorAll(`#${id} .multi-picker-option.active`)].map((option) => option.dataset.value);
}

function wireMultiPicker(id) {
  const root = document.getElementById(id);
  if (!root) return;
  const control = root.querySelector(".multi-picker-control");
  const menu = root.querySelector(".multi-picker-menu");
  const search = root.querySelector(".multi-picker-search");
  const searchOnly = root.dataset.searchOnly === "true";
  const disabled = root.dataset.disabled === "true";
  const allowCreate = root.dataset.allowCreate === "true";
  const filterOptions = () => {
    const query = search.value.trim().toLocaleLowerCase("pt-BR");
    const queryDigits = query.replace(/\D/g, "");
    root.querySelectorAll(".multi-picker-option").forEach((option) => {
      const haystack = [option.dataset.label, option.dataset.value, option.dataset.search].join(" ").toLocaleLowerCase("pt-BR");
      const digitMatch = queryDigits.length >= 3 && option.dataset.value.replace(/\D/g, "").includes(queryDigits);
      const matches = haystack.includes(query) || digitMatch;
      option.hidden = searchOnly ? !query || !matches : Boolean(query && !matches);
    });
    root.querySelector(".multi-picker-search-hint")?.toggleAttribute("hidden", !searchOnly || Boolean(query));
  };
  const drawSelection = () => {
    const active = [...root.querySelectorAll(".multi-picker-option.active")];
    root.querySelector(".multi-picker-selection").innerHTML = active.length
      ? active.map((option) => disabled || option.dataset.locked === "true"
        ? `<span class="multi-picker-chip"><span>${esc(option.dataset.label)}</span></span>`
        : `<button type="button" class="multi-picker-chip" data-value="${esc(option.dataset.value)}" title="Remover"><span>${esc(option.dataset.label)}</span><b>×</b></button>`).join("")
      : `<span class="multi-picker-placeholder">${esc(root.dataset.placeholder || "Selecione")}</span>`;
    if (disabled) return;
    root.querySelectorAll(".multi-picker-chip").forEach((chip) => chip.addEventListener("click", (event) => {
      event.stopPropagation();
      root.querySelector(`.multi-picker-option[data-value="${CSS.escape(chip.dataset.value)}"]`)?.classList.remove("active");
      drawSelection();
      root.dispatchEvent(new CustomEvent("multi-picker-change"));
    }));
  };
  const toggleMenu = (open) => {
    document.querySelectorAll(".multi-picker-menu:not([hidden])").forEach((other) => { if (other !== menu) other.hidden = true; });
    menu.hidden = open == null ? !menu.hidden : !open;
    control.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) { search.value = ""; filterOptions(); search.focus(); }
  };
  drawSelection();
  if (disabled) return;
  const bindOption = (option) => option.addEventListener("click", () => {
    option.classList.toggle("active");
    drawSelection();
    root.dispatchEvent(new CustomEvent("multi-picker-change"));
  });
  control.addEventListener("click", () => toggleMenu());
  control.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleMenu(); } });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); toggleMenu(false); control.focus(); } });
  root.querySelectorAll(".multi-picker-option").forEach(bindOption);
  search.addEventListener("input", filterOptions);
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const typed = search.value.trim();
    if (allowCreate && typed) {
      event.preventDefault();
      const existing = [...root.querySelectorAll(".multi-picker-option")]
        .find((option) => option.dataset.value.localeCompare(typed, "pt-BR", { sensitivity: "accent" }) === 0);
      if (existing) {
        existing.classList.add("active");
      } else {
        root.querySelector(".multi-picker-empty")?.remove();
        const option = document.createElement("button");
        option.type = "button";
        option.className = "multi-picker-option active";
        option.dataset.value = typed;
        option.dataset.label = typed;
        option.dataset.search = typed;
        const label = document.createElement("span");
        label.textContent = typed;
        const check = document.createElement("b");
        check.textContent = "✓";
        option.append(label, check);
        root.querySelector(".multi-picker-options").appendChild(option);
        bindOption(option);
      }
      drawSelection();
      root.dispatchEvent(new CustomEvent("multi-picker-change"));
      search.value = "";
      filterOptions();
      search.focus();
      return;
    }
    const first = [...root.querySelectorAll(".multi-picker-option:not([hidden])")][0];
    if (first) { event.preventDefault(); first.click(); search.value = ""; filterOptions(); search.focus(); }
  });
}

function singleSearchPickerHtml(id, options, value, placeholder) {
  const selected = options.find((option) => String(option.value) === String(value || ""));
  const rows = options.map((option) => `<button type="button" class="single-search-option" data-value="${esc(option.value)}" data-label="${esc(option.label)}" data-search="${esc(option.search || [option.label, option.detail, option.value].filter(Boolean).join(" "))}" hidden><span>${esc(option.label)}</span>${option.detail ? `<small>${esc(option.detail)}</small>` : ""}</button>`).join("");
  return `<div class="single-search-picker" id="${esc(id)}">
    <input class="single-search-input" type="search" value="${esc(selected?.label || "")}" placeholder="${esc(placeholder || "Buscar...")}" autocomplete="off">
    <input type="hidden" data-k="${esc(id.replace(/^form-/, ""))}" value="${esc(value || "")}">
    <div class="single-search-menu" hidden><div class="single-search-hint">Digite o nome ou CNPJ.</div>${rows}</div>
  </div>`;
}

function wireSingleSearchPicker(id) {
  const root = document.getElementById(id);
  if (!root) return;
  const input = root.querySelector(".single-search-input");
  const hidden = root.querySelector('input[type="hidden"]');
  const menu = root.querySelector(".single-search-menu");
  const options = [...root.querySelectorAll(".single-search-option")];
  const setHiddenValue = (value) => {
    const next = String(value || "");
    if (hidden.value === next) return;
    hidden.value = next;
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const filter = () => {
    const query = input.value.trim().toLocaleLowerCase("pt-BR");
    const queryDigits = query.replace(/\D/g, "");
    let visible = 0;
    options.forEach((option) => {
      const haystack = [option.dataset.label, option.dataset.value, option.dataset.search].join(" ").toLocaleLowerCase("pt-BR");
      const digitMatch = queryDigits.length >= 3 && option.dataset.value.replace(/\D/g, "").includes(queryDigits);
      option.hidden = !query || !(haystack.includes(query) || digitMatch);
      if (!option.hidden) visible++;
    });
    const exact = options.find((option) =>
      option.dataset.label.toLocaleLowerCase("pt-BR") === query
        || option.dataset.value.toLocaleLowerCase("pt-BR") === query
        || (queryDigits.length === 14 && option.dataset.value.replace(/\D/g, "") === queryDigits)
    );
    setHiddenValue(exact?.dataset.value || "");
    menu.hidden = !query;
    root.querySelector(".single-search-hint").textContent = visible ? "Selecione uma empresa." : "Nenhuma empresa encontrada.";
  };
  options.forEach((option) => option.addEventListener("click", () => {
    input.value = option.dataset.label;
    setHiddenValue(option.dataset.value);
    menu.hidden = true;
  }));
  input.addEventListener("input", filter);
  input.addEventListener("focus", filter);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = options.find((option) => !option.hidden);
    if (first) { event.preventDefault(); first.click(); }
  });
  root.addEventListener("focusout", () => setTimeout(() => { if (!root.contains(document.activeElement)) menu.hidden = true; }, 0));
}

document.addEventListener("click", (event) => {
  const referenceButton = event.target.closest(".task-reference-open");
  if (referenceButton) {
    event.preventDefault();
    event.stopPropagation();
    openTaskReference(referenceButton.dataset.referenceKind, referenceButton.dataset.referenceId);
    return;
  }
  if (event.target.closest(".multi-picker")) return;
  document.querySelectorAll(".multi-picker-menu:not([hidden])").forEach((menu) => {
    menu.hidden = true;
    menu.closest(".multi-picker")?.querySelector(".multi-picker-control")?.setAttribute("aria-expanded", "false");
  });
});

// Fluxo de status das tarefas: Em andamento não volta para Em aberto,
// Atendido e Cancelado só são reabertos por administradores e só
// administradores cancelam tarefas em aberto ou em andamento.
function taskStatusTransitionError(from = "todo", to = "todo") {
  if (!to || to === from) return "";
  const admin = currentUserIsAdmin();
  if (from === "done" && !admin) return "Tarefa Atendida só pode ser alterada por administradores.";
  if (from === "canceled" && !admin) return "Tarefa Cancelada só pode ser reaberta por administradores.";
  if (from === "doing" && to === "todo") return "Tarefa Em andamento não pode voltar para Em aberto.";
  if (to === "canceled" && ["todo", "doing"].includes(from) && !admin) return "Somente administradores podem cancelar tarefas.";
  return "";
}
const taskStatusLocked = (task) => ["done", "canceled"].includes(task?.status) && !currentUserIsAdmin();

function taskStatusOptions(selected = "todo", blocked = false, flow = false) {
  return TASK_STATUS.map((s) => {
    const disabled = (blocked && !["todo", "canceled"].includes(s.id)) || (flow && taskStatusTransitionError(selected, s.id));
    return `<option value="${s.id}"${s.id === selected ? " selected" : ""}${disabled ? " disabled" : ""}>${s.label}</option>`;
  }).join("");
}

function taskDependencies(task, tasks = loadProjectTasks()) {
  const ids = normalizeIdList(task.dependency_ids, task.depends_on_activity_id);
  return ids.map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
}

function taskDependency(task, tasks = loadProjectTasks()) {
  return taskDependencies(task, tasks)[0] || null;
}

function taskIsBlocked(task, tasks = loadProjectTasks()) {
  return taskDependencies(task, tasks).some((dependency) => dependency.status !== "done");
}

function taskCardHtml(task) {
  const allTasks = operationalProjectTasks(task.project_id);
  const owners = assigneeNames(task.assignee_ids, task.owner_id, task.assign_to_client);
  const objective = cache.deliveryObjectiveById?.[task.objective_id];
  const dependencies = taskDependencies(task, allTasks);
  const blocked = taskIsBlocked(task, allTasks);
  const checklist = checklistProgress(task.checklist);
  const parent = taskParent(task, allTasks);
  const subtasks = taskSubtaskProgress(task.id, allTasks);
  const terminal = subtasks.total === 0;
  return `<div class="task-card ${task.status === "done" ? "done" : ""}${blocked ? " blocked" : ""}${parent ? " subtask" : ""}" data-id="${esc(task.id)}">
    ${parent ? `<div class="task-parent-label">Subtarefa de ${esc(activityDisplayName(parent))}</div>` : ""}
    <input class="task-title-input" value="${esc(activityDisplayName(task))}" placeholder="Título da tarefa"${task.source_template_id ? ' readonly title="Tarefa definida no produto"' : ""}>
    <div>${badge(task.source_template_id ? "qualification" : "proposal", task.source_template_id ? "Produto" : "Dia a dia")} ${priorityBadge(task.priority)}</div>
    ${dependencies.length ? `<div class="task-dependency${blocked ? " blocked" : ""}">${blocked ? "Bloqueada por" : "Liberada após"}: ${esc(dependencyNames(task.dependency_ids, task.depends_on_activity_id))}</div>` : ""}
    ${task.information ? `<div class="task-information"><strong>Informação</strong><span>${esc(task.information)}</span></div>` : ""}
    ${objective ? `<div class="task-dependency">Objetivo: ${esc(objective.name)}</div>` : ""}
    ${(task.group || task.subgroup || task.sector || task.subsector || task.module || task.submodule || task.channel || task.type) ? `<div class="task-taxonomy">
      ${task.group ? `<span>${esc(task.group)}</span>` : ""}${task.subgroup ? `<span>${esc(task.subgroup)}</span>` : ""}${task.sector ? `<span>${esc(task.sector)}</span>` : ""}${task.subsector ? `<span>${esc(task.subsector)}</span>` : ""}
      ${task.module ? `<span>${esc(task.module)}</span>` : ""}${task.submodule ? `<span>${esc(task.submodule)}</span>` : ""}${task.channel ? `<span>${esc(task.channel)}</span>` : ""}${task.type ? `<span>${esc(task.type)}</span>` : ""}
    </div>` : ""}
    <div class="task-row">
      <span class="muted">${esc(owners)}</span>
      <span class="muted">${esc(taskPlannedStart(task) ? dt(taskPlannedStart(task)) : "—")} → ${esc(taskPlannedEnd(task) ? dt(taskPlannedEnd(task)) : "—")}</span>
    </div>
    ${taskCommentsButton(task)}
    ${terminal
      ? `<button class="btn checklist-open${checklist.total > 0 && checklist.done === checklist.total ? " complete" : ""}" data-id="${esc(task.id)}" type="button">Checklist ${checklist.done}/${checklist.total}</button>`
      : `<div class="task-subtask-summary">Subtarefas ${subtasks.done}/${subtasks.total} · checklist nas subtarefas</div>`}
    <div class="task-actions">
      <select class="task-status"${taskStatusLocked(task) ? ' title="Somente administradores alteram esta tarefa" disabled' : blocked ? ' title="Conclua a tarefa anterior para liberar"' : ""}>${taskStatusOptions(task.status || "todo", blocked, true)}</select>
      ${parent ? "" : '<button class="rowbtn task-add-subtask" title="Adicionar subtarefa">＋</button>'}
      <button class="rowbtn task-edit" title="Editar tarefa">✎</button>
      ${task.source_template_id ? '<span class="muted">Produto</span>' : '<button class="rowbtn del-task" title="Excluir tarefa">✕</button>'}
    </div>
  </div>`;
}

async function deleteDeliveryTask(projectId, id) {
  const allTasks = loadProjectTasks();
  const currentTask = allTasks.find((task) => task.id === id);
  if (!currentTask || currentTask.source_template_id) return;
  const descendants = taskDescendantIds(id, allTasks);
  const childCount = descendants.size;
  if (!window.confirm(childCount ? `Excluir esta tarefa e ${childCount} subtarefa(s)?` : "Excluir esta tarefa?")) return;
  try {
    const parent = taskParent(currentTask, allTasks);
    const siblings = parent ? taskSubtasks(parent.id, allTasks).filter((task) => task.id !== id) : [];
    if (parent && !siblings.length) {
      const changes = { checklist: normalizeChecklist(currentTask.checklist), updated_at: new Date().toISOString() };
      if (isLive()) await updateRow("activities", parent.id, changes);
      Object.assign(parent, changes);
    }
    if (isLive()) await deleteRow("activities", id);
    const removedIds = new Set([id, ...descendants]);
    const remaining = allTasks.filter((task) => !removedIds.has(task.id));
    if (isLive()) cache.activityRecords = remaining;
    else saveProjectTasks(remaining);
    refreshActivityCache();
    renderProjectBoard(projectId);
  } catch (err) { toast("Erro ao excluir tarefa · " + err.message, true); }
}

function openProjectBoard(projectId) {
  if (!requireCurrentUserPermission("projects", "view", "Entregas")) return;
  const project = (cache.projects || []).find((p) => p.id === projectId);
  if (!project) return;
  projectBoardState = { projectId, view: "table", section: "activities", search: "", page: 1, pageSize: 50, calendarCursor: null, sortKey: null, sortDir: 1, filters: {} };
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Conteúdo da entrega">
    <button class="modal-header-tab active" data-project-section="activities" role="tab">Tarefas</button>
    <button class="modal-header-tab" data-project-section="objectives" role="tab">Objetivos</button>
    <button class="modal-header-tab" data-project-section="goals" role="tab">Metas</button>
    <button class="modal-header-tab" data-project-section="data" role="tab">Dados</button>
  </div>`;
  shell(`Entrega · ${project.name || "Sem nome"}`, `<div id="project-board-root" class="full-body"></div>`, {
    cls: "full registrations-modal",
    headerCenter,
    headerActions: liveRefreshButtonHtml(),
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CMS</b></span>'
  });
  document.querySelectorAll("[data-project-section]").forEach((button) => button.addEventListener("click", () => {
    projectBoardState.section = button.dataset.projectSection;
    projectBoardState.view = "table";
    projectBoardState.search = "";
    projectBoardState.page = 1;
    projectBoardState.sortKey = null;
    projectBoardState.sortDir = 1;
    projectBoardState.filters = {};
    document.querySelectorAll("[data-project-section]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderProjectBoard(projectId);
  }));
  renderProjectBoard(projectId);
}

function deliveryContinuityChain(project) {
  const chain = [];
  const visited = new Set();
  let current = project;
  while (current && !visited.has(current.id)) {
    chain.unshift(current);
    visited.add(current.id);
    current = current.continuation_of_id ? cache.projects.find((item) => item.id === current.continuation_of_id) : null;
  }
  return chain;
}

function deliveryMetricsTotal(project) {
  return normalizeProjectBusinessMetrics(project?.business_metrics).reduce((total, row) => total + projectMetricRevenue(row), 0);
}

function deliveryContinuityHistoryHtml(chain, currentId) {
  const previous = chain.filter((item) => item.id !== currentId);
  if (!previous.length) return "";
  const rows = previous.flatMap((delivery) => {
    const metrics = normalizeProjectBusinessMetrics(delivery.business_metrics);
    if (!metrics.length) return [`<tr><td>${esc(delivery.name || delivery.client_name || "Entrega")}</td><td>—</td><td>${brl(0)}</td><td>—</td><td>—</td><td>Sem dados mensais.</td></tr>`];
    return metrics.map((metric) => {
      const month = new Date(`${metric.month}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      const suppliers = companyNames(metric.supplier_company_ids, cache);
      return `<tr><td>${esc(delivery.name || delivery.client_name || "Entrega")}</td><td>${esc(month)}</td><td>${brl(projectMetricRevenue(metric))}</td><td>${metric.skus == null ? "—" : esc(metric.skus)}</td><td>${esc(suppliers)}</td><td>${esc(metric.observations || "—")}</td></tr>`;
    });
  }).join("");
  return `<section class="project-continuity-history"><strong>Histórico da continuidade</strong><div class="business-metrics-table"><table><thead><tr><th>ENTREGA</th><th>MÊS</th><th>FATURAMENTO</th><th>SKUs</th><th>FORNECEDORES</th><th>OBSERVAÇÕES</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderProjectDataModule(project) {
  const client = cache.companyById[project.company_id]?.legal_name || "Sem cliente";
  const product = cache.productById[project.product_id]?.name || "Sem produto";
  const chain = deliveryContinuityChain(project);
  const channels = projectRevenueChannels(project);
  const currentTotal = deliveryMetricsTotal(project);
  const historyTotal = chain.reduce((total, item) => total + deliveryMetricsTotal(item), 0);
  return `<div class="project-data-module">
    <div class="project-data-header"><div><strong>Dados mensais do negócio</strong><span>${esc(client)} · ${esc(product)}</span></div><button class="btn primary" id="project-data-save">Salvar dados</button></div>
    <div class="project-data-period"><span>Período da entrega</span><strong>${project.start_date ? dt(project.start_date) : "—"} a ${project.end_date ? dt(project.end_date) : "—"}</strong></div>
    <div class="project-data-summary"><div><span>Faturamento desta entrega</span><strong id="project-current-revenue">${brl(currentTotal)}</strong></div><div><span>Faturamento da continuidade</span><strong id="project-chain-revenue">${brl(historyTotal)}</strong></div><div><span>Entregas acompanhadas</span><strong>${chain.length}</strong></div></div>
    ${deliveryContinuityHistoryHtml(chain, project.id)}
    <div id="project-business-metrics">${projectBusinessMetricsHtml(project.business_metrics, project.start_date, project.end_date, cache, channels)}</div>
  </div>`;
}

function wireProjectDataModule(project) {
  projectMonthKeys(project.start_date, project.end_date, project.business_metrics)
    .forEach((month) => wireMultiPicker(`business-suppliers-${month}`));
  const refreshTotals = () => {
    let grandTotal = 0;
    const channelTotals = new Map();
    document.querySelectorAll("[data-business-month]").forEach((row) => {
      let monthTotal = 0;
      row.querySelectorAll(".business-channel-revenue").forEach((input) => {
        const value = Number(input.value || 0);
        monthTotal += value;
        channelTotals.set(input.dataset.businessChannel, (channelTotals.get(input.dataset.businessChannel) || 0) + value);
      });
      grandTotal += monthTotal;
      const totalCell = row.querySelector("[data-business-month-total]");
      if (totalCell) totalCell.textContent = brl(monthTotal);
    });
    document.querySelectorAll("[data-business-channel-total]").forEach((cell) => { cell.textContent = brl(channelTotals.get(cell.dataset.businessChannelTotal) || 0); });
    const grandCell = document.querySelector("[data-business-grand-total]");
    if (grandCell) grandCell.textContent = brl(grandTotal);
    const currentCell = document.getElementById("project-current-revenue");
    if (currentCell) currentCell.textContent = brl(grandTotal);
    const chainCell = document.getElementById("project-chain-revenue");
    if (chainCell) chainCell.textContent = brl(deliveryContinuityChain(project).filter((item) => item.id !== project.id).reduce((total, item) => total + deliveryMetricsTotal(item), 0) + grandTotal);
  };
  document.querySelectorAll(".business-channel-revenue").forEach((input) => input.addEventListener("input", refreshTotals));
  document.getElementById("project-data-save")?.addEventListener("click", async (event) => {
    if (!requireCurrentUserPermission("projects", "edit", "Entregas")) return;
    const button = event.currentTarget;
    const metrics = readProjectBusinessMetrics(document.getElementById("project-board-root"));
    button.disabled = true;
    button.textContent = "Salvando...";
    try {
      const saved = isLive() ? await updateRow("projects", project.id, { business_metrics: metrics, updated_at: new Date().toISOString() }) : { ...project, business_metrics: metrics };
      Object.assign(project, saved, { business_metrics: metrics });
      toast("Dados mensais atualizados.");
    } catch (error) {
      toast("Erro ao salvar dados mensais · " + error.message, true);
    } finally {
      if (button.isConnected) { button.disabled = false; button.textContent = "Salvar dados"; }
    }
  });
}

function renderTaskMatrix(tasks) {
  return `<div class="task-columns">${TASK_STATUS.map((status) => {
    const items = tasks.filter((task) => (task.status || "todo") === status.id);
    return `<section class="task-col" data-status="${status.id}">
      <h4>${status.label}<span>${items.length}</span></h4>
      <div class="task-list">${items.map(taskCardHtml).join("") || '<div class="empty" style="padding:22px 8px">Sem tarefas.</div>'}</div>
    </section>`;
  }).join("")}</div>`;
}

function renderTaskTable(tasks) {
  const allTasks = operationalProjectTasks(projectBoardState.projectId);
  const totalPages = Math.max(1, Math.ceil(tasks.length / projectBoardState.pageSize));
  projectBoardState.page = Math.min(Math.max(1, projectBoardState.page || 1), totalPages);
  const start = (projectBoardState.page - 1) * projectBoardState.pageSize;
  const pageRows = tasks.slice(start, start + projectBoardState.pageSize);
  const rows = pageRows.map((task) => {
    const checklist = checklistProgress(task.checklist);
    const parent = taskParent(task, allTasks);
    const subtasks = taskSubtaskProgress(task.id, allTasks);
    const terminal = subtasks.total === 0;
    return `<tr class="${parent ? "task-subtask-row" : "task-root-row"}"${parent ? ` data-expand-parent="${esc(parent.id)}"` : ` data-expand-id="${esc(task.id)}"`}>
      <td><span class="task-table-title">${parent ? '<span class="task-subtask-branch">↳</span>' : ""}<span>${esc(activityDisplayName(task))}</span>${parent ? '<small>Subtarefa</small>' : ""}</span></td>
      <td>${badge(task.source_template_id ? "qualification" : "proposal", task.source_template_id ? "Produto" : "Dia a dia")}</td>
      <td>${priorityBadge(task.priority)}</td>
      <td class="compact-multi-cell">${stackedCell(dependencyNameList(task.dependency_ids, task.depends_on_activity_id, tasks))}</td>
      <td>${esc(task.information || "—")}</td>
      <td>${esc(task.group || "—")}</td>
      <td>${esc(task.subgroup || "—")}</td>
      <td>${esc(task.sector || "—")}</td>
      <td>${esc(task.subsector || "—")}</td>
      <td>${esc(task.module || "—")}</td>
      <td>${esc(task.submodule || "—")}</td>
      <td>${esc(task.category || "—")}</td>
      <td>${esc(task.channel || "—")}</td>
      <td>${esc(task.type || "—")}</td>
      <td>${esc(RECURRENCE_LABEL[task.recurrence] || "Única")}</td>
      <td>${task.consider_business_days ? "Sim" : "Não"}</td>
      <td>${terminal ? `<button class="btn checklist-open${checklist.total > 0 && checklist.done === checklist.total ? " complete" : ""}" data-id="${esc(task.id)}">${checklist.done}/${checklist.total}</button>` : '<span class="muted">Nas subtarefas</span>'}</td>
      <td>${parent ? "—" : `${subtasks.done}/${subtasks.total}`}</td>
      <td>${esc(cache.deliveryObjectiveById?.[task.objective_id]?.name || "—")}</td>
      <td class="compact-multi-cell">${stackedCell(responsibilityNameList(task.assignee_ids, task.owner_id, task.assignee_job_titles, task.assign_to_client))}</td>
      <td>${taskReferencesHtml(task)}</td>
      <td>${esc(taskPlannedStart(task) ? dt(taskPlannedStart(task)) : "—")}</td>
      <td>${esc(taskPlannedEnd(task) ? dt(taskPlannedEnd(task)) : "—")}</td>
      <td>${esc(task.actual_start_date ? dt(task.actual_start_date) : "—")}</td>
      <td>${esc(task.actual_end_date ? dt(task.actual_end_date) : "—")}</td>
      <td>${inlineTaskStatus(task, "project-inline-task-status")}</td>
      <td>${taskDeadlineBadge(task)}</td>
      <td>${taskCommentsButton(task)}</td>
      <td class="table-actions-cell">${tableActionButtons({
        open: terminal && checklist.total ? { className: "checklist-open", attrs: { "data-id": task.id }, title: "Abrir checklist" } : null,
        edit: { className: "task-edit", attrs: { "data-id": task.id }, title: "Editar tarefa" },
        delete: !task.source_template_id ? { className: "task-delete-table", attrs: { "data-id": task.id }, title: "Excluir tarefa" } : null
      })}</td>
    </tr>`;
  }).join("");
  return `<div class="task-table-shell"><div class="task-table-wrap">
    <table><thead><tr>
      <th>Tarefa</th><th>Origem</th><th>Prioridade</th><th class="compact-multi-cell">Depende de</th><th>Informação</th><th>Grupo</th><th>Subgrupo</th><th>Setor</th><th>Subsetor</th><th>Módulo</th><th>Submódulo</th><th>Categoria</th><th>Canal</th><th>Tipo</th><th>Recorrência</th><th>Dias úteis</th><th>Checklist</th><th>Subtarefas</th><th>Objetivo</th><th class="compact-multi-cell">Responsáveis</th><th>Referências</th><th>Início previsto</th><th>Término previsto</th><th>Início real</th><th>Término real</th><th>Status</th><th>Prazo</th><th>Comentários</th>${tableActionsHead()}
    </tr></thead><tbody>${rows || '<tr><td colspan="29" class="empty">Sem tarefas.</td></tr>'}</tbody></table>
  </div><div class="table-pagination"><span>${tasks.length ? `${start + 1}-${Math.min(start + projectBoardState.pageSize, tasks.length)} de ${tasks.length}` : "0 registros"}</span>
    <div><button class="btn" id="project-page-prev"${projectBoardState.page <= 1 ? " disabled" : ""}>‹</button><span>Página ${projectBoardState.page} de ${totalPages}</span><button class="btn" id="project-page-next"${projectBoardState.page >= totalPages ? " disabled" : ""}>›</button></div>
  </div></div>`;
}

function renderProjectTaskCalendar(tasks) {
  const cursor = projectBoardState.calendarCursor ? dateOnly(`${projectBoardState.calendarCursor}-01`) : new Date();
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
  projectBoardState.calendarCursor = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const byDay = new Map();
  tasks.filter((task) => dateOnly(taskPlannedEnd(task))).forEach((task) => {
    const key = String(taskPlannedEnd(task)).slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(task);
  });
  const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
  const today = isoDay(new Date());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = isoDay(date);
    return `<div class="calendar-day${date.getMonth() !== monthStart.getMonth() ? " outside" : ""}${key === today ? " today" : ""}">
      <span class="calendar-date">${date.getDate()}</span>${(byDay.get(key) || []).map((task) => `<button class="calendar-item project-calendar-item" data-id="${esc(task.id)}">${esc(activityDisplayName(task))}</button>`).join("")}
    </div>`;
  }).join("");
  return `<div class="calendar-view"><div class="calendar-toolbar"><strong>${monthStart.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong>
    <div class="calendar-nav"><button class="btn" id="project-calendar-prev">‹</button><button class="btn" id="project-calendar-today">Hoje</button><button class="btn" id="project-calendar-next">›</button></div>
  </div><div class="calendar-grid">${weekdays}${days}</div></div>`;
}

function renderProjectTaskGantt(tasks) {
  const items = tasks.filter((task) => dateOnly(taskPlannedStart(task) || taskPlannedEnd(task))).map((task) => ({
    id: task.id,
    title: activityDisplayName(task),
    detail: taskStatusLabel(task.status),
    start: taskPlannedStart(task) || taskPlannedEnd(task),
    end: taskPlannedEnd(task) || taskPlannedStart(task),
    status: task.status
  }));
  if (!items.length) return '<div class="empty">Nenhuma tarefa com prazo para exibir no Gantt.</div>';
  return ganttTimelineMarkup(items, "Tarefa", "project-gantt-item");
}

function renderDeliveryObjectives(projectId, tasks, sourceRows = null) {
  const objectives = sourceRows || loadDeliveryObjectives().filter((item) => item.project_id === projectId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const rows = objectives.map((objective) => {
    const linked = tasks.filter((task) => task.objective_id === objective.id);
    const done = linked.filter((task) => task.status === "done").length;
    const progress = linked.length ? Math.round((done / linked.length) * 100) : 0;
    const dependencyState = deliveryObjectiveDependencyState(objective);
    const dependencyLabel = deliveryObjectiveDependencyLabel(objective);
    return `<tr data-objective-id="${esc(objective.id)}">
      <td><strong>${esc(objective.name)}</strong></td>
      <td>${esc(objective.category || "—")}</td>
      <td>${esc(objective.channel || "—")}</td>
      <td>${esc(objective.completion_criteria || "—")}</td>
      <td>${esc(objective.comments || "—")}</td>
      <td>${esc(objective.notes || "—")}</td>
      <td>${done}/${linked.length} · ${progress}%</td>
      <td>${esc(dependencyLabel)}${dependencyState.blocked ? '<div class="muted">Aguardando dependências</div>' : ""}</td>
      <td>${multiPickerHtml(`delivery-objective-assignees-${objective.id}`, assigneePickerOptions(objective.assignee_ids), assigneePickerSelection(objective.assignee_ids, objective.owner_id, objective.assign_to_client), "Selecionar responsáveis")}</td>
      <td><input class="objective-control delivery-objective-due" type="date" value="${esc(objective.due_date || "")}"></td>
      <td><select class="objective-control delivery-objective-status">${taskStatusOptions(objective.status || "todo")}</select></td>
      <td class="table-actions-cell">${tableActionButtons()}</td>
    </tr>`;
  }).join("");
  return `<div class="task-table-wrap"><table><thead><tr>
    <th>Objetivo</th><th>Categoria</th><th>Canal</th><th>Critério de conclusão</th><th>Comentários</th><th>Observações</th><th>Progresso das tarefas</th><th>Depende de</th><th>Responsável</th><th>Prazo</th><th>Status</th>${tableActionsHead()}
  </tr></thead><tbody>${rows || '<tr><td colspan="12" class="empty">Esta entrega ainda não possui objetivos.</td></tr>'}</tbody></table></div>`;
}

function deliveryObjectiveDependencyState(objective) {
  const objectives = loadDeliveryObjectives();
  const tasks = operationalProjectTasks(objective.project_id);
  const dependencyObjectives = normalizeIdList(objective.dependency_objective_ids)
    .map((id) => objectives.find((item) => item.id === id)).filter(Boolean);
  const dependencyActivities = normalizeIdList(objective.dependency_activity_ids)
    .map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
  const pendingObjectives = dependencyObjectives.filter((item) => item.status !== "done");
  const pendingActivities = dependencyActivities.filter((item) => item.status !== "done");
  return { dependencyObjectives, dependencyActivities, pendingObjectives, pendingActivities, blocked: Boolean(pendingObjectives.length || pendingActivities.length) };
}

function deliveryObjectiveDependencyLabel(objective) {
  const state = deliveryObjectiveDependencyState(objective);
  return [
    ...state.dependencyObjectives.map((item) => item.name),
    ...state.dependencyActivities.map(activityDisplayName)
  ].join(", ") || "—";
}

function deliveryGoalReached(goal, value = Number(goal.current_value || 0)) {
  const target = Number(goal.target_value || 0);
  if (goal.comparison === "at_most") return value <= target;
  if (goal.comparison === "exactly") return value === target;
  return value >= target;
}

function deliveryGoalDependencyState(goal) {
  const goals = loadDeliveryGoals();
  const tasks = operationalProjectTasks(goal.project_id);
  const dependencyGoals = normalizeIdList(goal.dependency_goal_ids)
    .map((id) => goals.find((item) => item.id === id)).filter(Boolean);
  const dependencyActivities = normalizeIdList(goal.dependency_activity_ids)
    .map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
  const pendingGoals = dependencyGoals.filter((item) => item.status !== "done");
  const pendingActivities = dependencyActivities.filter((item) => item.status !== "done");
  return { dependencyGoals, dependencyActivities, pendingGoals, pendingActivities, blocked: Boolean(pendingGoals.length || pendingActivities.length) };
}

function deliveryGoalDependencyLabel(goal) {
  const state = deliveryGoalDependencyState(goal);
  const names = [
    ...state.dependencyGoals.map((item) => item.name),
    ...state.dependencyActivities.map(activityDisplayName)
  ];
  return names.join(", ") || "—";
}

function renderDeliveryGoals(projectId, sourceRows = null) {
  const goals = sourceRows || loadDeliveryGoals().filter((item) => item.project_id === projectId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const rows = goals.map((goal) => {
    const current = Number(goal.current_value || 0);
    const target = Number(goal.target_value || 0);
    const progress = target ? Math.max(0, Math.min(100, Math.round(current / target * 100))) : 0;
    const targetLabel = `${GOAL_COMPARISON_LABEL[goal.comparison] || "No mínimo"} ${target.toLocaleString("pt-BR")} ${goal.unit || ""}`.trim();
    const dependencyState = deliveryGoalDependencyState(goal);
    const dependencyLabel = deliveryGoalDependencyLabel(goal);
    return `<tr data-goal-id="${esc(goal.id)}">
      <td><strong>${esc(goal.name)}</strong></td><td>${esc(goal.category || "—")}</td><td>${esc(goal.channel || "—")}</td><td>${esc(goal.metric)}</td>
      <td><input class="objective-control delivery-goal-current" type="number" step="any" value="${esc(current)}"></td>
      <td>${esc(targetLabel)}</td><td>${esc(goal.comments || "—")}</td><td>${esc(goal.notes || "—")}</td><td>${progress}%</td><td>${esc(dependencyLabel)}${dependencyState.blocked ? '<div class="muted">Aguardando dependências</div>' : ""}</td>
      <td>${multiPickerHtml(`delivery-goal-assignees-${goal.id}`, assigneePickerOptions(goal.assignee_ids), assigneePickerSelection(goal.assignee_ids, goal.owner_id, goal.assign_to_client), "Selecionar responsáveis")}</td>
      <td><input class="objective-control delivery-goal-due" type="date" value="${esc(goal.due_date || "")}"></td>
      <td><select class="objective-control delivery-goal-status">${taskStatusOptions(goal.status || "todo")}</select></td>
      <td class="table-actions-cell">${tableActionButtons()}</td>
    </tr>`;
  }).join("");
  return `<div class="task-table-shell"><div class="task-table-wrap"><table><thead><tr>
    <th>Meta</th><th>Categoria</th><th>Canal</th><th>Indicador</th><th>Valor atual</th><th>Valor-alvo</th><th>Comentários</th><th>Observações</th><th>Progresso</th><th>Depende de</th><th>Responsável</th><th>Prazo</th><th>Status</th>${tableActionsHead()}
  </tr></thead><tbody>${rows || '<tr><td colspan="14" class="empty">Esta entrega ainda não possui metas.</td></tr>'}</tbody></table></div>
  <div class="table-pagination"><span>${goals.length} meta(s)</span><div><span>Acompanhamento da entrega</span></div></div></div>`;
}

function renderTaskDashboard(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const doing = tasks.filter((t) => t.status === "doing").length;
  const overdue = tasks.filter((t) => taskPlannedEnd(t) && !["done", "canceled"].includes(t.status) && taskPlannedEnd(t) < new Date().toISOString().slice(0, 10)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="project-dashboard">
    <div class="metric"><div class="k">Tarefas</div><div class="v">${total}</div></div>
    <div class="metric"><div class="k">Em andamento</div><div class="v">${doing}</div></div>
    <div class="metric"><div class="k">Concluídas</div><div class="v">${done}</div></div>
    <div class="metric"><div class="k">Atrasadas</div><div class="v">${overdue}</div></div>
    <div class="metric"><div class="k">Progresso</div><div class="v">${pct}%</div></div>
  </div>`;
}

function renderDeliveryStatusMatrix(rows, kind, tasks = []) {
  return `<div class="task-columns">${TASK_STATUS.map((status) => {
    const items = rows.filter((item) => (item.status || "todo") === status.id);
    const cards = items.map((item) => {
      if (kind === "objectives") {
        const linked = tasks.filter((task) => task.objective_id === item.id);
        const done = linked.filter((task) => task.status === "done").length;
        return `<article class="task-card"><strong>${esc(item.name || "Objetivo")}</strong><span class="muted">${esc(item.completion_criteria || "Sem critério")}</span><span>${done}/${linked.length} tarefa(s)</span></article>`;
      }
      return `<article class="task-card"><strong>${esc(item.name || "Meta")}</strong><span class="muted">${esc(item.metric || "Sem indicador")}</span><span>${Number(item.current_value || 0).toLocaleString("pt-BR")} / ${Number(item.target_value || 0).toLocaleString("pt-BR")} ${esc(item.unit || "")}</span></article>`;
    }).join("");
    return `<section class="task-col"><h4>${status.label}<span>${items.length}</span></h4><div class="task-list">${cards || '<div class="empty" style="padding:22px 8px">Sem itens.</div>'}</div></section>`;
  }).join("")}</div>`;
}

function deliveryGoalPercent(goal) {
  if (goal.__percent != null) return goal.__percent;
  const current = Number(goal.current_value || 0);
  const target = Number(goal.target_value || 0);
  if (deliveryGoalReached(goal, current)) return 100;
  if (goal.comparison === "at_most") return current ? Math.max(0, Math.min(99, Math.round(target / current * 100))) : 0;
  if (goal.comparison === "exactly") return target || current ? Math.max(0, Math.min(99, Math.round(Math.min(current, target) / Math.max(current, target) * 100))) : 0;
  return target ? Math.max(0, Math.min(99, Math.round(current / target * 100))) : 0;
}

function deliveryObjectivePercent(objective, tasks) {
  if (objective.__percent != null) return objective.__percent;
  if (objective.status === "done") return 100;
  const linked = tasks.filter((task) => task.objective_id === objective.id);
  return linked.length ? Math.round(linked.filter((task) => task.status === "done").length / linked.length * 100) : 0;
}

function dashboardBarHtml(percent, tone = "") {
  return `<div class="okr-bar${tone ? ` ${tone}` : ""}"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div><b class="okr-percent">${percent}%</b>`;
}

function deliveryOkrBoardHtml(objectives, goals, tasks) {
  const key = (item) => [item.category, item.channel].map((value) => String(value || "").trim().toLocaleUpperCase("pt-BR")).join(" · ") || "—";
  const label = (item) => [item.category || "Sem categoria", item.channel || "Sem canal"].join(" · ");
  const groups = new Map();
  const ensure = (item) => {
    const id = key(item);
    if (!groups.has(id)) groups.set(id, { label: label(item), objectives: [], goals: [] });
    return groups.get(id);
  };
  objectives.forEach((objective) => ensure(objective).objectives.push(objective));
  goals.forEach((goal) => ensure(goal).goals.push(goal));
  if (!groups.size) return '<div class="empty">Cadastre objetivos e metas para montar o OKR.</div>';
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="okr-board">${[...groups.values()].map((group) => {
    const krPercents = group.goals.map(deliveryGoalPercent);
    const objectivePercents = group.objectives.map((objective) => deliveryObjectivePercent(objective, tasks));
    const overall = krPercents.length ? Math.round(krPercents.reduce((a, b) => a + b, 0) / krPercents.length)
      : objectivePercents.length ? Math.round(objectivePercents.reduce((a, b) => a + b, 0) / objectivePercents.length) : 0;
    return `<section class="okr-card">
      <header><span>${esc(group.label)}</span>${dashboardBarHtml(overall, overall >= 100 ? "is-done" : "")}</header>
      <div class="okr-section"><span class="okr-tag">O</span><div class="okr-list">${group.objectives.map((objective) => {
        const percent = deliveryObjectivePercent(objective, tasks);
        const late = objective.due_date && objective.status !== "done" && objective.due_date < today;
        return `<div class="okr-item"><strong>${esc(objective.name || "Objetivo")}</strong><small>${objective.__subtitle ? esc(objective.__subtitle) : `${esc(mindMapStatusLabel(objective))}${objective.due_date ? ` · ${dt(objective.due_date)}` : ""}${late ? ' · <em class="okr-late">Atrasado</em>' : ""}`}</small>${dashboardBarHtml(percent, percent >= 100 ? "is-done" : "")}</div>`;
      }).join("") || '<span class="muted">Sem objetivo nesta Categoria/Canal</span>'}</div></div>
      <div class="okr-section"><span class="okr-tag is-kr">KR</span><div class="okr-list">${group.goals.map((goal) => {
        const percent = deliveryGoalPercent(goal);
        const target = `${GOAL_COMPARISON_LABEL[goal.comparison] || "No mínimo"} ${Number(goal.target_value || 0).toLocaleString("pt-BR")} ${goal.unit || ""}`.trim();
        return `<div class="okr-item"><strong>${esc(goal.name || "Meta")}</strong><small>${goal.__subtitle ? `${esc(goal.__subtitle)} · alvo ${esc(target)}` : `${esc(goal.metric || "Sem indicador")} · ${Number(goal.current_value || 0).toLocaleString("pt-BR")} / ${esc(target)}`}</small>${dashboardBarHtml(percent, percent >= 100 ? "is-done" : "")}</div>`;
      }).join("") || '<span class="muted">Sem metas (resultados-chave) nesta Categoria/Canal</span>'}</div></div>
    </section>`;
  }).join("")}</div>`;
}

function renderDeliverySectionDashboard(rows, kind, tasks = []) {
  const projectId = projectBoardState.projectId;
  const objectives = kind === "objectives" ? rows : loadDeliveryObjectives().filter((item) => item.project_id === projectId);
  const goals = kind === "goals" ? rows : loadDeliveryGoals().filter((item) => item.project_id === projectId);
  const today = new Date().toISOString().slice(0, 10);
  const done = rows.filter((item) => item.status === "done").length;
  const doing = rows.filter((item) => item.status === "doing").length;
  const blocked = rows.filter((item) => kind === "objectives" ? deliveryObjectiveDependencyState(item).blocked : deliveryGoalDependencyState(item).blocked).length;
  const overdue = rows.filter((item) => item.due_date && item.status !== "done" && item.due_date < today).length;
  const average = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const metric = (label, value, hint = "") => `<div class="metric"><div class="k">${label}</div><div class="v">${value}</div>${hint ? `<div class="metric-hint">${hint}</div>` : ""}</div>`;
  const cards = kind === "objectives"
    ? [
      metric("Objetivos", rows.length),
      metric("Progresso médio", `${average(rows.map((item) => deliveryObjectivePercent(item, tasks)))}%`, "Tarefas concluídas dos objetivos"),
      metric("Concluídos", done, rows.length ? `${Math.round(done / rows.length * 100)}% do total` : ""),
      metric("Em andamento", doing),
      metric("Bloqueados", blocked),
      metric("Atrasados", overdue),
      metric("Tarefas vinculadas", tasks.filter((task) => rows.some((item) => item.id === task.objective_id)).length)
    ]
    : [
      metric("Metas (KPIs)", rows.length),
      metric("Atingimento médio", `${average(rows.map(deliveryGoalPercent))}%`, "Valor atual x valor-alvo"),
      metric("Metas atingidas", rows.filter((goal) => deliveryGoalReached(goal)).length, rows.length ? `${Math.round(rows.filter((goal) => deliveryGoalReached(goal)).length / rows.length * 100)}% do total` : ""),
      metric("Em andamento", doing),
      metric("Bloqueadas", blocked),
      metric("Atrasadas", overdue)
    ];
  const kpis = kind === "goals" && rows.length ? `<section class="dashboard-block"><h4>KPIs</h4><div class="kpi-list">${rows.map((goal) => {
    const percent = deliveryGoalPercent(goal);
    const target = `${GOAL_COMPARISON_LABEL[goal.comparison] || "No mínimo"} ${Number(goal.target_value || 0).toLocaleString("pt-BR")} ${goal.unit || ""}`.trim();
    return `<div class="kpi-row"><div><strong>${esc(goal.name || "Meta")}</strong><small>${esc(goal.metric || "Sem indicador")}</small></div><span class="kpi-values">${Number(goal.current_value || 0).toLocaleString("pt-BR")} <small>/ ${esc(target)}</small></span>${dashboardBarHtml(percent, percent >= 100 ? "is-done" : "")}</div>`;
  }).join("")}</div></section>` : "";
  return `<div class="delivery-dashboard"><div class="project-dashboard">${cards.join("")}</div>${kpis}<section class="dashboard-block"><h4>OKR <small>Objetivos (O) e Resultados-chave (KR) ligados pela mesma Categoria e Canal</small></h4>${deliveryOkrBoardHtml(objectives, goals, tasks)}</section></div>`;
}

function projectSectionRows(projectId, section = projectBoardState.section) {
  if (section === "objectives") return loadDeliveryObjectives().filter((item) => item.project_id === projectId);
  if (section === "goals") return loadDeliveryGoals().filter((item) => item.project_id === projectId);
  return projectTasks(projectId);
}

const PROJECT_TABLE_LABELS = {
  activities: ["Tarefa", "Origem", "Prioridade", "Depende de", "Informação", "Grupo", "Subgrupo", "Setor", "Subsetor", "Módulo", "Submódulo", "Categoria", "Canal", "Tipo", "Recorrência", "Dias úteis", "Checklist", "Subtarefas", "Objetivo", "Responsáveis", "Referências", "Início previsto", "Término previsto", "Início real", "Término real", "Status", "Prazo", "Comentários"],
  objectives: ["Objetivo", "Categoria", "Canal", "Critério de conclusão", "Comentários", "Observações", "Progresso das tarefas", "Depende de", "Responsável", "Prazo", "Status"],
  goals: ["Meta", "Categoria", "Canal", "Indicador", "Valor atual", "Valor-alvo", "Comentários", "Observações", "Progresso", "Depende de", "Responsável", "Prazo", "Status"]
};

function projectSectionValues(item, tasks = []) {
  if (projectBoardState.section === "activities") {
    const checklist = checklistProgress(item.checklist);
    const subtasks = taskSubtaskProgress(item.id, tasks);
    return [
      activityDisplayName(item),
      item.source_template_id ? "Produto" : "Dia a dia",
      PRIORITY_LABEL[item.priority || "normal"] || "Normal",
      dependencyNames(item.dependency_ids, item.depends_on_activity_id, tasks),
      item.information || "—", item.group || "—", item.subgroup || "—", item.sector || "—", item.subsector || "—", item.module || "—", item.submodule || "—", item.category || "—", item.channel || "—", item.type || "—", RECURRENCE_LABEL[item.recurrence] || "Única", item.consider_business_days ? "Sim" : "Não",
      subtasks.total ? "Nas subtarefas" : `${checklist.done}/${checklist.total}`,
      item.parent_activity_id ? "—" : `${subtasks.done}/${subtasks.total}`,
      cache.deliveryObjectiveById?.[item.objective_id]?.name || "—",
      responsibilityNames(item.assignee_ids, item.owner_id, item.assignee_job_titles, item.assign_to_client),
      [...normalizeIdList(item.document_ids).map((id) => taskDocumentOptions().find((option) => option.value === id)?.label || "Documento"), ...normalizeIdList(item.custom_table_ids).map((id) => taskTableOptions().find((option) => option.value === id)?.label || "Tabela")].join(", ") || "—",
      taskPlannedStart(item) ? dt(taskPlannedStart(item)) : "—",
      taskPlannedEnd(item) ? dt(taskPlannedEnd(item)) : "—",
      item.actual_start_date ? dt(item.actual_start_date) : "—",
      item.actual_end_date ? dt(item.actual_end_date) : "—",
      taskStatusLabel(item.status || "todo"),
      taskDeadlineState(item) || "—",
      `${taskCommentCount(item)} comentário(s)`
    ];
  }
  if (projectBoardState.section === "objectives") {
    const linked = tasks.filter((task) => task.objective_id === item.id);
    const done = linked.filter((task) => task.status === "done").length;
    const progress = linked.length ? Math.round(done / linked.length * 100) : 0;
    return [
      item.name || "—", item.category || "—", item.channel || "—", item.completion_criteria || "—", item.comments || "—", item.notes || "—", `${done}/${linked.length} · ${progress}%`,
      deliveryObjectiveDependencyLabel(item), assigneeNames(item.assignee_ids, item.owner_id, item.assign_to_client),
      item.due_date ? dt(item.due_date) : "—",
      TASK_STATUS.find((status) => status.id === (item.status || "todo"))?.label || "A fazer"
    ];
  }
  const current = Number(item.current_value || 0);
  const target = Number(item.target_value || 0);
  return [
    item.name || "—", item.category || "—", item.channel || "—", item.metric || "—", current.toLocaleString("pt-BR"),
    `${GOAL_COMPARISON_LABEL[item.comparison] || "No mínimo"} ${target.toLocaleString("pt-BR")} ${item.unit || ""}`.trim(), item.comments || "—", item.notes || "—",
    `${target ? Math.max(0, Math.min(100, Math.round(current / target * 100))) : 0}%`,
    deliveryGoalDependencyLabel(item), assigneeNames(item.assignee_ids, item.owner_id, item.assign_to_client),
    item.due_date ? dt(item.due_date) : "—",
    TASK_STATUS.find((status) => status.id === (item.status || "todo"))?.label || "A fazer"
  ];
}

function projectRowValue(item, key, tasks) {
  const index = Number(String(key || "").slice(1));
  return String(projectSectionValues(item, tasks)[index] ?? "—");
}

function filterProjectSectionRows(rows, tasks = []) {
  const query = String(projectBoardState.search || "").trim().toLocaleLowerCase("pt-BR");
  const filters = projectBoardState.filters || {};
  const filtered = rows.filter((item) => {
    const values = projectSectionValues(item, tasks);
    const matchesSearch = !query || values.some((value) => String(value ?? "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(filters).every(([key, selected]) =>
      !selected?.size || selected.has(projectRowValue(item, key, tasks))
    );
  });
  if (!projectBoardState.sortKey) return filtered;
  return filtered.sort((a, b) => projectRowValue(a, projectBoardState.sortKey, tasks).localeCompare(
    projectRowValue(b, projectBoardState.sortKey, tasks), "pt-BR", { numeric: true, sensitivity: "base" }
  ) * projectBoardState.sortDir);
}

function projectFilterStripHtml() {
  const filters = projectBoardState.filters || {};
  const labels = PROJECT_TABLE_LABELS[projectBoardState.section] || [];
  const active = Object.entries(filters).filter(([, values]) => values?.size);
  return `<div class="registration-filter-strip"><div class="registration-filter-badges">${active.map(([key, values]) => {
    const label = labels[Number(key.slice(1))] || key;
    return `<button class="registration-filter-badge project-filter-badge" data-key="${esc(key)}" title="Limpar filtro"><span>${esc(label)}: ${esc([...values].join(", "))}</span><b>×</b></button>`;
  }).join("")}</div><button class="filter-clear-all project-filter-clear-all" type="button"${active.length < 2 ? " hidden" : ""}><span aria-hidden="true">×</span> Limpar tudo</button></div>`;
}

function projectToolbarHtml(client, product, total) {
  const sectionLabel = projectBoardState.section === "activities" ? "tarefa(s)" : projectBoardState.section === "objectives" ? "objetivo(s)" : "meta(s)";
  const primaryModes = new Set(PROJECT_VIEW_MODES.map((mode) => mode.id));
  const activePrimaryMode = primaryModes.has(projectBoardState.view) ? projectBoardState.view : "table";
  const activePrimaryLabel = PROJECT_VIEW_MODES.find((mode) => mode.id === activePrimaryMode)?.label || "Tabela";
  const projectName = (cache?.projects || []).find((item) => item.id === projectBoardState.projectId)?.name || "Sem nome";
  return `<div class="project-head project-data-toolbar">
    <div class="registration-toolbar-left"><span class="registration-toolbar-title" title="${esc(projectName)}">${esc(projectName)}</span></div>
    <div class="registration-toolbar-center"><input class="search registration-toolbar-search" id="project-search" placeholder="Buscar..." value="${esc(projectBoardState.search || "")}">${projectBoardState.section === "activities" ? '<button class="btn primary plus" id="project-add-task" title="Adicionar tarefa">+</button>' : ""}</div>
    <div class="registration-toolbar-right"><button class="btn table-group-btn" type="button" title="Agrupar (indisponível nesta tabela)" disabled>≡</button><button class="btn project-cols-btn" type="button" title="Selecionar colunas"${projectBoardState.view === "table" ? "" : " disabled"}>⊞</button>
      <button class="btn view-menu-trigger${primaryModes.has(projectBoardState.view) ? " active" : ""}" id="project-view-menu-btn" type="button" title="Modo de visualização: ${esc(activePrimaryLabel)}">${viewTriggerInner(activePrimaryMode)}</button>
      <button class="view project-mode${projectBoardState.view === "matrix" ? " active" : ""}" data-project-mode="matrix" title="Matriz" aria-label="Matriz"${projectBoardState.section === "activities" ? "" : " disabled"}>${viewButtonInner("matrix")}</button>
      <button class="view project-mode${projectBoardState.view === "dashboard" ? " active" : ""}" data-project-mode="dashboard" title="Dashboard" aria-label="Dashboard">${viewButtonInner("dashboard")}</button>
      <button class="btn project-data-btn" type="button" title="Dados">⬆⬇</button>
    </div>
  </div>`;
}

function renderProjectBoard(projectId) {
  const root = document.getElementById("project-board-root");
  const project = (cache.projects || []).find((p) => p.id === projectId);
  if (!root || !project) return;
  if (projectBoardState.section === "data") {
    root.innerHTML = `<div class="project-board">${renderProjectDataModule(project)}</div>`;
    wireProjectDataModule(project);
    return;
  }
  const allTasks = projectTasks(projectId);
  const allRows = projectSectionRows(projectId);
  const rows = filterProjectSectionRows(allRows, allTasks);
  const client = cache.companyById[project.company_id]?.legal_name || "Sem cliente";
  const product = cache.productById[project.product_id]?.name || "Sem produto";
  if (projectBoardState.section !== "activities" && projectBoardState.view === "matrix") projectBoardState.view = "table";
  const view = projectBoardState.view || "table";
  let body = "";
  if (projectBoardState.section === "activities") {
    body = view === "table" ? renderTaskTable(rows)
      : ["matrix", "kanban"].includes(view) ? renderTaskMatrix(rows)
      : view === "calendar" ? renderProjectTaskCalendar(rows)
      : view === "gantt" ? renderProjectTaskGantt(rows)
      : view === "mindmap" ? registrationMindMapShellHtml(rows, DELIVERY_MIND_MAP_TASK_ADAPTER, "", `delivery:${projectId}`).html
      : renderTaskDashboard(rows);
  } else if (projectBoardState.section === "objectives") {
    body = view === "table" ? renderDeliveryObjectives(projectId, allTasks, rows)
      : view === "mindmap" ? registrationMindMapShellHtml(rows, DELIVERY_MIND_MAP_OBJECTIVE_ADAPTER, "", `delivery-objectives:${projectId}`).html
      : view === "matrix" ? renderDeliveryStatusMatrix(rows, "objectives", allTasks)
      : renderDeliverySectionDashboard(rows, "objectives", allTasks);
  } else {
    body = view === "table" ? renderDeliveryGoals(projectId, rows)
      : view === "mindmap" ? registrationMindMapShellHtml(rows, DELIVERY_MIND_MAP_GOAL_ADAPTER, "", `delivery-goals:${projectId}`).html
      : view === "matrix" ? renderDeliveryStatusMatrix(rows, "goals")
      : renderDeliverySectionDashboard(rows, "goals", allTasks);
  }
  root.innerHTML = `<div class="project-board">${projectToolbarHtml(client, product, rows.length)}${["table", "mindmap"].includes(view) ? projectFilterStripHtml() : ""}${body}</div>`;
  const table = root.querySelector("table");
  if (table && view === "table") wireProjectTableColumns(table);
  if (projectBoardState.section === "objectives" && view === "table") wireDeliveryObjectives(projectId);
  if (projectBoardState.section === "goals" && view === "table") wireDeliveryGoals(projectId);
  wireProjectBoard(projectId);
  if (view === "mindmap") {
    root.querySelectorAll(".delivery-mind-task-open[data-id]").forEach((button) =>
      button.addEventListener("click", () => openDeliveryTaskDrawer(projectId, button.dataset.id)));
    wireMindMap(root, () => renderProjectBoard(projectId));
  }
}

async function updateDeliveryObjective(objectiveId, patch) {
  const rows = loadDeliveryObjectives();
  const objective = rows.find((item) => item.id === objectiveId);
  if (!objective) return;
  if (patch.status && patch.status !== "todo") {
    const dependencyState = deliveryObjectiveDependencyState(objective);
    if (dependencyState.blocked) {
      const pending = dependencyState.pendingObjectives[0]?.name || activityDisplayName(dependencyState.pendingActivities[0]);
      toast(`Conclua "${pending}" antes de avançar este objetivo.`, true);
      return false;
    }
  }
  if (patch.status && patch.status !== "done" && objective.status === "done") {
    const activeDependent = rows.find((item) => normalizeIdList(item.dependency_objective_ids).includes(objective.id) && item.status !== "todo");
    if (activeDependent) {
      toast(`Volte "${activeDependent.name}" para A fazer antes de reabrir este objetivo.`, true);
      return false;
    }
  }
  const changes = { ...patch, updated_at: new Date().toISOString() };
  if (isLive()) await updateRow("deliveryObjectives", objectiveId, changes);
  Object.assign(objective, changes);
  if (isLive()) cache.deliveryObjectives = rows;
  else saveDeliveryObjectives(rows);
  refreshActivityCache();
  return true;
}

function wireDeliveryObjectives(projectId) {
  document.querySelectorAll("#project-board-root tr[data-objective-id]").forEach((row) => {
    const objectiveId = row.dataset.objectiveId;
    const assigneePickerId = `delivery-objective-assignees-${objectiveId}`;
    wireMultiPicker(assigneePickerId);
    row.querySelector(`#${CSS.escape(assigneePickerId)}`)?.addEventListener("multi-picker-change", async () => {
      const assignees = assigneePickerValue(assigneePickerId);
      await updateDeliveryObjective(objectiveId, {
        owner_id: assignees.ids[0] || null,
        assignee_ids: assignees.ids,
        assign_to_client: assignees.assignToClient
      });
    });
    row.querySelector(".delivery-objective-due")?.addEventListener("change", async (event) => {
      await updateDeliveryObjective(objectiveId, { due_date: event.target.value || null });
    });
    row.querySelector(".delivery-objective-status")?.addEventListener("change", async (event) => {
      await updateDeliveryObjective(objectiveId, { status: event.target.value });
      renderProjectBoard(projectId);
    });
  });
}

async function updateDeliveryGoal(goalId, patch) {
  const rows = loadDeliveryGoals();
  const goal = rows.find((item) => item.id === goalId);
  if (!goal) return;
  if (patch.status && patch.status !== "todo") {
    const dependencyState = deliveryGoalDependencyState(goal);
    if (dependencyState.blocked) {
      const pending = dependencyState.pendingGoals[0]?.name || activityDisplayName(dependencyState.pendingActivities[0]);
      toast(`Conclua "${pending}" antes de avançar esta meta.`, true);
      return false;
    }
  }
  if (patch.status && patch.status !== "done" && goal.status === "done") {
    const activeDependent = rows.find((item) => normalizeIdList(item.dependency_goal_ids).includes(goal.id) && item.status !== "todo");
    if (activeDependent) {
      toast(`Volte "${activeDependent.name}" para A fazer antes de reabrir esta meta.`, true);
      return false;
    }
  }
  const changes = { ...patch, updated_at: new Date().toISOString() };
  if (isLive()) await updateRow("deliveryGoals", goalId, changes);
  Object.assign(goal, changes);
  if (isLive()) cache.deliveryGoals = rows;
  else saveDeliveryGoals(rows);
  return true;
}

function wireDeliveryGoals(projectId) {
  document.querySelectorAll("#project-board-root tr[data-goal-id]").forEach((row) => {
    const goalId = row.dataset.goalId;
    const assigneePickerId = `delivery-goal-assignees-${goalId}`;
    wireMultiPicker(assigneePickerId);
    row.querySelector(`#${CSS.escape(assigneePickerId)}`)?.addEventListener("multi-picker-change", async () => {
      const assignees = assigneePickerValue(assigneePickerId);
      await updateDeliveryGoal(goalId, {
        owner_id: assignees.ids[0] || null,
        assignee_ids: assignees.ids,
        assign_to_client: assignees.assignToClient
      });
    });
    row.querySelector(".delivery-goal-current")?.addEventListener("change", async (event) => {
      const goal = loadDeliveryGoals().find((item) => item.id === goalId);
      const currentValue = Number(event.target.value || 0);
      const reached = goal && deliveryGoalReached(goal, currentValue);
      const status = reached && !deliveryGoalDependencyState(goal).blocked ? "done" : (goal?.status === "done" ? "doing" : goal?.status || "todo");
      await updateDeliveryGoal(goalId, { current_value: currentValue, status });
      renderProjectBoard(projectId);
    });
    row.querySelector(".delivery-goal-due")?.addEventListener("change", async (event) =>
      updateDeliveryGoal(goalId, { due_date: event.target.value || null }));
    row.querySelector(".delivery-goal-status")?.addEventListener("change", async (event) => {
      await updateDeliveryGoal(goalId, { status: event.target.value });
      renderProjectBoard(projectId);
    });
  });
}

async function updateProjectTask(taskId, patch) {
  if (!requireCurrentUserPermission("activities", "operate", "Tarefas")) return;
  const tasks = loadProjectTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return false;
  const transitionError = patch.status ? taskStatusTransitionError(task.status || "todo", patch.status) : "";
  if (transitionError) {
    toast(transitionError, true);
    return false;
  }
  const operationalTasks = operationalProjectTasks(task.project_id);
  if (patch.status && !["todo", "canceled"].includes(patch.status) && taskIsBlocked(task, operationalTasks)) {
    const dependency = taskDependencies(task, operationalTasks).find((item) => item.status !== "done");
    toast(`Conclua "${dependency ? activityDisplayName(dependency) : "a tarefa anterior"}" antes de iniciar esta tarefa.`, true);
    return false;
  }
  if (patch.status && patch.status !== "done" && task.status === "done") {
    const activeDependent = operationalTasks.find((item) => normalizeIdList(item.dependency_ids, item.depends_on_activity_id).includes(task.id) && item.status !== "todo");
    if (activeDependent) {
      toast(`"${activityDisplayName(activeDependent)}" depende desta tarefa e já foi iniciada; não é possível reabrir.`, true);
      return false;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const changes = { ...patch, updated_at: new Date().toISOString() };
  if (["doing", "done"].includes(patch.status) && !task.actual_start_date) changes.actual_start_date = today;
  if (patch.status === "done" && !task.actual_end_date) changes.actual_end_date = today;
  if (patch.status && patch.status !== "done" && task.status === "done") changes.actual_end_date = null;
  if (isLive()) await updateRow("activities", taskId, changes);
  Object.assign(task, changes);
  if (isLive()) cache.activityRecords = tasks;
  else saveProjectTasks(tasks);
  refreshActivityCache();
  if (patch.status || "actual_end_date" in patch) await recalculateDependencySchedules(task.project_id);
  return true;
}

function createsTaskDependencyCycle(tasks, currentId, dependencyIds) {
  if (!currentId) return false;
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const nextPath = new Set(path).add(candidateId);
    const candidate = tasks.find((task) => task.id === candidateId);
    return normalizeIdList(candidate?.dependency_ids, candidate?.depends_on_activity_id)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

function renderActivityChecklistPanel(taskId) {
  const body = document.getElementById("activity-checklist-body");
  const task = loadProjectTasks().find((item) => item.id === taskId);
  if (!body || !task) return;
  const subtasks = taskSubtasks(taskId);
  if (subtasks.length) {
    body.innerHTML = `<div class="empty" style="padding:28px 8px">Esta tarefa possui subtarefas. O checklist deve ser preenchido em cada subtarefa.</div>`;
    return;
  }
  const items = normalizeChecklist(task.checklist);
  const progress = checklistProgress(items);
  const canOperate = currentUserCan("activities", "operate");
  body.innerHTML = `<div class="checklist-panel-summary"><span>${progress.done} de ${progress.total} concluído(s)</span><strong>${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%</strong></div>
    <div>${items.map((item) => `<div class="checklist-item${item.checked ? " done" : ""}" data-id="${esc(item.id)}">
      <input class="activity-check-toggle" type="checkbox"${item.checked ? " checked" : ""}${canOperate ? "" : " disabled"} title="Marcar como concluído">
      <input class="activity-check-text" type="text" value="${esc(item.text)}" aria-label="Item do checklist"${canOperate ? "" : " readonly"}>
      <button class="rowbtn activity-check-remove" type="button" title="Remover item"${canOperate ? "" : " disabled"}>✕</button>
    </div>`).join("") || '<div class="empty" style="padding:28px 8px">Nenhum item no checklist.</div>'}</div>
    ${canOperate ? '<div class="checklist-new"><input id="activity-check-new" placeholder="Novo item"><button class="btn primary" id="activity-check-add">Adicionar</button></div>' : ""}`;
  const persist = async (nextItems) => {
    try {
      await updateProjectTask(taskId, { checklist: normalizeChecklist(nextItems) });
      renderActivityChecklistPanel(taskId);
    } catch (err) { toast("Erro ao atualizar checklist · " + err.message, true); }
  };
  body.querySelectorAll(".checklist-item").forEach((row) => {
    row.querySelector(".activity-check-toggle").addEventListener("change", (event) => {
      const next = items.map((item) => item.id === row.dataset.id ? { ...item, checked: event.target.checked } : item);
      persist(next);
    });
    row.querySelector(".activity-check-text").addEventListener("change", (event) => {
      const next = items.map((item) => item.id === row.dataset.id ? { ...item, text: event.target.value.trim() } : item);
      persist(next);
    });
    row.querySelector(".activity-check-remove").addEventListener("click", () =>
      persist(items.filter((item) => item.id !== row.dataset.id)));
  });
  const addItem = () => {
    const input = document.getElementById("activity-check-new");
    const text = input?.value.trim();
    if (!text) return;
    persist([...items, { id: crypto.randomUUID(), text, checked: false }]);
  };
  document.getElementById("activity-check-add")?.addEventListener("click", addItem);
  document.getElementById("activity-check-new")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addItem();
  });
}

function openActivityChecklist(taskId) {
  if (!requireCurrentUserPermission("activities", "view", "Tarefas")) return;
  const task = loadProjectTasks().find((item) => item.id === taskId);
  if (!task) return;
  if (taskSubtasks(taskId).length) {
    toast("O checklist desta tarefa fica nas subtarefas.", true);
    return;
  }
  const fullModal = document.querySelector("#ov .modal.full");
  if (fullModal) {
    document.getElementById("activity-checklist-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "activity-checklist-overlay";
    overlay.className = "activity-form-overlay";
    overlay.innerHTML = `<aside class="activity-form-drawer"><h3>Checklist<button class="modal-close-x" id="activity-checklist-close" title="Fechar">✕</button></h3><div class="checklist-panel-body" id="activity-checklist-body"></div></aside>`;
    fullModal.appendChild(overlay);
    const close = () => { overlay.remove(); renderProjectBoard(projectBoardState.projectId); };
    document.getElementById("activity-checklist-close").addEventListener("click", close);
  } else {
    sidePanel(`Checklist · ${activityDisplayName(task)}`, '<div class="checklist-panel-body" id="activity-checklist-body"></div>', { closeOnOverlay: true });
    document.getElementById("side-close")?.addEventListener("click", render);
  }
  renderActivityChecklistPanel(taskId);
}

function openProjectViewMenu() {
  document.getElementById("project-data-dd")?.remove();
  document.getElementById("project-view-dd")?.remove();
  const button = document.getElementById("project-view-menu-btn");
  if (!button) return;
  const rect = button.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "project-view-dd";
  panel.className = "view-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 198))}px`;
  panel.style.top = `${rect.bottom + 5}px`;
  panel.innerHTML = PROJECT_VIEW_MODES.map((mode) => {
    const available = mode.id === "table" || projectBoardState.section === "activities" || (mode.id === "mindmap" && ["objectives", "goals"].includes(projectBoardState.section));
    return `<button class="view-option${projectBoardState.view === mode.id ? " active" : ""}" data-view="${mode.id}"${available ? "" : " disabled"}>
    <span class="view-option-icon">${mode.icon}</span><span>${mode.label}</span><span>${projectBoardState.view === mode.id ? "✓" : ""}</span>
  </button>`;
  }).join("");
  document.body.appendChild(panel);
  panel.querySelectorAll(".view-option:not(:disabled)").forEach((option) => option.addEventListener("click", () => {
    projectBoardState.view = option.dataset.view;
    projectBoardState.page = 1;
    panel.remove();
    renderProjectBoard(projectBoardState.projectId);
  }));
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !button.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function exportProjectSectionCSV() {
  const section = projectBoardState.section;
  const labels = PROJECT_TABLE_LABELS[section] || [];
  const tasks = projectTasks(projectBoardState.projectId);
  const rows = projectSectionRows(projectBoardState.projectId, section);
  const columns = labels.map((label, index) => ({
    k: `c${index}`,
    h: label,
    csv: (_value, row) => projectSectionValues(row, tasks)[index] ?? ""
  }));
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  downloadCSV(columns, rows, `enterpriser_entrega_${section}_${stamp}.csv`);
  toast(`CSV exportado: ${rows.length} linha(s).`);
}

function openProjectDataMenu(anchor) {
  document.getElementById("project-view-dd")?.remove();
  document.getElementById("project-data-dd")?.remove();
  const panel = document.createElement("div");
  panel.id = "project-data-dd";
  panel.className = "data-dd";
  panel.innerHTML = `<div class="dd-head"><span>Dados</span><span>Entrega</span></div>
    <div class="dd-head"><span>Exportar</span><span>CSV</span></div>
    <button class="dd-menu-btn project-export-all" type="button">Exportar todas as colunas</button>`;
  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.right = "auto";
  panel.style.left = `${Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.querySelector(".project-export-all").addEventListener("click", () => {
    panel.remove();
    exportProjectSectionCSV();
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && event.target !== anchor) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function openTaskDeliveryPicker() {
  const deliveries = cache?.projects || [];
  if (!deliveries.length) { toast("Cadastre uma entrega antes de criar tarefas.", true); return; }
  const options = deliveries.map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.client_name || "Entrega sem nome")}</option>`).join("");
  sidePanel("Nova tarefa", `<div class="form product-activity-form">
    <div class="field full"><label>Entrega *</label><select id="task-delivery-picker">${options}</select></div>
  </div><div class="modal-foot"><button class="btn" id="task-delivery-cancel">Cancelar</button><button class="btn primary" id="task-delivery-next">Continuar</button></div>`, { closeOnOverlay: true });
  document.getElementById("task-delivery-cancel").addEventListener("click", closeModal);
  document.getElementById("task-delivery-next").addEventListener("click", () => {
    const projectId = document.getElementById("task-delivery-picker").value;
    if (!projectId) { toast("Selecione uma entrega.", true); return; }
    closeModal();
    openProjectBoard(projectId);
    openDeliveryTaskDrawer(projectId);
  });
}

async function openDeliveryTaskDrawer(projectId, editId = null, parentTaskId = null) {
  if (!requireCurrentUserPermission("activities", editId ? "edit" : "create", "Tarefas")) return;
  await ensureTaskReferenceSources();
  document.getElementById("project-task-drawer-overlay")?.remove();
  const tasks = projectTasks(projectId);
  const current = tasks.find((task) => task.id === editId) || {};
  const parentId = current.parent_activity_id || parentTaskId || null;
  const parentTask = parentId ? tasks.find((task) => task.id === parentId) : null;
  if (parentTask?.parent_activity_id) {
    toast("Uma subtarefa não pode receber outra subtarefa.", true);
    return;
  }
  const subtasks = editId && !parentId ? taskSubtasks(editId, tasks) : [];
  const objectives = loadDeliveryObjectives().filter((item) => item.project_id === projectId);
  const selectedDependencies = new Set(normalizeIdList(current.dependency_ids, current.depends_on_activity_id));
  const dependencyOptions = tasks.filter((task) => task.id !== editId).map((task) => ({ value: task.id, label: activityDisplayName(task) }));
  const selectedAssignees = assigneePickerSelection(current.assignee_ids, current.owner_id, current.assign_to_client);
  const selectedJobTitles = new Set(normalizeTextList(current.assignee_job_titles));
  const selectedDocuments = new Set(normalizeIdList(current.document_ids));
  const selectedTables = new Set(normalizeIdList(current.custom_table_ids));
  const objectiveOptions = ['<option value="">Sem objetivo</option>'].concat(objectives.map((item) =>
    `<option value="${esc(item.id)}"${item.id === current.objective_id ? " selected" : ""}>${esc(item.name)}</option>`)).join("");
  const recurrenceOptions = RECURRENCE_OPTIONS.map(([value, label]) => `<option value="${value}"${value === (current.recurrence || "once") ? " selected" : ""}>${label}</option>`).join("");
  const priorityOptions = PRIORITY_OPTIONS.map(([value, label]) => `<option value="${value}"${value === (current.priority || "normal") ? " selected" : ""}>${label}</option>`).join("");
  const useStructure = Boolean(editId && !String(current.title || "").trim());
  const overlay = document.createElement("div");
  overlay.id = "project-task-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer task-form-drawer"><h3>${editId ? (parentId ? "Editar subtarefa" : "Editar tarefa") : (parentId ? "Nova subtarefa" : "Nova tarefa")}<button class="modal-close-x" id="project-task-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form task-form-grid">
      <div class="field"><label>Origem</label><input value="${esc(parentTask ? `Subtarefa de ${activityDisplayName(parentTask)}` : current.source_template_id ? "Produto" : "Dia a dia")}" disabled></div>
      <div class="task-name-row task-form-wide">
        <div class="field"><label id="project-task-title-label">${parentId ? "Subtarefa" : "Tarefa"}${useStructure ? "" : " *"}</label><input id="project-task-title" value="${esc(current.title || "")}" placeholder="Nome da ${parentId ? "subtarefa" : "tarefa"}"${current.source_template_id ? " readonly" : ""}></div>
        <div class="field"><label>Tipo</label><input id="project-task-type" value="${esc(current.type || "")}"></div>
        <label class="task-use-structure" for="project-task-use-structure"><input id="project-task-use-structure" type="checkbox"${useStructure ? " checked" : ""}${current.source_template_id ? " disabled" : ""}><span>Usar estrutura</span></label>
      </div>
      <div class="field task-form-wide"><label>Informação</label><textarea id="project-task-information" rows="3" placeholder="Instruções ou contexto">${esc(current.information || "")}</textarea></div>
      <div class="field"><label>Grupo</label><select id="project-task-group">${taskSelectOptions(TASK_GROUP_OPTIONS, current.group || parentTask?.group, "Sem grupo")}</select></div>
      <div class="field"><label>Subgrupo</label><select id="project-task-subgroup">${taskSelectOptions(TASK_GROUP_SUBGROUP_OPTIONS[canonicalTaskChoice(current.group || parentTask?.group, TASK_GROUP_OPTIONS)] || [], current.subgroup || parentTask?.subgroup, "Sem subgrupo")}</select></div>
      <div class="field"><label>Setor</label><select id="project-task-sector">${taskSelectOptions(TASK_SECTOR_OPTIONS, current.sector || parentTask?.sector, "Sem setor")}</select></div>
      <div class="field"><label>Subsetor</label><input id="project-task-subsector" value="${esc(current.subsector || parentTask?.subsector || "")}" placeholder="Subsetor opcional"></div>
      <div class="field"><label>Categoria</label><input id="project-task-category" value="${esc(current.category || "")}"></div>
      <div class="field"><label>Canal</label><input id="project-task-channel" value="${esc(current.channel || "")}"></div>
      <div class="field"><label>Módulo</label><input id="project-task-module" value="${esc(current.module || parentTask?.module || "")}" placeholder="Módulo opcional"></div>
      <div class="field"><label>Submódulo</label><input id="project-task-submodule" value="${esc(current.submodule || parentTask?.submodule || "")}" placeholder="Submódulo opcional"></div>
      <div class="task-schedule-row">
        <div class="field"><label>Recorrência</label><select id="project-task-recurrence">${recurrenceOptions}</select></div>
        <div class="field"><label>Prioridade</label><select id="project-task-priority">${priorityOptions}</select></div>
        <div class="field" title="Dias para iniciar depois que a tarefa da qual esta depende terminar (data real se concluída; senão, a prevista)."><label>Iniciar após dependência (dias)</label><input id="project-task-start-after" type="number" min="0" step="1" value="${esc(current.start_after_days ?? "")}" placeholder="Ex.: 2"></div>
        <label class="task-business-days" for="project-task-business-days"><input id="project-task-business-days" type="checkbox"${current.consider_business_days ? " checked" : ""}><span>Dias úteis</span></label>
      </div>
      <div class="field"><label>Objetivo</label><select id="project-task-objective">${objectiveOptions}</select></div>
      <div class="field task-form-wide"><label>Depende de</label>${multiPickerHtml("project-task-dependencies", dependencyOptions, selectedDependencies, "Selecionar dependências")}</div>
      <div class="field"><label>Responsáveis</label>${multiPickerHtml("project-task-assignees", assigneePickerOptions(selectedAssignees), selectedAssignees, "Selecionar responsáveis")}</div>
      <div class="field"><label>Cargos responsáveis</label>${multiPickerHtml("project-task-assignee-job-titles", assigneeJobTitleOptions(), selectedJobTitles, "Selecionar cargos")}</div>
      <div class="field"><label>Documentos de apoio</label>${multiPickerHtml("project-task-documents", taskDocumentOptions(), selectedDocuments, "Selecionar documentos")}</div>
      <div class="field"><label>Tabelas de apoio</label>${multiPickerHtml("project-task-tables", taskTableOptions(), selectedTables, "Selecionar tabelas")}</div>
      <div class="field"><label>Início previsto</label><input id="project-task-planned-start" type="date" value="${esc(current.planned_start_date || "")}"></div>
      <div class="field"><label>Término previsto</label><input id="project-task-planned-end" type="date" value="${esc(taskPlannedEnd(current) || "")}"></div>
      <div class="field"><label>Início real</label><input id="project-task-actual-start" type="date" value="${esc(current.actual_start_date || "")}"></div>
      <div class="field"><label>Término real</label><input id="project-task-actual-end" type="date" value="${esc(current.actual_end_date || "")}"></div>
      ${editId && !parentId ? `<div class="field full task-subtasks-editor"><label>Subtarefas</label><div class="task-subtask-list">${subtasks.map((subtask) => {
        const progress = checklistProgress(subtask.checklist);
        return `<button class="task-subtask-edit" data-id="${esc(subtask.id)}"><span>${esc(activityDisplayName(subtask))}</span><small>${progress.done}/${progress.total} no checklist</small></button>`;
      }).join("") || '<span class="muted">Nenhuma subtarefa cadastrada.</span>'}</div></div>` : ""}
    </div><div class="modal-foot">${editId && !parentId ? '<button class="btn" id="project-task-add-subtask">+ Subtarefa</button>' : ""}<button class="btn" id="project-task-cancel">Cancelar</button><button class="btn primary" id="project-task-save">${editId ? "Salvar" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById("project-task-close").addEventListener("click", close);
  document.getElementById("project-task-cancel").addEventListener("click", close);
  wireTaskGroupSelect("project-task-group", "project-task-subgroup");
  wireMultiPicker("project-task-dependencies");
  wireMultiPicker("project-task-assignees");
  wireMultiPicker("project-task-assignee-job-titles");
  wireMultiPicker("project-task-documents");
  wireMultiPicker("project-task-tables");
  wireTaskStructureToggle("project-task-use-structure", "project-task-title", "project-task-title-label", ["project-task-category", "project-task-channel", "project-task-module", "project-task-type"]);
  document.querySelectorAll(".task-subtask-edit").forEach((button) => button.addEventListener("click", () =>
    openDeliveryTaskDrawer(projectId, button.dataset.id)));
  document.getElementById("project-task-add-subtask")?.addEventListener("click", () =>
    openDeliveryTaskDrawer(projectId, null, editId));
  document.getElementById("project-task-save").addEventListener("click", async () => {
    const saveButton = document.getElementById("project-task-save");
    if (saveButton?.disabled) return;
    const useStructure = document.getElementById("project-task-use-structure").checked;
    const title = useStructure ? "" : document.getElementById("project-task-title").value.trim();
    if (!useStructure && !title) { toast("Informe a tarefa ou marque Usar estrutura.", true); return; }
    if (useStructure && !document.getElementById("project-task-use-structure").disabled && !taskStructureFieldsFilled(["project-task-category", "project-task-channel", "project-task-module", "project-task-type"])) { toast(`Preencha ${TASK_STRUCTURE_REQUIRED_LABEL} para usar a estrutura.`, true); return; }
    const dependencyIds = multiPickerValues("project-task-dependencies");
    const assignees = assigneePickerValue("project-task-assignees");
    const assigneeJobTitles = multiPickerValues("project-task-assignee-job-titles");
    const plannedStart = document.getElementById("project-task-planned-start").value || null;
    const plannedEnd = document.getElementById("project-task-planned-end").value || null;
    const actualStart = document.getElementById("project-task-actual-start").value || null;
    const actualEnd = document.getElementById("project-task-actual-end").value || null;
    if (plannedStart && plannedEnd && plannedEnd < plannedStart) { toast("O término previsto não pode ser anterior ao início previsto.", true); return; }
    if (actualStart && actualEnd && actualEnd < actualStart) { toast("O término real não pode ser anterior ao início real.", true); return; }
    if (createsTaskDependencyCycle(tasks, editId, dependencyIds)) { toast("Essa dependência criaria um ciclo entre as tarefas.", true); return; }
    const now = new Date().toISOString();
    const inheritedChecklist = !editId && parentTask && !taskSubtasks(parentTask.id, tasks).length
      ? normalizeChecklist(parentTask.checklist)
      : [];
    const draft = {
      id: editId || crypto.randomUUID(), project_id: projectId, title,
      parent_activity_id: parentId,
      information: document.getElementById("project-task-information").value.trim(),
      group: document.getElementById("project-task-group").value,
      subgroup: document.getElementById("project-task-subgroup").value,
      sector: document.getElementById("project-task-sector").value,
      subsector: document.getElementById("project-task-subsector").value.trim(),
      module: document.getElementById("project-task-module").value.trim(),
      submodule: document.getElementById("project-task-submodule").value.trim(),
      category: document.getElementById("project-task-category").value.trim(),
      channel: document.getElementById("project-task-channel").value.trim(),
      type: document.getElementById("project-task-type").value.trim(),
      recurrence: document.getElementById("project-task-recurrence").value,
      consider_business_days: document.getElementById("project-task-business-days").checked,
      priority: document.getElementById("project-task-priority").value || "normal",
      objective_id: document.getElementById("project-task-objective").value || null,
      depends_on_activity_id: dependencyIds[0] || null,
      dependency_ids: dependencyIds,
      owner_id: assignees.ids[0] || null,
      assignee_ids: assignees.ids,
      assignee_job_titles: assigneeJobTitles,
      assign_to_client: assignees.assignToClient,
      document_ids: multiPickerValues("project-task-documents"),
      custom_table_ids: multiPickerValues("project-task-tables"),
      planned_start_date: plannedStart,
      planned_end_date: plannedEnd,
      actual_start_date: actualStart,
      actual_end_date: actualEnd,
      due_date: plannedEnd,
      start_after_days: document.getElementById("project-task-start-after").value === "" ? null : Number(document.getElementById("project-task-start-after").value),
      schedule_manual: editId && (plannedStart || null) === (current.planned_start_date || null) ? Boolean(current.schedule_manual) : Boolean(plannedStart),
      notes: current.notes || null,
      sort_order: editId ? Number(current.sort_order || 0) : Math.max(-1, ...tasks.filter((task) => (task.parent_activity_id || null) === parentId).map((task) => Number(task.sort_order || 0))) + 1,
      checklist: parentId ? (editId ? normalizeChecklist(current.checklist) : inheritedChecklist) : (subtasks.length ? [] : normalizeChecklist(current.checklist)),
      status: current.status || "todo",
      created_at: current.created_at || now, updated_at: now
    };
    const saveButtonLabel = saveButton?.textContent || "Salvar";
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
    try {
      const allTasks = loadProjectTasks();
      if (editId) {
        const saved = isLive() ? await updateRow("activities", editId, draft) : { ...current, ...draft };
        Object.assign(allTasks.find((task) => task.id === editId), saved);
      } else {
        const saved = isLive() ? await createRow("activities", draft) : draft;
        allTasks.push(saved);
        if (parentTask && inheritedChecklist.length) {
          if (isLive()) await updateRow("activities", parentTask.id, { checklist: [], updated_at: now });
          const storedParent = allTasks.find((task) => task.id === parentTask.id);
          if (storedParent) Object.assign(storedParent, { checklist: [], updated_at: now });
        }
      }
      if (isLive()) cache.activityRecords = allTasks;
      else saveProjectTasks(allTasks);
      refreshActivityCache();
      await recalculateDependencySchedules(projectId);
      projectBoardState.page = Math.max(1, Math.ceil(projectTasks(projectId).length / projectBoardState.pageSize));
      close();
      renderProjectBoard(projectId);
      toast(editId ? (parentId ? "Subtarefa atualizada." : "Tarefa atualizada.") : (parentId ? "Subtarefa criada." : "Tarefa criada."));
    } catch (err) {
      if (saveButton?.isConnected) { saveButton.disabled = false; saveButton.textContent = saveButtonLabel; }
      toast("Erro ao salvar tarefa · " + err.message, true);
    }
  });
  (document.getElementById("project-task-title").disabled ? document.getElementById("project-task-category") : document.getElementById("project-task-title"))?.focus();
}

function projectTableRows(table) {
  return [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty"));
}

function projectTableDefinitions(table) {
  return [...table.querySelectorAll("thead th[data-project-column]")]
    .map((header) => ({ k: header.dataset.projectColumn, h: header.dataset.projectLabel }))
    .sort((a, b) => Number(a.k.slice(1)) - Number(b.k.slice(1)));
}

function applyProjectTableColumnPreferences(table) {
  const scope = `delivery:${projectBoardState.section}`;
  const prefs = secondaryColumnPrefs(scope);
  const definitions = projectTableDefinitions(table);
  const ordered = orderedColumnDefinitions(definitions, prefs);
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  const headers = Object.fromEntries([...headRow.cells].filter((cell) => cell.dataset.projectColumn).map((cell) => [cell.dataset.projectColumn, cell]));
  const fixedHeaders = [...headRow.cells].filter((cell) => !cell.dataset.projectColumn);
  ordered.forEach((col) => headRow.appendChild(headers[col.k]));
  orderLeadingTableCells(headRow, fixedHeaders);
  projectTableRows(table).forEach((row) => {
    const cells = Object.fromEntries([...row.cells].filter((cell) => cell.dataset.projectColumn).map((cell) => [cell.dataset.projectColumn, cell]));
    const fixedCells = [...row.cells].filter((cell) => !cell.dataset.projectColumn);
    ordered.forEach((col) => { if (cells[col.k]) row.appendChild(cells[col.k]); });
    orderLeadingTableCells(row, fixedCells);
  });
  ordered.forEach((col) => {
    const visible = prefs[col.k] !== false;
    headers[col.k].hidden = !visible;
    projectTableRows(table).forEach((row) => {
      const cell = row.querySelector(`td[data-project-column="${CSS.escape(col.k)}"]`);
      if (cell) cell.hidden = !visible;
    });
  });
}

function wireProjectTableColumns(table) {
  const headers = [...table.querySelectorAll("thead th")];
  headers.forEach((header, index) => {
    if (header.textContent.trim().toLocaleUpperCase("pt-BR") === "AÇÕES") return;
    const key = `d${index}`;
    header.dataset.projectColumn = key;
    header.dataset.projectLabel = header.textContent.trim();
    header.title = "Clique para ordenar. Ctrl+clique para filtrar.";
    projectTableRows(table).forEach((row) => {
      const cell = row.children[index];
      if (cell) cell.dataset.projectColumn = key;
    });
    if (projectBoardState.sortKey === key) {
      header.insertAdjacentHTML("beforeend", ` <span class="arrow">${projectBoardState.sortDir > 0 ? "▲" : "▼"}</span>`);
    }
    header.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        openProjectColumnFilter(header, key);
        return;
      }
      if (projectBoardState.sortKey === key) projectBoardState.sortDir *= -1;
      else {
        projectBoardState.sortKey = key;
        projectBoardState.sortDir = 1;
      }
      projectBoardState.page = 1;
      renderProjectBoard(projectBoardState.projectId);
    });
  });
  applyProjectTableColumnPreferences(table);
  wireSecondaryTableSelection(table, `delivery:${projectBoardState.projectId}:${projectBoardState.section}`);
}

function openProjectColumnFilter(header, key) {
  document.getElementById("project-filter-dd")?.remove();
  const tasks = projectTasks(projectBoardState.projectId);
  const rows = projectSectionRows(projectBoardState.projectId);
  const values = [...new Set(rows.map((item) => projectRowValue(item, key, tasks)))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }));
  const rect = header.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "project-filter-dd";
  panel.className = "filter-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 330))}px`;
  panel.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 360)}px`;
  document.body.appendChild(panel);
  mountColumnFilterPanel(panel, {
    title: `Filtrar · ${header.dataset.projectLabel || key}`, values, key, current: projectBoardState.filters?.[key],
    onApply: (rule) => {
      if (rule) projectBoardState.filters[key] = rule; else delete projectBoardState.filters[key];
      projectBoardState.page = 1;
      panel.remove();
      renderProjectBoard(projectBoardState.projectId);
    }
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !header.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 50);
}

function openProjectColumnManager(table) {
  openSecondaryColumnManager({
    scope: `delivery:${projectBoardState.section}`,
    label: projectBoardState.section === "activities" ? "Tarefas da entrega" : projectBoardState.section === "objectives" ? "Objetivos da entrega" : "Metas da entrega",
    definitions: projectTableDefinitions(table),
    onChange: () => applyProjectTableColumnPreferences(table)
  });
}

function wireProjectBoard(projectId) {
  document.getElementById("project-search")?.addEventListener("input", (event) => {
    projectBoardState.search = event.target.value;
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
    const input = document.getElementById("project-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  document.querySelectorAll(".project-mode").forEach((button) => button.addEventListener("click", () => {
    projectBoardState.view = button.dataset.projectMode;
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
  }));
  document.getElementById("project-view-menu-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openProjectViewMenu();
  });
  document.querySelector(".project-data-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openProjectDataMenu(event.currentTarget);
  });
  document.querySelector(".project-cols-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const table = document.querySelector("#project-board-root table");
    if (table) openProjectColumnManager(table);
  });
  document.querySelectorAll(".project-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete projectBoardState.filters[badge.dataset.key];
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
  }));
  document.querySelector(".project-filter-clear-all")?.addEventListener("click", () => {
    projectBoardState.filters = {};
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
  });
  document.getElementById("project-add-task")?.addEventListener("click", () => openDeliveryTaskDrawer(projectId));
  document.getElementById("project-page-prev")?.addEventListener("click", () => { projectBoardState.page -= 1; renderProjectBoard(projectId); });
  document.getElementById("project-page-next")?.addEventListener("click", () => { projectBoardState.page += 1; renderProjectBoard(projectId); });
  document.getElementById("project-calendar-prev")?.addEventListener("click", () => {
    const date = dateOnly(`${projectBoardState.calendarCursor}-01`); date.setMonth(date.getMonth() - 1);
    projectBoardState.calendarCursor = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; renderProjectBoard(projectId);
  });
  document.getElementById("project-calendar-next")?.addEventListener("click", () => {
    const date = dateOnly(`${projectBoardState.calendarCursor}-01`); date.setMonth(date.getMonth() + 1);
    projectBoardState.calendarCursor = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; renderProjectBoard(projectId);
  });
  document.getElementById("project-calendar-today")?.addEventListener("click", () => { projectBoardState.calendarCursor = null; renderProjectBoard(projectId); });
  document.querySelectorAll(".project-calendar-item,.project-gantt-item").forEach((button) =>
    button.addEventListener("click", () => openActivityChecklist(button.dataset.id)));
  document.querySelectorAll("#project-board-root .checklist-open").forEach((button) =>
    button.addEventListener("click", () => openActivityChecklist(button.dataset.id)));
  document.querySelectorAll("#project-board-root .task-comments-open").forEach((button) =>
    button.addEventListener("click", () => openTaskComments(button.dataset.id)));
  document.querySelectorAll("#project-board-root .task-add-subtask[data-id]").forEach((button) =>
    button.addEventListener("click", () => openDeliveryTaskDrawer(projectId, null, button.dataset.id)));
  document.querySelectorAll("#project-board-root .task-edit[data-id]").forEach((button) =>
    button.addEventListener("click", () => openDeliveryTaskDrawer(projectId, button.dataset.id)));
  document.querySelectorAll("#project-board-root .task-delete-table[data-id]").forEach((button) =>
    button.addEventListener("click", () => deleteDeliveryTask(projectId, button.dataset.id)));
  document.querySelectorAll("#project-board-root .project-inline-task-status").forEach((select) =>
    select.addEventListener("change", async () => {
      const task = loadProjectTasks().find((item) => item.id === select.dataset.id);
      const previous = task?.status || "todo";
      const updated = await updateProjectTask(select.dataset.id, { status: select.value });
      if (!updated) select.value = previous;
      else renderProjectBoard(projectId);
    }));
  document.querySelectorAll("#project-board-root .task-card").forEach((card) => {
    const id = card.dataset.id;
    const rerender = () => renderProjectBoard(projectId);
    card.querySelector(".task-title-input")?.addEventListener("change", async (e) => updateProjectTask(id, { title: e.target.value.trim() }));
    card.querySelector(".task-add-subtask")?.addEventListener("click", () => openDeliveryTaskDrawer(projectId, null, id));
    card.querySelector(".task-edit")?.addEventListener("click", () => openDeliveryTaskDrawer(projectId, id));
    card.querySelector(".task-status")?.addEventListener("change", async (e) => { await updateProjectTask(id, { status: e.target.value }); rerender(); });
    card.querySelector(".del-task")?.addEventListener("click", () => deleteDeliveryTask(projectId, id));
  });
}

function closeFloaters() {
  document.getElementById("filter-dd")?.remove();
  document.getElementById("cols-dd")?.remove();
  document.getElementById("csv-dd")?.remove();
  document.getElementById("data-dd")?.remove();
  document.getElementById("view-dd")?.remove();
  document.getElementById("registration-filter-dd")?.remove();
  document.getElementById("registration-view-dd")?.remove();
  document.getElementById("project-view-dd")?.remove();
  document.getElementById("project-data-dd")?.remove();
}

const VIEW_MODES = [
  { id: "table", label: "Tabela", icon: "▦" },
  { id: "kanban", label: "Quadro", icon: "▥", tabs: ["deals", "activities"] },
  { id: "calendar", label: "Calendário", icon: "□", tabs: ["deals", "projects", "activities"] },
  { id: "gantt", label: "Gantt", icon: "▤", tabs: ["deals", "projects", "activities"] }
];

const VIEW_ICON_PATHS = {
  table: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8.5h14M3 12.5h14M8 4v12"/>',
  kanban: '<rect x="3" y="4" width="4" height="12" rx="1"/><rect x="8" y="4" width="4" height="8" rx="1"/><rect x="13" y="4" width="4" height="10" rx="1"/>',
  calendar: '<rect x="3" y="4.5" width="14" height="12" rx="1.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  gantt: '<path d="M4 5.5h7M7 10h9M5 14.5h6"/>',
  mindmap: '<circle cx="5" cy="10" r="2"/><circle cx="15" cy="5" r="2"/><circle cx="15" cy="15" r="2"/><path d="M7 10h3M10 5v10M10 5h3M10 15h3"/>',
  matrix: '<circle cx="5" cy="5" r="1.6"/><circle cx="10" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15" cy="10" r="1.6"/><circle cx="5" cy="15" r="1.6"/><circle cx="10" cy="15" r="1.6"/><circle cx="15" cy="15" r="1.6"/>',
  dashboard: '<path d="M3 16.5h14M5.5 16.5V10M10 16.5V4.5M14.5 16.5V8"/>'
};
const viewIcon = (id) => `<svg class="view-svg" viewBox="0 0 20 20" aria-hidden="true">${VIEW_ICON_PATHS[id] || VIEW_ICON_PATHS.table}</svg>`;
const VIEW_LABELS = { table: "Tabela", kanban: "Quadro", calendar: "Calendário", gantt: "Gantt", mindmap: "Mapa mental", matrix: "Matriz", dashboard: "Dashboard" };
const viewButtonInner = (id) => `${viewIcon(id)}<span class="view-label">${VIEW_LABELS[id] || ""}</span>`;
const viewTriggerInner = (id) => `<span class="view-menu-icon">${viewIcon(id)}</span><span class="view-label">${VIEW_LABELS[id] || "Tabela"}</span><span class="chevron">▾</span>`;
const PROJECT_VIEW_MODES = [...VIEW_MODES, { id: "mindmap", label: "Mapa mental", icon: "⌘" }];

function viewModeAvailable(mode, tab = state.tab) {
  return !mode.tabs || mode.tabs.includes(tab);
}

function openViewMenu() {
  closeFloaters();
  const button = document.getElementById("view-menu-btn");
  if (!button || button.disabled) return;
  const rect = button.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "view-dd";
  panel.className = "view-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 198))}px`;
  panel.style.top = `${rect.bottom + 5}px`;
  panel.innerHTML = VIEW_MODES.map((mode) => {
    const available = viewModeAvailable(mode);
    return `<button class="view-option${state.view === mode.id ? " active" : ""}" data-view="${mode.id}"${available ? "" : " disabled"}>
      <span class="view-option-icon">${mode.icon}</span><span>${mode.label}</span><span>${state.view === mode.id ? "✓" : ""}</span>
    </button>`;
  }).join("");
  document.body.appendChild(panel);
  panel.querySelectorAll(".view-option:not(:disabled)").forEach((option) => option.addEventListener("click", () => {
    state.view = option.dataset.view;
    closeFloaters();
    render();
  }));
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && event.target !== button && !button.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function renderActiveFilterBadges() {
  const root = document.getElementById("filter-badges");
  if (!root) return;
  const filters = tabFilters();
  const cols = orderedColumns(state.tab, cache);
  const orderedKeys = cols.map((col) => col.k);
  const active = [
    ...orderedKeys.map((key) => [key, filters[key]]),
    ...Object.entries(filters).filter(([key]) => !orderedKeys.includes(key))
  ].filter(([, values]) => values?.size);
  root.innerHTML = active.map(([key, values]) => {
    const col = cols.find((item) => item.k === key);
    const label = col?.h || key;
    const selected = [...values];
    const sample = (cache[state.tab] || []).find((row) => String(row[key] ?? "") === selected[0]) || {};
    const valueLabel = values instanceof FilterRule ? values.label : selected.length === 1
      ? (selected[0] === "" ? "(em branco)" : col ? displayValue(sample, col, cache) : selected[0])
      : `${selected.length} selecionados`;
    return `<button class="filter-badge" data-key="${esc(key)}" title="Remover filtro de ${esc(label)}"><span>${esc(label)}: ${esc(valueLabel)}</span><span class="x">×</span></button>`;
  }).join("");
  root.querySelectorAll(".filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete filters[badge.dataset.key];
    if (state.pages[state.tab]) state.pages[state.tab] = 1;
    closeFloaters();
    render();
  }));
  const clearAll = document.getElementById("filter-clear-all");
  clearAll.hidden = active.length < 2;
  clearAll.onclick = active.length < 2 ? null : () => {
    state.filters[state.tab] = {};
    if (state.pages[state.tab]) state.pages[state.tab] = 1;
    closeFloaters();
    render();
  };
}

// ---------- Filtros de coluna (lista, número e período) ----------
// Todas as tabelas guardam o filtro da coluna como um Set de valores. Os
// filtros de número (entre, maior, menor...) e de data (período com
// calendário) usam FilterRule, que responde .size, .has() e iteração como um
// Set — assim os pontos que aplicam e exibem os filtros continuam funcionando.
const FILTER_BLANKS = new Set(["", "—", "-", "(em branco)", "(vazio)"]);
const FILTER_MONTH_NAMES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const FILTER_WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
const FILTER_NUMBER_OPS = [["between", "Entre"], ["gt", "Maior que"], ["gte", "Maior ou igual a"], ["lt", "Menor que"], ["lte", "Menor ou igual a"], ["eq", "Igual a"]];
const FILTER_DATE_PRESETS = [["today", "Hoje"], ["this_week", "Esta semana"], ["last_week", "Semana passada"], ["this_month", "Este mês"], ["last_month", "Mês passado"], ["month", "Selecionar mês"], ["custom", "Período customizado"]];

function filterNumberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim();
  if (FILTER_BLANKS.has(text)) return null;
  let clean = text.replace(/[^\d,.\-]/g, "");
  if (!/\d/.test(clean)) return null;
  if (clean.includes(",")) clean = clean.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(clean)) clean = clean.replace(/\./g, "");
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

// Data (AAAA-MM-DD) a partir de ISO ou dd/mm/aaaa; "" quando não é data.
function filterDayValue(value) {
  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return "";
}
const filterIsoDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const filterDateFromIso = (iso) => { const [year, month, day] = iso.split("-").map(Number); return new Date(year, month - 1, day); };
const filterBrDay = (iso) => iso ? iso.split("-").reverse().join("/") : "";
const filterNumberLabel = (number) => Number(number).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

function filterPresetRange(preset, base = new Date()) {
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const shift = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  if (preset === "today") return [today, today];
  if (preset === "this_week") { const start = shift(today, -today.getDay()); return [start, shift(start, 6)]; }
  if (preset === "last_week") { const start = shift(today, -today.getDay() - 7); return [start, shift(start, 6)]; }
  if (preset === "this_month") return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0)];
  if (preset === "last_month") return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)];
  return null;
}

class FilterRule {
  constructor(kind, data) { Object.assign(this, data, { kind }); }
  get size() { return 1; }
  has(value) {
    if (this.kind === "range") {
      const day = filterDayValue(value);
      return Boolean(day) && day >= this.from && day <= this.to;
    }
    const number = filterNumberValue(value);
    if (number == null) return false;
    if (this.op === "between") return number >= Math.min(this.a, this.b) && number <= Math.max(this.a, this.b);
    if (this.op === "gt") return number > this.a;
    if (this.op === "gte") return number >= this.a;
    if (this.op === "lt") return number < this.a;
    if (this.op === "lte") return number <= this.a;
    return number === this.a;
  }
  get label() {
    if (this.kind === "range") return this.from === this.to ? filterBrDay(this.from) : `${filterBrDay(this.from)} – ${filterBrDay(this.to)}`;
    if (this.op === "between") return `entre ${filterNumberLabel(this.a)} e ${filterNumberLabel(this.b)}`;
    return `${{ gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" }[this.op]} ${filterNumberLabel(this.a)}`;
  }
  *[Symbol.iterator]() { yield this.label; }
}

// Tipo da coluna: pela dica da coluna ou pelos próprios valores. Códigos
// (CNPJ, CPF, telefone, CEP) continuam como lista.
function filterColumnKind(values, key = "", hint = "") {
  if (hint === "number" || hint === "date") return hint;
  const filled = values.map((value) => String(value ?? "").trim()).filter((value) => !FILTER_BLANKS.has(value));
  if (!filled.length) return "list";
  if (filled.every((value) => /^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})([ T].*)?$/.test(value))) return "date";
  if (/(tax_?id|cnpj|cpf|phone|tel|zip|cep|code|codigo|document|_id$|^id$)/i.test(key)) return "list";
  const numeric = filled.every((value) => /^(R\$\s*)?-?(\d{1,3}(\.\d{3})+|\d+)([.,]\d+)?\s*%?$/.test(value) && value.replace(/\D/g, "").length <= 12);
  return numeric ? "number" : "list";
}

// Seletor de período (calendários de início e fim + atalhos), no padrão dos
// filtros de data de mercado.
function mountDateRangeFilter(panel, { title, current, onApply }) {
  const rule = current instanceof FilterRule && current.kind === "range" ? current : null;
  const todayIso = filterIsoDay(new Date());
  const range = { from: rule?.from || "", to: rule?.to || "" };
  let preset = "custom";
  const startView = filterDateFromIso(range.from || todayIso);
  const views = [new Date(startView.getFullYear(), startView.getMonth() - (range.from ? 0 : 1), 1), null];
  const endView = range.to ? filterDateFromIso(range.to) : null;
  views[1] = endView && (endView.getFullYear() * 12 + endView.getMonth()) > (views[0].getFullYear() * 12 + views[0].getMonth())
    ? new Date(endView.getFullYear(), endView.getMonth(), 1)
    : new Date(views[0].getFullYear(), views[0].getMonth() + 1, 1);
  let pickYear = views[0].getFullYear();
  panel.classList.add("filter-dd-date");
  panel.style.maxHeight = "none";
  panel.innerHTML = `<div class="dd-head"><span>${esc(title)}</span><span>Período</span></div>
    <div class="dr">
      <div class="dr-main">
        <div class="dr-cals">
          ${[["from", "Início do período"], ["to", "Fim do período"]].map(([side, label], index) => `<div class="dr-col">
            <label>${label}</label><input class="dr-input" data-side="${side}" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10">
            <div class="dr-cal" data-cal="${index}"></div>
          </div>`).join("")}
        </div>
        <div class="dr-monthpick" hidden></div>
      </div>
      <div class="dr-presets">${FILTER_DATE_PRESETS.map(([id, label]) => `<button class="dr-preset" type="button" data-preset="${id}">${label}</button>`).join("")}</div>
    </div>
    <div class="dd-foot dr-foot"><button class="btn danger dd-clear" type="button">Limpar</button><span></span><button class="btn dr-cancel" type="button">Cancelar</button><button class="btn primary dd-apply" type="button">Filtrar</button></div>`;
  const inputs = { from: panel.querySelector('[data-side="from"]'), to: panel.querySelector('[data-side="to"]') };
  const calendarHtml = (view, index) => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const days = Array.from({ length: 42 }, (_, offset) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset));
    const cells = days.map((date) => {
      const iso = filterIsoDay(date);
      const to = range.to || range.from;
      const cls = [
        "dr-day",
        date.getMonth() !== month ? "out" : "",
        iso === todayIso ? "today" : "",
        range.from && iso >= range.from && iso <= to ? "in" : "",
        iso === range.from ? "start" : "",
        iso === to && range.from ? "end" : ""
      ].filter(Boolean).join(" ");
      return `<button class="${cls}" type="button" data-day="${iso}">${date.getDate()}</button>`;
    }).join("");
    return `<div class="dr-cal-head"><button class="dr-nav" type="button" data-nav="${index}" data-step="-1" aria-label="Mês anterior">«</button><b>${FILTER_MONTH_NAMES[month]} ${year}</b><button class="dr-nav" type="button" data-nav="${index}" data-step="1" aria-label="Próximo mês">»</button></div>
      <div class="dr-grid">${FILTER_WEEKDAYS.map((day) => `<span>${day}</span>`).join("")}${cells}</div>`;
  };
  const monthPickHtml = () => `<div class="dr-cal-head"><button class="dr-nav" type="button" data-year-step="-1" aria-label="Ano anterior">«</button><b>${pickYear}</b><button class="dr-nav" type="button" data-year-step="1" aria-label="Próximo ano">»</button></div>
    <div class="dr-months">${FILTER_MONTH_NAMES.map((name, index) => {
      const from = filterIsoDay(new Date(pickYear, index, 1));
      const on = range.from === from && range.to === filterIsoDay(new Date(pickYear, index + 1, 0));
      return `<button class="dr-month${on ? " on" : ""}" type="button" data-month="${index}">${name.slice(0, 3)}</button>`;
    }).join("")}</div>`;
  const draw = () => {
    inputs.from.value = filterBrDay(range.from);
    inputs.to.value = filterBrDay(range.to);
    panel.querySelectorAll(".dr-cal").forEach((calendar, index) => { calendar.innerHTML = calendarHtml(views[index], index); });
    const monthMode = preset === "month";
    panel.querySelector(".dr-cals").hidden = monthMode;
    const picker = panel.querySelector(".dr-monthpick");
    picker.hidden = !monthMode;
    if (monthMode) picker.innerHTML = monthPickHtml();
    panel.querySelectorAll("[data-preset]").forEach((button) => button.classList.toggle("on", button.dataset.preset === preset));
  };
  const showRange = () => {
    if (!range.from) return;
    const from = filterDateFromIso(range.from);
    views[0] = new Date(from.getFullYear(), from.getMonth(), 1);
    const to = filterDateFromIso(range.to || range.from);
    views[1] = (to.getFullYear() * 12 + to.getMonth()) > (from.getFullYear() * 12 + from.getMonth())
      ? new Date(to.getFullYear(), to.getMonth(), 1)
      : new Date(from.getFullYear(), from.getMonth() + 1, 1);
  };
  const stop = (event) => { event.preventDefault(); event.stopPropagation(); };
  panel.addEventListener("mousedown", (event) => {
    const day = event.target.closest("[data-day]");
    const nav = event.target.closest("[data-nav]");
    const presetButton = event.target.closest("[data-preset]");
    const monthButton = event.target.closest("[data-month]");
    const yearStep = event.target.closest("[data-year-step]");
    if (day) {
      stop(event);
      const iso = day.dataset.day;
      preset = "custom";
      if (!range.from || range.to) { range.from = iso; range.to = ""; }
      else if (iso < range.from) range.from = iso;
      else range.to = iso;
      draw();
    } else if (nav) {
      stop(event);
      const index = Number(nav.dataset.nav);
      views[index] = new Date(views[index].getFullYear(), views[index].getMonth() + Number(nav.dataset.step), 1);
      draw();
    } else if (presetButton) {
      stop(event);
      preset = presetButton.dataset.preset;
      const preset_range = filterPresetRange(preset);
      if (preset_range) { range.from = filterIsoDay(preset_range[0]); range.to = filterIsoDay(preset_range[1]); showRange(); }
      if (preset === "month" && range.from) pickYear = filterDateFromIso(range.from).getFullYear();
      draw();
    } else if (monthButton) {
      stop(event);
      const index = Number(monthButton.dataset.month);
      range.from = filterIsoDay(new Date(pickYear, index, 1));
      range.to = filterIsoDay(new Date(pickYear, index + 1, 0));
      showRange();
      draw();
    } else if (yearStep) {
      stop(event);
      pickYear += Number(yearStep.dataset.yearStep);
      draw();
    }
  });
  Object.entries(inputs).forEach(([side, input]) => {
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 8);
      input.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
    });
    input.addEventListener("change", () => {
      const iso = filterDayValue(input.value);
      if (input.value && !iso) { toast("Use a data no formato dd/mm/aaaa.", true); draw(); return; }
      range[side] = iso;
      if (range.from && range.to && range.to < range.from) [range.from, range.to] = [range.to, range.from];
      preset = "custom";
      showRange();
      draw();
    });
  });
  const on = (selector, handler) => panel.querySelector(selector).addEventListener("mousedown", (event) => { stop(event); handler(); });
  on(".dd-clear", () => onApply(null));
  on(".dr-cancel", () => panel.remove());
  on(".dd-apply", () => {
    ["from", "to"].forEach((side) => { const iso = filterDayValue(inputs[side].value); if (iso) range[side] = iso; });
    if (!range.from) { toast("Selecione o início do período.", true); return; }
    const to = range.to || range.from;
    onApply(new FilterRule("range", { from: range.from <= to ? range.from : to, to: range.from <= to ? to : range.from }));
  });
  draw();
  const rect = panel.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) panel.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  if (rect.bottom > window.innerHeight - 8) panel.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
}

// Monta o conteúdo do painel de filtro (cabeçalho, corpo e rodapé) e chama
// onApply com o novo filtro (Set, FilterRule ou null para limpar).
function mountColumnFilterPanel(panel, { title, values, key = "", hint = "", labelFor = (value) => (value === "" ? "(em branco)" : value), current = null, onApply }) {
  const kind = filterColumnKind(values, key, hint);
  if (kind === "date") { mountDateRangeFilter(panel, { title, current, onApply }); return; }
  const selected = new Set(current instanceof FilterRule ? [] : current || []);
  const rule = current instanceof FilterRule && current.kind === "number" ? current : null;
  const numberRule = kind === "number" ? `<div class="dd-rule">
      <select class="dd-rule-op"><option value="">Condição…</option>${FILTER_NUMBER_OPS.map(([id, label]) => `<option value="${id}"${rule?.op === id ? " selected" : ""}>${label}</option>`).join("")}</select>
      <div class="dd-rule-inputs"><input class="dd-rule-a" type="number" step="any" placeholder="Valor" value="${rule ? esc(String(rule.a)) : ""}"><span class="dd-rule-and">e</span><input class="dd-rule-b" type="number" step="any" placeholder="Valor" value="${rule?.op === "between" ? esc(String(rule.b)) : ""}"></div>
    </div>` : "";
  panel.innerHTML = `<div class="dd-head"><span>${esc(title)}</span><span>${values.length}</span></div>${numberRule}<div class="dd-search"><input placeholder="Buscar..."></div><div class="dd-list"></div>
    <div class="dd-foot"><button class="btn dd-all" type="button">Todos</button><button class="btn danger dd-clear" type="button">Limpar</button><button class="btn primary dd-apply" type="button">Aplicar</button></div>`;
  const list = panel.querySelector(".dd-list");
  const search = panel.querySelector(".dd-search input");
  const op = panel.querySelector(".dd-rule-op");
  const syncRuleInputs = () => {
    if (!op) return;
    panel.querySelector(".dd-rule-inputs").hidden = !op.value;
    panel.querySelector(".dd-rule-and").hidden = op.value !== "between";
    panel.querySelector(".dd-rule-b").hidden = op.value !== "between";
  };
  const draw = () => {
    const query = String(search?.value || "").trim().toLocaleLowerCase("pt-BR");
    list.innerHTML = values.filter((value) => !query || value.toLocaleLowerCase("pt-BR").includes(query) || labelFor(value).toLocaleLowerCase("pt-BR").includes(query))
      .map((value) => `<div class="dd-item${selected.has(value) ? " on" : ""}" data-value="${esc(value)}"><span class="dd-check">${selected.has(value) ? "✓" : ""}</span><span>${esc(labelFor(value))}</span></div>`).join("");
    list.querySelectorAll(".dd-item").forEach((item) => item.addEventListener("mousedown", (event) => {
      event.preventDefault(); event.stopPropagation();
      const value = item.dataset.value;
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      draw();
    }));
  };
  draw();
  syncRuleInputs();
  op?.addEventListener("change", syncRuleInputs);
  search?.addEventListener("input", draw);
  const on = (selector, handler) => panel.querySelector(selector).addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); handler(); });
  on(".dd-all", () => {
    if (selected.size === values.length) selected.clear(); else values.forEach((value) => selected.add(value));
    draw();
  });
  on(".dd-clear", () => onApply(null));
  on(".dd-apply", () => {
    if (op?.value) {
      const a = Number(panel.querySelector(".dd-rule-a").value);
      const b = Number(panel.querySelector(".dd-rule-b").value);
      const hasA = panel.querySelector(".dd-rule-a").value !== "" && Number.isFinite(a);
      const hasB = panel.querySelector(".dd-rule-b").value !== "" && Number.isFinite(b);
      if (!hasA || (op.value === "between" && !hasB)) { toast("Informe o valor da condição.", true); return; }
      onApply(new FilterRule("number", { op: op.value, a, b: op.value === "between" ? b : null }));
      return;
    }
    onApply(selected.size && selected.size < values.length ? new Set(selected) : null);
  });
  (op && rule ? op : search)?.focus();
}

function openColumnFilter(th, key) {
  document.getElementById("filter-dd")?.remove();
  const col = columns(state.tab, cache).find((item) => item.k === key);
  const allRows = cache[state.tab] || [];
  const values = [...new Set(allRows.map((r) => String(r[key] ?? "")))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const filters = tabFilters();
  const rect = th.getBoundingClientRect();
  const dd = document.createElement("div");
  dd.id = "filter-dd";
  dd.className = "filter-dd";
  dd.style.left = Math.min(rect.left, window.innerWidth - 330) + "px";
  dd.style.top = Math.min(rect.bottom + 4, window.innerHeight - 360) + "px";
  document.body.appendChild(dd);
  const labelFor = (v) => {
    const sample = allRows.find((r) => String(r[key] ?? "") === v) || {};
    return v === "" ? "(em branco)" : displayValue(sample, col, cache);
  };
  mountColumnFilterPanel(dd, {
    title: `▼ ${col?.h || key}`, values, key, labelFor, current: filters[key],
    hint: col?.num ? "number" : col?.fmt === dt ? "date" : "",
    onApply: (rule) => {
      if (rule) filters[key] = rule; else delete filters[key];
      if (state.pages[state.tab]) state.pages[state.tab] = 1;
      closeFloaters(); render();
    }
  });
  setTimeout(() => {
    const outside = (e) => {
      if (!dd.contains(e.target) && e.target !== th) {
        dd.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function openColumnManager() {
  document.getElementById("cols-dd")?.remove();
  const baseCols = columns(state.tab, cache);
  const prefs = colPrefs[state.tab] || {};
  let order = orderedColumns(state.tab, cache).map((col) => col.k);
  let listMode = "all";
  let draggedKey = null;
  const panel = document.createElement("div");
  panel.id = "cols-dd";
  panel.className = "cols-dd";
  panel.innerHTML = `
    <div class="column-manager-head"><span>⊞ Colunas · ${esc(ENTITY_LABEL[state.tab] || state.tab)}</span><button class="column-manager-close" type="button" title="Fechar">×</button></div>
    <div class="column-manager-controls">
      <button class="column-manager-preset" id="cols-dd-reset" type="button">↺ Padrão · ${esc(ENTITY_LABEL[state.tab] || state.tab)}</button>
      <select class="column-manager-filter" id="cols-dd-filter" aria-label="Filtrar colunas">
        <option value="all">Todos</option>
        <option value="visible">Visíveis</option>
        <option value="hidden">Ocultas</option>
      </select>
    </div>
    <div class="column-manager-list" id="cols-dd-list"></div>`;
  document.body.appendChild(panel);
  const colsInOrder = () => order.map((key) => baseCols.find((col) => col.k === key)).filter(Boolean);
  const draw = () => {
    const listed = colsInOrder().filter((col) => listMode === "all" || (listMode === "visible" ? prefs[col.k] !== false : prefs[col.k] === false));
    panel.querySelector("#cols-dd-list").innerHTML = listed.map((col) => {
      const on = prefs[col.k] !== false;
      return `<div class="column-manager-row${on ? "" : " off"}" data-k="${esc(col.k)}" draggable="true">
        <span class="column-drag-handle" title="Arrastar para reordenar">⠿</span>
        <button class="column-switch${on ? " on" : ""}" type="button" role="switch" aria-checked="${on}" title="${on ? "Ocultar" : "Exibir"} ${esc(col.h)}"></button>
        <span class="column-manager-label">${esc(col.h)}</span>
      </div>`;
    }).join("");
    panel.querySelectorAll(".column-manager-row").forEach((item) => {
      item.querySelector(".column-switch").addEventListener("click", () => {
        const visibleCount = baseCols.filter((col) => prefs[col.k] !== false).length;
        const k = item.dataset.k;
        if (prefs[k] !== false && visibleCount <= 1) return;
        prefs[k] = prefs[k] === false;
        prefs.__order = [...order];
        colPrefs[state.tab] = prefs;
        saveColPrefs();
        draw();
        render();
      });
      item.addEventListener("dragstart", (event) => {
        draggedKey = item.dataset.k;
        item.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedKey);
      });
      item.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (draggedKey && draggedKey !== item.dataset.k) item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const targetKey = item.dataset.k;
        item.classList.remove("drag-over");
        if (!draggedKey || draggedKey === targetKey) return;
        const from = order.indexOf(draggedKey);
        const to = order.indexOf(targetKey);
        order.splice(from, 1);
        order.splice(to, 0, draggedKey);
        prefs.__order = [...order];
        colPrefs[state.tab] = prefs;
        saveColPrefs();
        draggedKey = null;
        draw();
        render();
      });
      item.addEventListener("dragend", () => {
        draggedKey = null;
        panel.querySelectorAll(".column-manager-row").forEach((row) => row.classList.remove("dragging", "drag-over"));
      });
    });
  };
  draw();
  panel.querySelector(".column-manager-close").addEventListener("click", () => panel.remove());
  panel.querySelector("#cols-dd-filter").addEventListener("change", (event) => {
    listMode = event.target.value;
    draw();
  });
  panel.querySelector("#cols-dd-reset").addEventListener("click", () => {
    Object.keys(prefs).forEach((key) => delete prefs[key]);
    order = baseCols.map((col) => col.k);
    colPrefs[state.tab] = prefs;
    saveColPrefs();
    listMode = "all";
    panel.querySelector("#cols-dd-filter").value = "all";
    draw();
    render();
  });
  setTimeout(() => {
    const outside = (e) => {
      if (!panel.contains(e.target) && e.target.id !== "cols-btn") {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

const SECONDARY_COL_PREFS_KEY = "crm_secondary_cols_v1";
let secondaryColPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(SECONDARY_COL_PREFS_KEY) || "{}"); }
  catch (e) { return {}; }
})();

function secondaryColumnPrefs(scope) {
  if (!secondaryColPrefs[scope]) secondaryColPrefs[scope] = {};
  return secondaryColPrefs[scope];
}

function saveSecondaryColumnPrefs() {
  localStorage.setItem(SECONDARY_COL_PREFS_KEY, JSON.stringify(secondaryColPrefs));
}

function orderedColumnDefinitions(definitions, prefs) {
  const savedOrder = Array.isArray(prefs.__order) ? prefs.__order : [];
  const byKey = Object.fromEntries(definitions.map((col) => [col.k, col]));
  return [
    ...savedOrder.map((key) => byKey[key]).filter(Boolean),
    ...definitions.filter((col) => !savedOrder.includes(col.k))
  ];
}

function openSecondaryColumnManager({ scope, label, definitions, onChange }) {
  document.getElementById("cols-dd")?.remove();
  const prefs = secondaryColumnPrefs(scope);
  let order = orderedColumnDefinitions(definitions, prefs).map((col) => col.k);
  let listMode = "all";
  let draggedKey = null;
  const panel = document.createElement("div");
  panel.id = "cols-dd";
  panel.className = "cols-dd";
  panel.innerHTML = `
    <div class="column-manager-head"><span>⊞ Colunas · ${esc(label)}</span><button class="column-manager-close" type="button" title="Fechar">×</button></div>
    <div class="column-manager-controls">
      <button class="column-manager-preset" type="button">↺ Padrão · ${esc(label)}</button>
      <select class="column-manager-filter" aria-label="Filtrar colunas">
        <option value="all">Todos</option><option value="visible">Visíveis</option><option value="hidden">Ocultas</option>
      </select>
    </div>
    <div class="column-manager-list"></div>`;
  document.body.appendChild(panel);
  const ordered = () => order.map((key) => definitions.find((col) => col.k === key)).filter(Boolean);
  const persist = () => {
    prefs.__order = [...order];
    secondaryColPrefs[scope] = prefs;
    saveSecondaryColumnPrefs();
    onChange();
  };
  const draw = () => {
    const listed = ordered().filter((col) => listMode === "all" || (listMode === "visible" ? prefs[col.k] !== false : prefs[col.k] === false));
    panel.querySelector(".column-manager-list").innerHTML = listed.map((col) => {
      const on = prefs[col.k] !== false;
      return `<div class="column-manager-row${on ? "" : " off"}" data-k="${esc(col.k)}" draggable="true">
        <span class="column-drag-handle" title="Arrastar para reordenar">⠿</span>
        <button class="column-switch${on ? " on" : ""}" type="button" role="switch" aria-checked="${on}" title="${on ? "Ocultar" : "Exibir"} ${esc(col.h)}"></button>
        <span class="column-manager-label">${esc(col.h)}</span>
      </div>`;
    }).join("");
    panel.querySelectorAll(".column-manager-row").forEach((item) => {
      item.querySelector(".column-switch").addEventListener("click", () => {
        const visibleCount = definitions.filter((col) => prefs[col.k] !== false).length;
        const key = item.dataset.k;
        if (prefs[key] !== false && visibleCount <= 1) return;
        prefs[key] = prefs[key] === false;
        persist();
        draw();
      });
      item.addEventListener("dragstart", (event) => {
        draggedKey = item.dataset.k;
        item.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedKey);
      });
      item.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (draggedKey && draggedKey !== item.dataset.k) item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const targetKey = item.dataset.k;
        item.classList.remove("drag-over");
        if (!draggedKey || draggedKey === targetKey) return;
        const from = order.indexOf(draggedKey);
        const to = order.indexOf(targetKey);
        order.splice(from, 1);
        order.splice(to, 0, draggedKey);
        draggedKey = null;
        persist();
        draw();
      });
      item.addEventListener("dragend", () => {
        draggedKey = null;
        panel.querySelectorAll(".column-manager-row").forEach((row) => row.classList.remove("dragging", "drag-over"));
      });
    });
  };
  draw();
  panel.querySelector(".column-manager-close").addEventListener("click", () => panel.remove());
  panel.querySelector(".column-manager-filter").addEventListener("change", (event) => {
    listMode = event.target.value;
    draw();
  });
  panel.querySelector(".column-manager-preset").addEventListener("click", () => {
    Object.keys(prefs).forEach((key) => delete prefs[key]);
    order = definitions.map((col) => col.k);
    listMode = "all";
    panel.querySelector(".column-manager-filter").value = "all";
    persist();
    draw();
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !event.target.closest(".registration-cols-btn,.tools-cols-btn,.project-cols-btn")) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function csvCell(v) {
  const s = String(v ?? "").replace(/<[^>]+>/g, "");
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCSV(cols, rows, filename) {
  const header = cols.map((col) => csvCell(col.h)).join(";");
  const body = rows.map((row) => cols.map((col) => {
    const val = col.csv ? col.csv(row[col.k], row, cache) : (col.fmt ? col.fmt(row[col.k], row, cache) : row[col.k] ?? "");
    return csvCell(val);
  }).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  a.href = url;
  a.download = filename || `entepriser_crm_${state.tab}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportTableCSV(activeOnly) {
  const cols = activeOnly ? visibleColumns(state.tab, cache) : columns(state.tab, cache);
  const rows = rowsFor(state.tab, cache);
  const suffix = activeOnly ? "colunas_ativas" : "todas_colunas";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  downloadCSV(cols, rows, `entepriser_crm_${state.tab}_${suffix}_${stamp}.csv`);
  toast(`CSV exportado: ${rows.length} linhas.`);
}

// ---------- Importação por planilha ----------
// Cada módulo principal importa as próprias colunas (CSV, XLS ou XLSX) e
// oferece uma planilha modelo com as colunas e os valores aceitos.
const importNorm = (value) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const importDigits = (value) => String(value ?? "").replace(/\D/g, "");
const importSplit = (value) => String(value ?? "").split(/[;\n]|,(?!\d)/).map((item) => item.trim()).filter(Boolean);

function importDateValue(value) {
  // Datas do Excel podem chegar alguns segundos antes da meia-noite; arredonda para o dia.
  if (value instanceof Date && !Number.isNaN(value.getTime())) return filterIsoDay(new Date(value.getTime() + 12 * 3600000));
  if (typeof value === "number" && value > 20000 && value < 80000) return new Date(Math.round((value - 25569) * 86400000)).toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const short = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (short) {
    const year = short[3].length === 2 ? `20${short[3]}` : short[3];
    return `${year}-${short[2].padStart(2, "0")}-${short[1].padStart(2, "0")}`;
  }
  return filterDayValue(text) || undefined;
}

function importMatchOption(options, value) {
  const wanted = importNorm(value);
  if (!wanted) return null;
  return options.find((option) => importNorm(option.value) === wanted || importNorm(option.label) === wanted) || undefined;
}

function importCompanyMatch(value, c = cache) {
  const digits = importDigits(value);
  const wanted = importNorm(value);
  return (c.companies || []).find((company) => (digits.length === 14 && importDigits(company.tax_id) === digits)
    || importNorm(company.trade_name) === wanted || importNorm(company.legal_name) === wanted);
}

// Especificação de importação de cada módulo.
function importSpec(tab, c = cache) {
  if (String(tab).startsWith("reg:")) return registrationImportSpec(tab.slice(4), c);
  const opts = (values) => values.map((value) => ({ value, label: value }));
  if (tab === "contacts") return {
    title: "Pessoas",
    columns: [
      { key: "name", header: "Nome completo", req: true, note: "Texto" },
      { key: "phone", header: "Telefone/celular", note: "Vários separados por ;" },
      { key: "email", header: "Email(s)", note: "Vários separados por ;" },
      { key: "contact_type", header: "Tipo de contato", type: "multi", options: () => opts(CONTACT_TYPE_OPTIONS) },
      { key: "channel", header: "Canal", type: "select", options: () => opts(CONTACT_CHANNEL_OPTIONS) },
      { key: "job_title", header: "Cargo" },
      { key: "department", header: "Departamento" },
      { key: "company_ids", header: "Empresa(s)", type: "companies", note: "CNPJ ou nome da empresa já cadastrada; vários separados por ;" },
      { key: "linkedin", header: "LinkedIn" }, { key: "facebook", header: "Facebook" }, { key: "instagram", header: "Instagram" },
      { key: "reddit", header: "Reddit" }, { key: "whatsapp", header: "WhatsApp" }, { key: "youtube", header: "YouTube" },
      { key: "groups", header: "Grupos/comunidades", type: "free", note: "Vários separados por ;" },
      { key: "tags", header: "Tags", type: "free", note: "Vários separados por ;" },
      { key: "notes", header: "Observações" },
      { key: "birth_date", header: "Data de nascimento", type: "date" },
      { key: "cpf", header: "CPF" }
    ],
    existing: (body) => {
      const name = importNorm(body.name);
      const phone = importDigits(body.phone);
      const emails = normalizeEmailList(body.email || "").toLowerCase().split(/[;,]/).map((item) => item.trim()).filter(Boolean);
      return (c.contacts || []).find((contact) => importNorm(contact.name) === name && (
        (phone && importDigits(contact.phone).includes(phone))
        || (emails.length && emails.some((email) => normalizeEmailList(contact.email || "").toLowerCase().includes(email)))));
    },
    async save(body, existing) {
      const companyIds = normalizeIdList(body.company_ids);
      const payload = { ...body };
      delete payload.company_ids;
      payload.contact_type = normalizeTextList(payload.contact_type).join("; ") || null;
      payload.groups = normalizeTextList(payload.groups).join("; ") || null;
      payload.tags = normalizeTextList(payload.tags);
      if (payload.phone) payload.phone = normalizePhoneList(payload.phone);
      if (payload.email) payload.email = normalizeEmailList(payload.email);
      payload.company_id = companyIds[0] || existing?.company_id || null;
      const saved = existing ? await updateRow("contacts", existing.id, payload) : await createRow("contacts", payload);
      if (companyIds.length) await replaceContactCompanyLinks({ contactId: saved.id, relatedIds: [...new Set([...normalizeIdList(existing?.company_ids), ...companyIds])] });
      return saved;
    }
  };
  if (tab === "companies") return {
    title: "Empresas",
    intro: "Informe só o CNPJ e os campos editáveis. A empresa é cadastrada na hora com a tag Desatualizada e os dados da Receita são preenchidos automaticamente em segundo plano.",
    columns: [
      { key: "tax_id", header: "CNPJ", req: true, note: "14 dígitos, com ou sem máscara" },
      { key: "contact_type", header: "Tipo de contato", type: "multi", options: () => opts(COMPANY_CONTACT_TYPE_OPTIONS) },
      { key: "municipal_registration", header: "Inscrição municipal" },
      { key: "notes", header: "Observações" }
    ],
    validate: (body) => importDigits(body.tax_id).length === 14 ? "" : "CNPJ precisa ter 14 dígitos",
    existing: (body) => (c.companies || []).find((company) => importDigits(company.tax_id) === importDigits(body.tax_id)),
    async save(body, existing) {
      const types = normalizeTextList(body.contact_type).filter((type) => COMPANY_CONTACT_TYPE_OPTIONS.includes(type));
      if (companyHasDelivery(body.tax_id) && !types.includes("Cliente")) types.unshift("Cliente");
      const editable = { contact_type: types.join("; ") || existing?.contact_type || null };
      if (body.municipal_registration) editable.municipal_registration = body.municipal_registration;
      if (body.notes) editable.notes = body.notes;
      let saved;
      if (existing) saved = await updateRow("companies", existing.tax_id, editable);
      else {
        const taxId = importDigits(body.tax_id).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
        saved = await createRow("companies", { tax_id: taxId, ...editable, registry_pending: true, registry_error: null });
      }
      if (types.length) await syncCompanyContactTypes(saved.tax_id, existing?.contact_ids || [], types);
      return saved;
    }
  };
  if (tab === "deals") return {
    title: "Negócios",
    columns: [
      { key: "title", header: "Título", req: true },
      { key: "company_id", header: "Empresa", type: "company", note: "CNPJ ou nome; vazio = não possui empresa" },
      { key: "contact_id", header: "Contato", type: "contact", note: "Nome ou e-mail da pessoa cadastrada" },
      { key: "product_id", header: "Produto", type: "select", options: () => refOptions("products", c) },
      { key: "pipeline_id", header: "Pipeline", type: "select", options: () => (c.pipelines || []).map((pipeline) => ({ value: pipeline.id, label: pipeline.name })), note: "Vazio usa o primeiro pipeline" },
      { key: "stage", header: "Etapa", note: "Etapa do pipeline" },
      { key: "status", header: "Status", type: "select", options: () => STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })), note: "Vazio = Aberto" },
      { key: "lead_source", header: "Origem do lead", type: "select", options: () => opts(SOURCES) },
      { key: "amount", header: "Valor (R$)", type: "number" },
      { key: "expected_close_date", header: "Previsão", type: "date" }
    ],
    validate: (body) => {
      const pipeline = (c.pipelines || []).find((item) => item.id === body.pipeline_id) || (c.pipelines || [])[0];
      if (!pipeline) return "Cadastre um pipeline antes de importar";
      body.pipeline_id = pipeline.id;
      if (body.stage) {
        const stage = (pipeline.stages || []).find((item) => importNorm(item) === importNorm(body.stage));
        if (!stage) return `Etapa "${body.stage}" não existe no pipeline ${pipeline.name}`;
        body.stage = stage;
      } else body.stage = (pipeline.stages || [])[0] || null;
      body.status = body.status || "open";
      body.no_company = !body.company_id;
      return "";
    },
    async save(body) {
      const saved = await createRow("deals", body);
      if (body.status === "won" && body.company_id) await createProjectFromDeal({ id: saved.id, company_id: body.company_id, contact_id: body.contact_id, product_id: body.product_id, title: body.title });
      return saved;
    }
  };
  if (tab === "projects") return {
    title: "Entregas",
    columns: [
      { key: "company_id", header: "Empresa", type: "company", req: true, note: "CNPJ ou nome da empresa já cadastrada" },
      { key: "client_name", header: "Cliente", req: true },
      { key: "product_id", header: "Produto", type: "select", req: true, options: () => refOptions("products", c) },
      { key: "delivery_type", header: "Tipo", type: "select", options: () => opts(["Projeto", "Imersão", "Treinamento", "Consultoria", "Evento", "Serviço recorrente", "Outro"]) },
      { key: "group_name", header: "Grupo" },
      { key: "status", header: "Status", type: "select", options: () => PROJECT_STATUSES.map((status) => ({ value: status, label: PROJECT_STATUS_LABEL[status] })), note: "Vazio = Ativo" },
      { key: "substatus", header: "Substatus", type: "select", options: () => PROJECT_SUBSTATUS.map((status) => ({ value: status, label: PROJECT_SUBSTATUS_LABEL[status] })) },
      { key: "start_date", header: "Início", type: "date" },
      { key: "end_date", header: "Fim", type: "date", note: "Vazio usa a duração do produto" },
      { key: "erp_platform", header: "ERP", type: "select", options: () => deliveryChannelOptions("erp") },
      { key: "marketplace_channels", header: "Marketplaces", type: "multi", options: () => deliveryChannelOptions("marketplaces") },
      { key: "store_platforms", header: "Lojas", type: "multi", options: () => deliveryChannelOptions("stores") },
      { key: "freight_channels", header: "Frete", type: "multi", options: () => deliveryChannelOptions("freight") },
      { key: "company_setup", header: "Situação da empresa", type: "select", options: () => opts(DELIVERY_COMPANY_SETUP_OPTIONS) },
      { key: "financial_accounts", header: "Contas financeiras", type: "multi", options: () => deliveryChannelOptions("financial") }
    ],
    validate: (body) => {
      body.status = body.status || "active";
      if (body.status === "active") body.substatus = null;
      if (body.status === "closed") body.substatus = "closed";
      if (body.status === "inactive" && !body.substatus) return "Entrega inativa precisa de substatus (Suporte ou Encerrado)";
      body.delivery_type = body.delivery_type || deliveryTypeForProduct(c.productById?.[body.product_id]);
      body.start_date = body.start_date || filterIsoDay(new Date());
      const product = c.productById?.[body.product_id];
      if (!body.end_date && product?.duration_days) body.end_date = addDaysRoundedToMonthEnd(body.start_date, product.duration_days);
      ["marketplace_channels", "store_platforms", "freight_channels", "financial_accounts"].forEach((key) => { body[key] = normalizeTextList(body[key]); });
      const auto = deliveryAutoSetups(body.marketplace_channels, body.store_platforms);
      body.freight_channels = normalizeTextList([...body.freight_channels, ...auto.freight]);
      body.financial_accounts = normalizeTextList([...body.financial_accounts, ...auto.financial]);
      body.name = deliveryGeneratedName(body.client_name, body.product_id);
      return "";
    },
    async save(body) {
      const saved = await createRow("projects", { ...body, source: "import" });
      await provisionDeliveryResources(saved);
      await ensureCompanyClientType(body.company_id);
      return saved;
    }
  };
  if (tab === "activities") return {
    title: "Tarefas",
    intro: "Cria tarefas do dia a dia em entregas existentes. As tarefas dos produtos continuam vindo do cadastro do produto.",
    columns: [
      { key: "project_id", header: "Entrega", type: "project", req: true, note: "Nome exato da entrega (EC365 | Cliente | Produto)" },
      { key: "title", header: "Tarefa", req: true },
      { key: "priority", header: "Prioridade", type: "select", options: () => PRIORITY_OPTIONS.map(([value, label]) => ({ value, label })), note: "Vazio = Normal" },
      { key: "category", header: "Categoria" }, { key: "channel", header: "Canal" },
      { key: "module", header: "Módulo" }, { key: "submodule", header: "Submódulo" }, { key: "type", header: "Tipo" },
      { key: "information", header: "Informação" },
      { key: "planned_start_date", header: "Início previsto", type: "date" },
      { key: "planned_end_date", header: "Término previsto", type: "date" }
    ],
    validate: (body) => {
      if (body.planned_start_date && body.planned_end_date && body.planned_end_date < body.planned_start_date) return "Término previsto antes do início";
      return "";
    },
    async save(body) {
      const tasks = loadProjectTasks();
      const now = new Date().toISOString();
      const draft = {
        id: crypto.randomUUID(), parent_activity_id: null, ...body,
        priority: body.priority || "normal", recurrence: "once", consider_business_days: false,
        dependency_ids: [], assignee_ids: [], assignee_job_titles: [], document_ids: [], custom_table_ids: [], checklist: [],
        due_date: body.planned_end_date || null, schedule_manual: Boolean(body.planned_start_date), status: "todo",
        sort_order: Math.max(-1, ...tasks.filter((task) => task.project_id === body.project_id && !task.parent_activity_id).map((task) => Number(task.sort_order || 0))) + 1,
        created_at: now, updated_at: now
      };
      const saved = isLive() ? await createRow("activities", draft) : draft;
      tasks.push(saved);
      if (isLive()) cache.activityRecords = tasks; else saveProjectTasks(tasks);
      return saved;
    }
  };
  return null;
}

// Importação dos submódulos de Cadastros.
function importProductIds(value, c = cache) {
  const ids = [];
  for (const item of importSplit(value)) {
    const product = (c.products || []).find((entry) => importNorm(entry.name) === importNorm(item));
    if (!product) return { error: `Produto "${item}" não encontrado` };
    ids.push(product.id);
  }
  return { value: ids };
}

function registrationImportSpec(section, c = cache) {
  const opts = (values) => values.map((value) => ({ value, label: value }));
  const products = { key: "product_ids", header: "Produto(s)", type: "products", req: true, note: "Nome do produto cadastrado; vários separados por ;" };
  const initialPipelines = (c.pipelines || []).length;
  const nextOrder = (rows, productId) => Math.max(-1, ...rows.filter((item) => item.product_id === productId).map((item) => Number(item.sort_order || 0))) + 1;
  if (section === "products") return {
    title: "Produtos",
    columns: [
      { key: "category", header: "Categoria" },
      { key: "name", header: "Produto", req: true },
      { key: "description", header: "Descrição" },
      { key: "price", header: "Preço à vista (R$)", type: "number" },
      { key: "price_installment", header: "Preço parcelado (R$)", type: "number" },
      { key: "sales_page", header: "Página de vendas" },
      { key: "duration_days", header: "Duração da entrega (dias)", type: "number" },
      { key: "status", header: "Status", type: "select", options: () => opts(["Ativo", "Pausado", "Inativo"]), note: "Vazio = Ativo" }
    ],
    existing: (body) => (c.products || []).find((item) => importNorm(item.name) === importNorm(body.name)),
    async save(body, existing) {
      const payload = { ...body, status: body.status || existing?.status || "Ativo" };
      return existing ? updateRow("products", existing.id, payload) : createRow("products", payload);
    }
  };
  if (section === "pipelines") return {
    title: "Pipelines",
    columns: [
      { key: "name", header: "Nome", req: true },
      { key: "stages", header: "Etapas", type: "free", req: true, note: "Na ordem, separadas por ;. Ganho e Perdido já existem." }
    ],
    existing: (body) => (c.pipelines || []).find((item) => importNorm(item.name) === importNorm(body.name)),
    validate: (body) => {
      body.stages = body.stages.filter((stage) => !["ganho", "perdido"].includes(importNorm(stage)));
      return body.stages.length ? "" : "Informe ao menos uma etapa";
    },
    async save(body, existing, context) {
      context.pipelinesCreated = context.pipelinesCreated || 0;
      if (!existing && initialPipelines + context.pipelinesCreated >= 5) throw new Error("Limite de cinco pipelines atingido");
      if (existing) return updateRow("pipelines", existing.id, { stages: body.stages });
      context.pipelinesCreated += 1;
      return createRow("pipelines", body);
    }
  };
  if (section === "users") return {
    title: "Usuários",
    adminOnly: true,
    intro: "Usuários novos recebem uma senha gerada; ao final a lista de acessos é exibida para copiar. Permissões seguem o padrão do perfil.",
    columns: [
      { key: "full_name", header: "Nome", req: true },
      { key: "nickname", header: "Apelido" },
      { key: "email", header: "E-mail", req: true },
      { key: "phone", header: "Telefone" },
      { key: "role", header: "Perfil", type: "select", options: () => Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })), note: "Vazio = Colaborador" },
      { key: "function_name", header: "Função" },
      { key: "job_title", header: "Cargo" },
      { key: "status", header: "Status", type: "select", options: () => [{ value: "active", label: "Ativo" }, { value: "inactive", label: "Inativo" }], note: "Vazio = Ativo" }
    ],
    validate: (body) => { body.email = String(body.email || "").trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) ? "" : "E-mail inválido"; },
    existing: (body) => (c.users || []).find((item) => String(item.email || "").toLowerCase() === body.email),
    async save(body, existing, context) {
      const role = body.role || normalizedProfileRole(existing?.role) || "collaborator";
      const payload = {
        full_name: body.full_name, nickname: body.nickname || existing?.nickname || null, email: body.email,
        phone: body.phone || existing?.phone || null, role, company_ids: normalizeTextList(existing?.company_ids),
        function_name: body.function_name || existing?.function_name || null, job_title: body.job_title || existing?.job_title || null,
        status: body.status || existing?.status || "active",
        permissions: role === "admin" ? {} : existing ? normalizeUserPermissions(existing.permissions) : defaultPermissionsForRole(role)
      };
      const password = existing?.auth_user_id ? "" : generateStrongPassword();
      if (isLive()) {
        const result = await callUserAdmin("save-user", { profile_id: existing?.id || null, ...payload, ...(password ? { password } : {}) });
        if (password) context.credentials.push({ name: payload.full_name, email: payload.email, password });
        return fromRemoteRow("users", result.profile);
      }
      const saved = existing ? await updateRow("users", existing.id, payload) : await createRow("users", { ...payload, auth_user_id: crypto.randomUUID() });
      if (password) context.credentials.push({ name: payload.full_name, email: payload.email, password });
      return saved;
    }
  };
  if (section === "activities") return {
    title: "Tarefas (modelos)",
    intro: "Cada linha cria a tarefa em todos os produtos informados. Sem o nome da tarefa, o nome usa a estrutura (exige Categoria, Canal, Módulo e Tipo).",
    columns: [
      products,
      { key: "category", header: "Categoria" }, { key: "channel", header: "Canal" },
      { key: "module", header: "Módulo" }, { key: "submodule", header: "Submódulo" },
      { key: "activity", header: "Tarefa", note: "Vazio = usar estrutura" },
      { key: "type", header: "Tipo" },
      { key: "priority", header: "Prioridade", type: "select", options: () => PRIORITY_OPTIONS.map(([value, label]) => ({ value, label })), note: "Vazio = Normal" },
      { key: "recurrence", header: "Recorrência", type: "select", options: () => RECURRENCE_OPTIONS.map(([value, label]) => ({ value, label })), note: "Vazio = Única" },
      { key: "target_days", header: "Prazo (dias)", type: "number" },
      { key: "start_after_days", header: "Iniciar após dependência (dias)", type: "number" },
      { key: "consider_business_days", header: "Dias úteis", type: "select", options: () => [{ value: "sim", label: "Sim" }, { value: "nao", label: "Não" }] },
      { key: "information", header: "Informação" }
    ],
    validate: (body) => !body.activity && !["category", "channel", "module", "type"].every((key) => body[key]) ? "Informe a Tarefa ou Categoria, Canal, Módulo e Tipo" : "",
    async save(body) {
      const rows = loadProductActivities();
      const groupId = crypto.randomUUID();
      const now = new Date().toISOString();
      let saved = null;
      for (const productId of body.product_ids) {
        const draft = {
          id: crypto.randomUUID(), product_id: productId, template_group_id: groupId, parent_template_id: null,
          activity: body.activity || "", category: body.category || "", channel: body.channel || "", module: body.module || "",
          submodule: body.submodule || "", type: body.type || "", group: "", subgroup: "", sector: "", subsector: "",
          priority: body.priority || "normal", recurrence: body.recurrence || "once",
          target_days: body.target_days ?? null, start_after_days: body.start_after_days ?? null,
          consider_business_days: body.consider_business_days === "sim", information: body.information || "",
          document_ids: [], custom_table_ids: [], checklist: [], default_owner_id: null, default_assignee_ids: [], default_assignee_job_titles: [],
          assign_to_client: false, depends_on_template_id: null, dependency_template_ids: [], objective_template_id: null,
          sort_order: nextOrder(rows, productId), created_at: now, updated_at: now
        };
        saved = isLive() ? await createRow("productActivities", draft) : draft;
        rows.push(saved);
      }
      if (isLive()) cache.productActivities = rows; else saveProductActivities(rows);
      return saved;
    }
  };
  if (section === "goals") return {
    title: "Metas (modelos)",
    columns: [
      products,
      { key: "name", header: "Meta", req: true },
      { key: "metric", header: "Indicador", req: true },
      { key: "comparison", header: "Comparação", type: "select", options: () => Object.entries(GOAL_COMPARISON_LABEL).map(([value, label]) => ({ value, label })), note: "Vazio = No mínimo" },
      { key: "target_value", header: "Valor-alvo", type: "number", req: true },
      { key: "unit", header: "Unidade" },
      { key: "category", header: "Categoria" }, { key: "channel", header: "Canal" },
      { key: "notes", header: "Observações" },
      { key: "target_days", header: "Prazo (dias)", type: "number" }
    ],
    async save(body) {
      const rows = loadProductGoals();
      const now = new Date().toISOString();
      let saved = null;
      for (const productId of body.product_ids) {
        const draft = {
          id: crypto.randomUUID(), product_id: productId, name: body.name, metric: body.metric, comparison: body.comparison || "at_least",
          target_value: Number(body.target_value), unit: body.unit || "", comments: "", category: body.category || "", channel: body.channel || "",
          notes: body.notes || "", target_days: body.target_days ?? null, default_owner_id: null, default_assignee_ids: [], assign_to_client: false,
          dependency_goal_template_ids: [], dependency_activity_template_ids: [], sort_order: nextOrder(rows, productId), created_at: now, updated_at: now
        };
        saved = isLive() ? await createRow("productGoals", draft) : draft;
        rows.push(saved);
      }
      if (isLive()) cache.productGoals = rows; else saveProductGoals(rows);
      return saved;
    }
  };
  if (section === "objectives") return {
    title: "Objetivos (modelos)",
    columns: [
      products,
      { key: "name", header: "Objetivo", req: true },
      { key: "completion_criteria", header: "Critério de conclusão" },
      { key: "category", header: "Categoria" }, { key: "channel", header: "Canal" },
      { key: "notes", header: "Observações" },
      { key: "target_days", header: "Prazo (dias)", type: "number" }
    ],
    async save(body) {
      const rows = loadProductObjectives();
      const now = new Date().toISOString();
      let saved = null;
      for (const productId of body.product_ids) {
        const draft = {
          id: crypto.randomUUID(), product_id: productId, name: body.name, completion_criteria: body.completion_criteria || "", comments: "",
          category: body.category || "", channel: body.channel || "", notes: body.notes || "", default_owner_id: null, default_assignee_ids: [],
          assign_to_client: false, dependency_objective_template_ids: [], dependency_activity_template_ids: [],
          target_days: body.target_days ?? null, sort_order: nextOrder(rows, productId), created_at: now, updated_at: now
        };
        saved = isLive() ? await createRow("productObjectives", draft) : draft;
        rows.push(saved);
      }
      if (isLive()) cache.productObjectives = rows; else saveProductObjectives(rows);
      return saved;
    }
  };
  return null;
}

// Fila em segundo plano que busca na Receita as empresas importadas só com
// o CNPJ (CNPJá gratuito: cerca de 5 consultas por minuto).
const companyRegistryQueue = { running: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runCompanyRegistryQueue() {
  if (companyRegistryQueue.running || !cache || !currentUserCan("companies", "edit")) return;
  companyRegistryQueue.running = true;
  try {
    for (;;) {
      const company = (cache?.companies || []).find((item) => item.registry_pending && !item.registry_error);
      if (!company) break;
      const now = new Date().toISOString();
      try {
        const payload = await fetchCompanyRegistryData(company.tax_id);
        delete payload.tax_id;
        const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value != null && value !== ""));
        clean.state_registrations = mergeStateRegistrations(company.state_registrations, payload.state_registrations || [], clean.state || company.state).filter((item) => item.ie);
        const saved = await updateRow("companies", company.tax_id, { ...clean, registry_pending: false, registry_error: null, registry_checked_at: now });
        Object.assign(company, saved || clean, { registry_pending: false, registry_error: null });
        const qsaIds = await companyQsaContactIds(company.tax_id, company.qsa).catch(() => []);
        if (qsaIds.length) {
          const linked = [...new Set([...normalizeIdList(company.contact_ids), ...qsaIds])];
          await replaceContactCompanyLinks({ companyId: company.tax_id, relatedIds: linked });
          updateCachedContactCompanyLinks({ companyId: company.tax_id, relatedIds: linked });
          if (normalizeTextList(company.contact_type).length) await syncCompanyContactTypes(company.tax_id, linked, normalizeTextList(company.contact_type));
        }
      } catch (error) {
        if (/Limite/.test(error.message)) { await sleep(60000); continue; }
        company.registry_error = String(error.message || "Falha na consulta").slice(0, 200);
        await updateRow("companies", company.tax_id, { registry_error: company.registry_error, registry_checked_at: now }).catch(() => null);
      }
      if (state.tab === "companies" && !document.querySelector("#modal-root .overlay")) render();
      await sleep(13000);
    }
  } finally {
    companyRegistryQueue.running = false;
  }
}

const companyRegistryBadgeHtml = (company) => company?.registry_pending
  ? `<span class="registry-badge${company.registry_error ? " error" : ""}" title="${esc(company.registry_error ? `Consulta falhou: ${company.registry_error}. Use Atualizar da Receita.` : "Importada pelo CNPJ. Os dados da Receita serão preenchidos automaticamente.")}">${company.registry_error ? "Erro na Receita" : "Desatualizada"}</span>`
  : "";

function importCellValue(column, raw, c = cache) {
  const text = raw instanceof Date ? "" : String(raw ?? "").trim();
  if (column.type === "date") {
    if (raw === "" || raw == null) return { value: null };
    const value = importDateValue(raw);
    return value === undefined ? { error: `${column.header}: data inválida "${text}"` } : { value };
  }
  if (!text) return { value: column.type === "multi" || column.type === "free" || column.type === "companies" ? [] : null };
  if (column.type === "number") {
    const value = typeof raw === "number" ? raw : filterNumberValue(text);
    return value == null ? { error: `${column.header}: número inválido "${text}"` } : { value };
  }
  if (column.type === "select") {
    const option = importMatchOption(column.options(), text);
    return option ? { value: option.value } : { error: `${column.header}: "${text}" não é uma opção válida` };
  }
  if (column.type === "multi") {
    const options = column.options();
    const values = [];
    for (const item of importSplit(text)) {
      const option = importMatchOption(options, item);
      if (!option) return { error: `${column.header}: "${item}" não é uma opção válida` };
      values.push(option.value);
    }
    return { value: values };
  }
  if (column.type === "free") return { value: importSplit(text) };
  if (column.type === "products") return importProductIds(text, c);
  if (column.type === "companies") {
    const ids = [];
    for (const item of importSplit(text)) {
      const company = importCompanyMatch(item, c);
      if (!company) return { error: `${column.header}: empresa "${item}" não encontrada` };
      ids.push(company.tax_id);
    }
    return { value: ids };
  }
  if (column.type === "company") {
    const company = importCompanyMatch(text, c);
    return company ? { value: company.tax_id } : { error: `${column.header}: empresa "${text}" não encontrada` };
  }
  if (column.type === "contact") {
    const wanted = importNorm(text);
    const contact = (c.contacts || []).find((item) => importNorm(item.name) === wanted || normalizeEmailList(item.email || "").toLowerCase().split(/[;,]/).map((email) => email.trim()).includes(wanted));
    return contact ? { value: contact.id } : { error: `${column.header}: pessoa "${text}" não encontrada` };
  }
  if (column.type === "project") {
    const wanted = importNorm(text);
    const project = (c.projects || []).find((item) => importNorm(item.name) === wanted);
    return project ? { value: project.id } : { error: `${column.header}: entrega "${text}" não encontrada` };
  }
  return { value: text };
}

function downloadImportTemplate(tab) {
  const spec = importSpec(tab);
  const XLSXLib = globalThis.XLSX;
  if (!spec) return;
  if (!XLSXLib?.utils?.aoa_to_sheet || !XLSXLib.writeFile) { toast("O gerador de planilhas ainda não foi carregado. Atualize a página e tente novamente.", true); return; }
  const book = XLSXLib.utils.book_new();
  const model = XLSXLib.utils.aoa_to_sheet([spec.columns.map((column) => column.header)]);
  model["!cols"] = spec.columns.map((column) => ({ wch: Math.max(14, column.header.length + 4) }));
  XLSXLib.utils.book_append_sheet(book, model, "Modelo");
  const describe = (column) => {
    if (column.options) return `Um destes: ${column.options().map((option) => option.label).join(", ")}${column.type === "multi" ? " (vários separados por ;)" : ""}`;
    if (column.type === "date") return "Data dd/mm/aaaa";
    if (column.type === "number") return "Número (ex.: 1500,50)";
    return column.note || "Texto";
  };
  const guide = XLSXLib.utils.aoa_to_sheet([
    [`Importação de ${spec.title} · ENTERPRISER CMS`],
    [spec.intro || "Preencha a aba Modelo a partir da linha 2. Não altere os títulos das colunas."],
    [],
    ["Coluna", "Obrigatória", "Formato / valores aceitos", "Observação"],
    ...spec.columns.map((column) => [column.header, column.req ? "Sim" : "Não", describe(column), column.options ? (column.note || "") : (column.note && column.note !== describe(column) ? column.note : "")])
  ]);
  guide["!cols"] = [{ wch: 26 }, { wch: 12 }, { wch: 70 }, { wch: 44 }];
  XLSXLib.utils.book_append_sheet(book, guide, "Instruções");
  XLSXLib.writeFile(book, `modelo_importacao_${importNorm(spec.title).replace(/\s+/g, "_")}.xlsx`);
}

async function importModuleSpreadsheet(tab, file) {
  const spec = importSpec(tab);
  const XLSXLib = globalThis.XLSX;
  if (!spec) return;
  if (!XLSXLib?.read) { toast("O leitor de planilhas ainda não foi carregado. Atualize a página e tente novamente.", true); return; }
  let matrix;
  try {
    const workbook = XLSXLib.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames.find((name) => importNorm(name) === "modelo") || workbook.SheetNames[0];
    matrix = XLSXLib.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: true });
  } catch (error) {
    toast("Não foi possível ler a planilha · " + error.message, true);
    return;
  }
  const headerIndex = matrix.findIndex((row) => row.some((cell) => String(cell ?? "").trim()));
  if (headerIndex < 0) { toast("A planilha está vazia.", true); return; }
  const headers = matrix[headerIndex].map((cell) => importNorm(cell));
  const columnIndex = new Map(spec.columns.map((column) => [column.key, headers.findIndex((header) => header === importNorm(column.header) || header === importNorm(column.key))]));
  const missing = spec.columns.filter((column) => column.req && columnIndex.get(column.key) < 0).map((column) => column.header);
  if (missing.length) { toast(`Faltam colunas obrigatórias: ${missing.join(", ")}. Use a planilha modelo.`, true); return; }
  const ignored = matrix[headerIndex].filter((cell, index) => String(cell ?? "").trim() && ![...columnIndex.values()].includes(index));
  const rows = matrix.slice(headerIndex + 1).map((cells, offset) => ({ line: headerIndex + offset + 2, cells })).filter((row) => row.cells.some((cell) => String(cell ?? "").trim()));
  if (!rows.length) { toast("Nenhuma linha preenchida na planilha.", true); return; }
  const prepared = rows.map((row) => {
    const body = {};
    const errors = [];
    spec.columns.forEach((column) => {
      const index = columnIndex.get(column.key);
      if (index < 0) return;
      const result = importCellValue(column, row.cells[index]);
      if (result.error) errors.push(result.error);
      else if (result.value != null && !(Array.isArray(result.value) && !result.value.length)) body[column.key] = result.value;
    });
    spec.columns.filter((column) => column.req && (body[column.key] == null || body[column.key] === "")).forEach((column) => errors.push(`${column.header} é obrigatório`));
    if (!errors.length && spec.validate) { const message = spec.validate(body); if (message) errors.push(message); }
    const existing = !errors.length && spec.existing ? spec.existing(body) : null;
    return { ...row, body, errors, existing };
  });
  openImportPreview(tab, spec, prepared, ignored);
}

function openImportPreview(tab, spec, prepared, ignored) {
  const valid = prepared.filter((row) => !row.errors.length);
  const updates = valid.filter((row) => row.existing).length;
  const label = (row) => row.body.name || row.body.title || row.body.client_name || row.body.tax_id || "";
  shell(`Importar ${spec.title}`, `<div class="import-preview">
      <div class="import-summary">
        <span><b>${prepared.length}</b> linha(s)</span><span class="ok"><b>${valid.length - updates}</b> nova(s)</span><span class="upd"><b>${updates}</b> atualização(ões)</span><span class="err"><b>${prepared.length - valid.length}</b> com erro</span>
        ${ignored.length ? `<span class="muted">Colunas ignoradas: ${esc(ignored.join(", "))}</span>` : ""}
      </div>
      <div class="import-list">${prepared.map((row) => `<div class="import-row${row.errors.length ? " has-error" : ""}"><span class="import-line">Linha ${row.line}</span><span class="import-label">${esc(label(row))}</span><span class="import-status">${row.errors.length ? esc(row.errors.join(" · ")) : row.existing ? "Atualizar existente" : "Criar"}</span></div>`).join("")}</div>
      <div class="import-progress" id="import-progress" hidden></div>
    </div>
    <div class="modal-foot"><button class="btn" id="import-cancel" type="button">Cancelar</button><button class="btn primary" id="import-confirm" type="button"${valid.length ? "" : " disabled"}>Importar ${valid.length} linha(s)</button></div>`, { cls: "wide" });
  document.getElementById("import-cancel").addEventListener("click", closeModal);
  document.getElementById("import-confirm").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const progress = document.getElementById("import-progress");
    button.disabled = true;
    document.getElementById("import-cancel").disabled = true;
    progress.hidden = false;
    let done = 0;
    const failures = [];
    const context = { credentials: [] };
    for (const row of valid) {
      progress.textContent = `Importando ${done + 1} de ${valid.length}…`;
      try { await spec.save(row.body, row.existing, context); done += 1; }
      catch (error) { failures.push(`Linha ${row.line}: ${error.message}`); }
    }
    closeModal();
    toast(`${done} registro(s) importado(s) em ${spec.title}.${failures.length ? ` ${failures.length} falharam.` : ""}`, Boolean(failures.length));
    if (failures.length) console.warn("[CMS] Falhas na importação", failures);
    const reopenRegistrations = String(tab).startsWith("reg:") ? tab.slice(4) : null;
    await init();
    if (reopenRegistrations) openRegistrationsModal(reopenRegistrations);
    if (context.credentials.length) showImportedCredentials(context.credentials);
  });
}

function showImportedCredentials(credentials) {
  const text = credentials.map((item) => `${item.name} · ${item.email} · ${item.password}`).join("\n");
  const inner = `<div class="panel-list">Guarde e envie estes acessos agora; as senhas não ficam visíveis depois.</div>
    <textarea class="import-credentials" readonly>${esc(text)}</textarea>
    <div class="modal-foot"><button class="btn primary" id="import-credentials-copy" type="button">Copiar acessos</button></div>`;
  if (document.getElementById("registrations-root")) nestedSidePanel("Acessos criados", inner);
  else sidePanel("Acessos criados", inner, { closeOnOverlay: false });
  document.getElementById("import-credentials-copy").addEventListener("click", async () => { await copyText(text); toast("Acessos copiados."); });
}

function openImportMenuItems(panel, tab, spec) {
  panel.querySelector(".dd-import-template")?.addEventListener("click", () => { panel.remove(); downloadImportTemplate(tab); });
  panel.querySelector(".dd-import-sheet")?.addEventListener("click", () => {
    panel.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    input.addEventListener("change", () => { if (input.files?.[0]) importModuleSpreadsheet(tab, input.files[0]); });
    input.click();
  });
}
const importMenuHtml = (canImport) => canImport ? '<div class="dd-head"><span>Importar</span><span>Planilha</span></div><button class="dd-menu-btn dd-import-sheet" type="button">Planilha (CSV, XLS, XLSX)</button><button class="dd-menu-btn dd-import-template" type="button">Baixar planilha modelo</button>' : "";

function openDataMenu() {
  document.getElementById("data-dd")?.remove();
  const tab = state.tab;
  const spec = importSpec(tab);
  const canImport = Boolean(spec) && currentUserCan(tab, "create");
  const panel = document.createElement("div");
  panel.id = "data-dd";
  panel.className = "data-dd";
  panel.innerHTML = `
    <div class="dd-head"><span>Dados</span><span>${esc(spec?.title || (tab === "conversations" ? "Conversas" : ""))}</span></div>
    <div class="dd-head"><span>Exportar</span><span></span></div>
    <button class="dd-menu-btn" id="csv-active">CSV (Colunas Ativas)</button>
    <button class="dd-menu-btn" id="csv-all">CSV (Todas as Colunas)</button>
    ${canImport || tab === "conversations" ? '<div class="dd-head"><span>Importar</span><span></span></div>' : ""}
    ${canImport ? '<button class="dd-menu-btn dd-import-sheet" type="button">Planilha (CSV, XLS, XLSX)</button><button class="dd-menu-btn dd-import-template" type="button">Baixar planilha modelo</button>' : ""}
    ${tab === "conversations" ? '<button class="dd-menu-btn" id="import-whatsapp">Conversa (.txt/.zip)</button>' : ""}`;
  document.body.appendChild(panel);
  panel.querySelector("#csv-active").addEventListener("click", () => { panel.remove(); exportTableCSV(true); });
  panel.querySelector("#csv-all").addEventListener("click", () => { panel.remove(); exportTableCSV(false); });
  panel.querySelector("#import-whatsapp")?.addEventListener("click", () => {
    panel.remove();
    document.getElementById("import-file").click();
  });
  openImportMenuItems(panel, tab, spec);
  setTimeout(() => {
    const outside = (e) => {
      if (!panel.contains(e.target) && e.target.id !== "data-btn") {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function zipTextFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP inválido.");
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = view.getUint16(eocd + 10, true);
  let pos = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const fileNameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameStart = pos + 46;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength));
    if (name.toLowerCase().endsWith(".txt")) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      const payload = bytes.slice(dataStart, dataEnd);
      if (method === 0) return new TextDecoder("utf-8").decode(payload);
      if (method === 8 && "DecompressionStream" in window) {
        const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return await new Response(stream).text();
      }
      throw new Error("ZIP compactado em formato não suportado pelo navegador.");
    }
    pos += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error("Nenhum arquivo .txt encontrado no ZIP.");
}

async function textFromImportFile(file) {
  const buffer = await readFileAsArrayBuffer(file);
  if (file.name.toLowerCase().endsWith(".zip")) return zipTextFromBuffer(buffer);
  return new TextDecoder("utf-8").decode(buffer);
}

function parseWhatsAppText(text, filename) {
  const cleanName = filename.replace(/\.(txt|zip)$/i, "").replace(/^Conversa do WhatsApp com\s+/i, "").trim();
  const fileLower = filename.toLowerCase();
  const source = fileLower.includes("reddit") ? "Reddit" : fileLower.includes("instagram") ? "Instagram" : "WhatsApp";
  const lines = text.replace(/\r/g, "").split("\n");
  const messages = [];
  const re = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2})\s+-\s+(?:(.*?):\s)?([\s\S]*)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      messages.push({ at: `${m[1]} ${m[2]}`, author: m[3] || "", text: m[4] || "" });
    } else if (messages.length && line.trim()) {
      messages[messages.length - 1].text += "\n" + line;
    }
  }
  const authorCount = {};
  messages.forEach((m) => {
    if (!m.author) return;
    authorCount[m.author] = (authorCount[m.author] || 0) + 1;
  });
  const contactName = cleanName || Object.keys(authorCount).sort((a, b) => authorCount[b] - authorCount[a])[0] || "Contato importado";
  const fullText = messages.map((m) => m.text).join("\n");
  const email = fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = fullText.match(/(?:\+?\d{1,3}\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}/)?.[0] || "";
  const amountRaw = fullText.match(/(?:R\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}/)?.[0] || "";
  const amount = amountRaw ? Number(amountRaw.replace(/[^\d,]/g, "").replace(",", ".")) : null;
  const relevant = messages.filter((m) => m.author && !/^<M[íi]dia oculta>|Mensagem apagada$/i.test(m.text)).slice(-8);
  const summary = relevant.map((m) => `${m.author}: ${m.text}`).join(" / ").slice(0, 360);
  return {
    id: crypto.randomUUID(),
    source,
    origin: "Importação",
    contact_name: contactName,
    contact: source === "WhatsApp" ? phone : cleanName,
    username: "",
    profile_url: "",
    chat_url: "",
    message_count: messages.length,
    first_at: messages[0]?.at || "",
    last_at: messages[messages.length - 1]?.at || "",
    email,
    phone,
    amount,
    title: `WhatsApp - ${contactName}`,
    summary,
    raw: text,
    messages,
    imported_at: new Date().toLocaleString("pt-BR"),
    status: "imported"
  };
}

async function importWhatsAppFile(file) {
  try {
    const text = await textFromImportFile(file);
    const row = parseWhatsAppText(text, file.name);
    const conversations = loadConversations();
    conversations.unshift(row);
    saveConversations(conversations);
    state.tab = "conversations";
    state.view = "table";
    state.q = "";
    document.getElementById("search").value = "";
    render();
    toast(`Conversa importada: ${row.contact_name}.`);
  } catch (err) {
    toast("Erro ao importar · " + err.message, true);
  }
}

function deleteImport(id) {
  const conversations = loadConversations().filter((row) => row.id !== id);
  state.selectedConversations.delete(id);
  saveConversations(conversations);
  render();
  toast("Conversa excluída.");
}

function openConversationPopup(id) {
  const row = findConversation(id);
  if (!row) return;
  const messages = row.messages || [];
  // "Minhas" mensagens são reconhecidas pelo nome cadastrado em
  // Configurações → Meus dados (sem isso configurado, nada é destacado).
  const myName = String(getCfg().myName || "").trim().toLowerCase();
  const body = messages.length
    ? messages.map((m) => {
      const mine = myName && String(m.author || "").toLowerCase().includes(myName);
      return `<div class="chat-msg${mine ? " mine" : ""}">
        <div class="meta">${esc(m.author || "Sistema")} · ${esc(m.at || "")}</div>
        <div class="txt">${esc(m.text || "")}</div>
      </div>`;
    }).join("")
    : `<div class="panel-list">${esc(row.raw || row.summary || "Sem conteúdo.")}</div>`;
  sidePanel(`Conversa · ${row.contact_name || "Contato"}`, `<div class="chat-log">${body}</div>`);
}

function openAssociateContactModal(ids = [...state.selectedConversations]) {
  const rows = ids.map(findConversation).filter(Boolean);
  if (!rows.length) { toast("Selecione uma conversa.", true); return; }
  const options = cache.contacts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  shell("Associar contato", `<div class="form">
      <div class="field full"><label>Pessoa</label><select id="associate-person">${options}</select></div>
    </div>
    <div class="panel-list" style="padding-top:0">${rows.length} conversa(s) selecionada(s).</div>
    <div class="modal-foot"><button class="btn" id="cancel">Cancelar</button>
      <button class="btn primary" id="save">Associar</button></div>`);
  document.getElementById("cancel").addEventListener("click", closeModal);
  document.getElementById("save").addEventListener("click", () => {
    const personId = document.getElementById("associate-person").value;
    const conversations = loadConversations();
    conversations.forEach((row) => {
      if (ids.includes(row.id)) row.contact_id = personId;
    });
    saveConversations(conversations);
    closeModal();
    state.selectedConversations.clear();
    render();
    toast("Contato associado.");
  });
}

async function convertImportToDeal(id) {
  const conversations = loadConversations();
  const row = conversations.find((item) => item.id === id);
  if (!row) return;
  try {
    let contact = row.contact_id ? cache.contacts.find((c) => c.id === row.contact_id) : null;
    if (!contact) {
      contact = cache.contacts.find((c) =>
        (row.email && String(c.email || "").toLowerCase().includes(row.email.toLowerCase())) ||
        (contactForConversation(row) && String(c.phone || c.whatsapp || "").includes(contactForConversation(row))) ||
        (row.source === "Reddit" && row.username && String(c.reddit || "").toLowerCase().includes(row.username.toLowerCase())) ||
        c.name === row.contact_name
      );
    }
    if (!contact) {
      contact = await createRow("contacts", {
        name: row.contact_name,
        phone: row.phone || row.contact || null,
        email: row.email || null,
        contact_type: null,
        channel: contactChannelFromSource(row.source),
        whatsapp: String(row.source || "").toLowerCase().includes("whatsapp") ? (row.phone || row.contact || null) : null
      });
    }
    const firstPipeline = (cache.pipelines || [])[0];
    await createRow("deals", {
      title: row.title || `WhatsApp - ${row.contact_name}`,
      contact_id: contact.id,
      company_id: normalizeIdList(contact.company_ids, contact.company_id)[0] || null,
      product_id: null,
      owner_id: null,
      pipeline_id: firstPipeline?.id || null,
      stage: firstPipeline?.stages?.[0] || null,
      status: "open",
      lead_source: "WhatsApp",
      amount: row.amount || null,
      expected_close_date: null
    });
    row.status = "converted";
    row.contact_id = contact.id;
    saveConversations(conversations);
    state.selectedConversations.delete(id);
    closeModal();
    toast("Conversa transformada em negociação.");
    await init();
    state.tab = "deals";
    render();
  } catch (err) {
    toast("Erro ao criar negociação · " + err.message, true);
  }
}

async function createDealFromSelectedConversations() {
  const rows = selectedConversationRows();
  if (!rows.length) { toast("Selecione uma conversa.", true); return; }
  for (const row of rows) await convertImportToDeal(row.id);
}

function render() {
  if (!cache) return;
  if (state.tab !== "home" && !currentUserCan(state.tab, "view")) state.tab = "home";
  refreshActivityCache();
  document.querySelector('[data-action="log"]')?.toggleAttribute("hidden", !currentUserIsAdmin());
  document.querySelector('[data-action="chat"]')?.toggleAttribute("hidden", !currentUserCanUseChat());
  document.querySelectorAll("#tabs .tab").forEach((tab) => tab.toggleAttribute("hidden", !currentUserCan(tab.dataset.tab, "view")));
  document.querySelector('[data-action="registrations"]')?.toggleAttribute("hidden", !hasAnyModuleAccess(Object.values(REGISTRATION_PERMISSION_MODULE)));
  document.querySelector('[data-action="tools"]')?.toggleAttribute("hidden", !hasAnyModuleAccess(["files", "emails", "processes", "documents", "tables"]));
  document.querySelector('[data-action="social"]')?.toggleAttribute("hidden", !hasAnyModuleAccess(Object.keys(SOCIAL_MODULE_LABELS)));
  const hasConversationSelection = state.selectedConversations.size > 0;
  const isHome = state.tab === "home";
  document.querySelector(".subbar")?.classList.toggle("home-hidden", isHome);
  const requestedMode = VIEW_MODES.find((mode) => mode.id === state.view);
  if (!requestedMode || !viewModeAvailable(requestedMode)) state.view = "table";
  if (state.view === "matrix" || state.view === "dashboard") state.view = "table";
  document.getElementById("selection-actions").classList.toggle("show", hasConversationSelection);
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = isHome;
    const unavailable = v.dataset.view !== "table" || hasConversationSelection;
    v.disabled = unavailable;
    v.classList.toggle("locked", unavailable);
  });
  const viewMenuButton = document.getElementById("view-menu-btn");
  const activeMode = VIEW_MODES.find((mode) => mode.id === state.view) || VIEW_MODES[0];
  viewMenuButton.hidden = isHome;
  viewMenuButton.disabled = hasConversationSelection;
  viewMenuButton.classList.toggle("active", !isHome);
  document.getElementById("view-menu-label").innerHTML = viewIcon(activeMode.id);
  document.getElementById("view-menu-text").textContent = activeMode.label;
  viewMenuButton.title = `Modo de visualização: ${activeMode.label}`;
  document.getElementById("search").disabled = isHome;
  document.getElementById("new").disabled = isHome || !currentUserCan(state.tab, "create");
  document.getElementById("cols-btn").disabled = isHome;
  document.getElementById("data-btn").disabled = isHome;
  const groupClientButton = document.getElementById("group-client-btn");
  const canGroupClients = !isHome && state.tab === "activities" && state.view === "table";
  groupClientButton.hidden = !canGroupClients;
  groupClientButton.disabled = !canGroupClients;
  groupClientButton.classList.toggle("active", canGroupClients && state.groupActivitiesByClient);
  groupClientButton.setAttribute("aria-pressed", String(canGroupClients && state.groupActivitiesByClient));
  document.getElementById("filter-strip").classList.toggle("home-hidden", isHome);
  if (!isHome) renderActiveFilterBadges();

  if (isHome) renderHome(cache);
  else if (state.view === "kanban" && state.tab === "deals") renderKanban(cache);
  else if (state.view === "kanban" && state.tab === "activities") renderActivityKanban(cache);
  else if (state.view === "calendar") renderCalendar(cache);
  else if (state.view === "gantt") renderGantt(cache);
  else renderTable(cache);

  if (isHome) {
    document.getElementById("count").textContent = "Visão geral";
  } else {
  const total = (cache[state.tab] || []).length;
  const shown = rowsFor(state.tab, cache).length;
  document.getElementById("count").textContent = shown === total ? `${total} itens` : `${shown}/${total}`;
  }
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
  document.getElementById("brand-home")?.classList.toggle("active", isHome);
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === state.view));
}

// ---------- Modal genérico ----------
let modalCloseOverride = null;
let modalLayerStack = [];
function removeModalLayer(closeAction) {
  modalLayerStack = modalLayerStack.filter((item) => item !== closeAction);
}
function closeTopModalLayer() {
  const closeAction = modalLayerStack[modalLayerStack.length - 1];
  if (!closeAction) return false;
  closeAction();
  return true;
}
function escCloseHandler(e) {
  if (e.key !== "Escape") return;
  const registrationFilter = document.getElementById("registration-filter-dd");
  if (registrationFilter) { registrationFilter.remove(); e.preventDefault(); e.stopImmediatePropagation(); return; }
  const drawerOverlay = [...document.querySelectorAll(".activity-form-overlay")].at(-1);
  if (drawerOverlay) {
    const closeButton = drawerOverlay.querySelector(".modal-close-x");
    if (closeButton) closeButton.click();
    else drawerOverlay.remove();
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (closeTopModalLayer()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (modalCloseOverride) modalCloseOverride();
  else closeModal();
  e.preventDefault();
  e.stopImmediatePropagation();
}
function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
  document.getElementById("registration-filter-dd")?.remove();
  modalCloseOverride = null;
  modalLayerStack = [];
  document.removeEventListener("keydown", escCloseHandler);
}
function shell(title, inner, opts = {}) {
  const cls = "modal" + (opts.cls ? ` ${opts.cls}` : "");
  const overlayCls = opts.cls?.split(/\s+/).includes("full") ? "overlay full-overlay" : "overlay";
  const titleHtml = opts.titleHtml || esc(title);
  document.getElementById("modal-root").innerHTML =
    `<div class="${overlayCls}" id="ov"><div class="${cls}">
      <h3><span class="modal-title">${titleHtml}</span>${opts.headerCenter || ""}<span class="modal-header-actions">${opts.headerActions || ""}<button class="modal-close-x" id="shell-close" title="Fechar (Esc)">✕</button></span></h3>
      ${inner}
    </div></div>`;
  modalCloseOverride = typeof opts.onClose === "function" ? opts.onClose : null;
  const closeAction = () => modalCloseOverride ? modalCloseOverride() : closeModal();
  document.getElementById("shell-close").addEventListener("click", closeAction);
  document.addEventListener("keydown", escCloseHandler);
}
// Painel lateral (desliza da direita, altura cheia). Modais fecham apenas
// pelo X, por ações explícitas ou por ESC; cliques no fundo são ignorados.
function sidePanel(title, inner, opts = {}) {
  modalCloseOverride = typeof opts.onClose === "function" ? opts.onClose : null;
  document.getElementById("modal-root").innerHTML =
    `<div class="overlay side" id="ov"><div class="modal side-panel">
      <h3>${esc(title)}<button class="modal-close-x" id="side-close" title="Fechar (Esc)">✕</button></h3>
      ${inner}
    </div></div>`;
  const closeAction = () => modalCloseOverride ? modalCloseOverride() : closeModal();
  document.getElementById("side-close").addEventListener("click", closeAction);
  document.addEventListener("keydown", escCloseHandler);
  return closeAction;
}

function nestedSidePanel(title, inner, opts = {}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay side nested-modal-layer";
  overlay.innerHTML = `<div class="modal side-panel">
      <h3>${esc(title)}<button class="modal-close-x nested-side-close" title="Fechar (Esc)">✕</button></h3>
      ${inner}
    </div>`;
  let closed = false;
  const closeAction = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    removeModalLayer(closeAction);
    if (typeof opts.onClose === "function") opts.onClose();
  };
  document.getElementById("modal-root").appendChild(overlay);
  modalLayerStack.push(closeAction);
  overlay.querySelector(".nested-side-close").addEventListener("click", closeAction);
  return closeAction;
}

function nestedCenterModal(title, inner, opts = {}) {
  const overlay = document.createElement("div");
  overlay.className = `overlay${opts.cls?.split(/\s+/).includes("full") ? " full-overlay" : ""} nested-modal-layer`;
  overlay.innerHTML = `<div class="modal ${opts.cls || "wide"}">
      <h3><span>${esc(title)}</span><button class="modal-close-x nested-modal-close" title="Fechar (Esc)">✕</button></h3>
      ${inner}
    </div>`;
  let closed = false;
  const closeAction = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    removeModalLayer(closeAction);
    if (typeof opts.onClose === "function") opts.onClose();
  };
  document.getElementById("modal-root").appendChild(overlay);
  modalLayerStack.push(closeAction);
  overlay.querySelector(".nested-modal-close").addEventListener("click", closeAction);
  return closeAction;
}

function openForm(tab, id, opts = {}) {
  const permissionAction = id ? "edit" : "create";
  if (!requireCurrentUserPermission(tab, permissionAction, ENTITY_LABEL[tab] || modulePermissionLabel(tab))) return;
  const c = cache;
  const record = id ? c[tab].find((r) => r[pk(tab)] === id) : null;
  const fs = fields(tab, c);
  if (tab === "deals") {
    const stageField = fs.find((f) => f.k === "stage");
    if (stageField) stageField.options = pipelineStageOptions(c, record?.pipeline_id);
  }
  const fieldHtml = (f) => {
    if (f.embedded) return "";
    let val = record ? record[f.k] : f.def ?? "";
    if (tab === "projects" && f.k === "name") val = deliveryGeneratedName(record?.client_name, record?.product_id);
    if (tab === "projects" && f.k === "store_platforms" && record?.store_platform && !normalizeTextList(val).length) val = [record.store_platform];
    if (tab === "projects" && record && ["financial_accounts", "freight_channels"].includes(f.k)) {
      const auto = deliveryAutoSetups(record.marketplace_channels, projectStoreList(record));
      val = normalizeTextList([...normalizeTextList(val), ...(f.k === "financial_accounts" ? auto.financial : auto.freight)]);
    }
    const isLocked = Boolean(f.generated || (record && f.lockWhenSet && val) || f.receita);
    let ctrl;
    if (f.type === "multi") {
      const selected = new Set(f.textValues ? normalizeTextList(val) : normalizeIdList(val));
      const lockedValues = f.lockedValues ? f.lockedValues(record) : [];
      lockedValues.forEach((value) => selected.add(value));
      ctrl = multiPickerHtml(`form-${f.k}`, f.options || [], selected, f.placeholder || "Selecionar", Boolean(f.searchOnly), false, record && f.addOnly ? selected : new Set(lockedValues), Boolean(f.allowCreate));
    } else if (f.type === "ie_list") {
      ctrl = stateRegistrationsEditorHtml(val, record?.state);
    } else if (f.type === "search") {
      ctrl = singleSearchPickerHtml(`form-${f.k}`, f.options || [], val, f.placeholder);
    } else if (f.searchableRef) {
      const selected = f.options.find((option) => option.value === val);
      const listId = `search-${f.k}-options`;
      ctrl = `<input data-search-ref="${f.searchableRef}" data-search-target="${f.k}" list="${listId}" value="${esc(selected?.label || val || "")}" placeholder="Buscar empresa...">
        <input type="hidden" data-k="${f.k}" value="${esc(val || "")}">
        <datalist id="${listId}">${f.options.map((option) => `<option value="${esc(option.label)}"></option>`).join("")}</datalist>`;
    } else if (f.type === "select") {
      const opts = ['<option value="">—</option>']
        .concat(f.options.map((o) => `<option value="${esc(o.value)}"${o.value === val ? " selected" : ""}>${esc(o.label)}</option>`));
      ctrl = `<select data-k="${f.k}"${isLocked ? " disabled" : ""}>${opts.join("")}</select>`;
    } else if (f.type === "checkbox") {
      ctrl = `<input type="checkbox" data-k="${f.k}"${val ? " checked" : ""}${isLocked ? " disabled" : ""}>`;
    } else if (f.type === "textarea") {
      ctrl = `<textarea data-k="${f.k}"${f.req ? " required" : ""}${isLocked ? " readonly" : ""}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}>${esc(val)}</textarea>`;
    } else {
      const t = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
      const lockPk = id && f.k === pk(tab);
      const input = `<input type="${t}" data-k="${f.k}" value="${esc(val)}"${f.req ? " required" : ""}${(lockPk || isLocked) ? " readonly" : ""}${f.min != null ? ` min="${esc(f.min)}"` : ""}${f.step != null ? ` step="${esc(f.step)}"` : ""}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}>`;
      ctrl = f.lookup === "cnpj"
        ? `<div class="input-action-row">${input}<button class="btn" type="button" id="lookup-cnpj">${lockPk ? "Atualizar da Receita" : "Buscar dados"}</button></div>`
        : input;
    }
    if (tab === "deals" && f.k === "company_id") {
      return `<div class="field full optional-company-field"><label>${esc(f.label)}</label><div class="optional-company-row">${ctrl}<label class="optional-company-toggle"><input type="checkbox" data-k="no_company"${record?.no_company ? " checked" : ""}><span>Não possui empresa</span></label></div></div>`;
    }
    const cls = "field" + (f.type === "checkbox" ? " check" : "") + (f.full ? " full" : "");
    if (f.type === "checkbox") return `<div class="${cls}">${ctrl}<label>${esc(f.label)}</label></div>`;
    return `<div class="${cls}"><label>${esc(f.label)}${f.req ? " *" : ""}</label>${ctrl}${f.help ? `<small class="field-help">${esc(f.help)}</small>` : ""}</div>`;
  };
  // Entrega: ERP, canais, frete, empresa e contas financeiras ficam na aba Setup.
  const setupKeys = new Set(["erp_platform", "marketplace_channels", "store_platforms", "freight_channels", "company_setup", "financial_accounts"]);
  const inputs = tab === "projects"
    ? `<div class="form-tab-panel" data-form-tab="general">${fs.filter((f) => !setupKeys.has(f.k)).map(fieldHtml).join("")}</div><div class="form-tab-panel" data-form-tab="setup" hidden><div class="panel-list form-tab-note">Canais ativados passam a liberar suas tarefas e não podem ser desativados depois.</div>${fs.filter((f) => setupKeys.has(f.k)).map(fieldHtml).join("")}</div>`
    : fs.map(fieldHtml).join("");

  const title = (id ? "Editar " : "Novo ") + SINGULAR[tab];
  const generatedNotice = tab === "projects"
    ? `<div class="form-tabs" role="tablist"><button class="form-tab active" type="button" role="tab" data-form-tab-btn="general">Dados</button><button class="form-tab" type="button" role="tab" data-form-tab-btn="setup">Setup</button></div><div class="panel-list" data-form-tab-note="general" style="padding:14px 18px 0">O nome da entrega é gerado automaticamente no padrão <b>EC365 | Cliente | Produto</b>.</div>`
    : "";
  const body = `${generatedNotice}<div class="form${tab === "projects" ? " project-form" : ""}">${inputs}</div>
    <div class="modal-foot">
      <button class="btn" id="cancel">Cancelar</button>
      <button class="btn primary" id="save">${id ? "Salvar" : "Criar"}</button>
    </div>`;
  // Negócio e produto abrem em painel lateral (vindo da direita); os demais
  // cadastros continuam no modal central de sempre.
  const returnSection = opts.returnToRegistrations || null;
  const nestedRegistration = Boolean(returnSection && document.getElementById("registrations-root"));
  let returnToPrevious;
  if (nestedRegistration) returnToPrevious = nestedSidePanel(title, body, { closeOnOverlay: true });
  else {
    returnToPrevious = returnSection ? () => openRegistrationsModal(returnSection) : closeModal;
    if (SIDE_PANEL_TABS.has(tab)) sidePanel(title, body, { closeOnOverlay: true, onClose: returnSection ? returnToPrevious : null });
    else shell(title, body, { onClose: returnSection ? returnToPrevious : null });
  }
  opts.closeAction = returnToPrevious;

  document.getElementById("cancel").addEventListener("click", returnToPrevious);
  document.getElementById("save").addEventListener("click", () => saveForm(tab, id, fs, opts));
  document.querySelectorAll("#modal-root [data-form-tab-btn]").forEach((button) => button.addEventListener("click", () => {
    const panelRoot = button.closest(".modal") || document;
    panelRoot.querySelectorAll("[data-form-tab-btn]").forEach((item) => item.classList.toggle("active", item === button));
    panelRoot.querySelectorAll(".form-tab-panel").forEach((panel) => { panel.hidden = panel.dataset.formTab !== button.dataset.formTabBtn; });
    panelRoot.querySelectorAll("[data-form-tab-note]").forEach((note) => { note.hidden = note.dataset.formTabNote !== button.dataset.formTabBtn; });
  }));
  fs.filter((field) => field.type === "multi").forEach((field) => wireMultiPicker(`form-${field.k}`));
  fs.filter((field) => field.type === "search").forEach((field) => wireSingleSearchPicker(`form-${field.k}`));
  document.querySelectorAll("#modal-root [data-search-ref]").forEach((input) => {
    const field = fs.find((item) => item.k === input.dataset.searchTarget);
    const hidden = document.querySelector(`#modal-root [data-k="${input.dataset.searchTarget}"]`);
    const syncValue = () => {
      const typed = input.value.trim().toLocaleLowerCase("pt-BR");
      const match = field?.options.find((option) => option.label.toLocaleLowerCase("pt-BR") === typed || String(option.value).toLocaleLowerCase("pt-BR") === typed);
      hidden.value = match?.value || "";
    };
    input.addEventListener("input", syncValue);
    input.addEventListener("change", syncValue);
  });
  if (tab === "companies") {
    const form = document.querySelector("#modal-root .form");
    const cnpjInput = form?.querySelector('[data-k="tax_id"]');
    const lookupButton = document.getElementById("lookup-cnpj");
    lastCompanyLookup = id ? taxIdDigits(id) : "";
    companyLookupFresh = false;
    lookupButton?.addEventListener("click", () => lookupCompanyByCnpj(form, lookupButton, Boolean(id)));
    if (!id) cnpjInput?.addEventListener("blur", () => {
      if (cnpjInput.value.replace(/\D/g, "").length === 14) lookupCompanyByCnpj(form, lookupButton);
    });
    wireStateRegistrationsEditor(form);
  }

  // Etapa depende do pipeline escolhido — repopula ao trocar.
  if (tab === "deals") {
    const form = document.querySelector("#modal-root .form");
    const companyEl = form?.querySelector('[data-k="company_id"]');
    const companyPicker = document.getElementById("form-company_id");
    const noCompanyEl = form?.querySelector('[data-k="no_company"]');
    const contactEl = form?.querySelector('[data-k="contact_id"]');
    const pipelineEl = form?.querySelector('[data-k="pipeline_id"]');
    const stageEl = form?.querySelector('[data-k="stage"]');
    const syncDealContacts = () => {
      if (!contactEl) return;
      const selected = String(contactEl.value || record?.contact_id || "");
      const options = dealContactOptions(c, companyEl?.value);
      contactEl.innerHTML = ['<option value="">—</option>']
        .concat(options.map((option) => `<option value="${esc(option.value)}"${String(option.value) === selected ? " selected" : ""}>${esc(option.label)}</option>`)).join("");
      if (!options.some((option) => String(option.value) === selected)) contactEl.value = "";
    };
    const syncNoCompany = () => {
      const disabled = Boolean(noCompanyEl?.checked);
      companyPicker?.classList.toggle("field-disabled", disabled);
      contactEl?.closest(".field")?.classList.toggle("field-disabled", disabled);
      companyPicker?.querySelector(".single-search-input")?.toggleAttribute("disabled", disabled);
      if (contactEl) contactEl.disabled = disabled;
      if (disabled) {
        if (companyEl) companyEl.value = "";
        const searchInput = companyPicker?.querySelector(".single-search-input");
        if (searchInput) searchInput.value = "";
        if (contactEl) { contactEl.value = ""; contactEl.innerHTML = '<option value="">—</option>'; }
      } else syncDealContacts();
    };
    companyEl?.addEventListener("change", syncDealContacts);
    noCompanyEl?.addEventListener("change", syncNoCompany);
    syncNoCompany();
    pipelineEl?.addEventListener("change", () => {
      const stages = pipelineStageOptions(c, pipelineEl.value);
      stageEl.innerHTML = ['<option value="">—</option>']
        .concat(stages.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)).join("");
    });
  }
  // Fim calculado a partir do início + duração do produto.
  if (tab === "projects") {
    const form = document.querySelector("#modal-root .form");
    const nameEl = form?.querySelector('[data-k="name"]');
    const companyEl = form?.querySelector('[data-k="company_id"]');
    const clientEl = form?.querySelector('[data-k="client_name"]');
    const startEl = form?.querySelector('[data-k="start_date"]');
    const endEl = form?.querySelector('[data-k="end_date"]');
    const productEl = form?.querySelector('[data-k="product_id"]');
    const statusEl = form?.querySelector('[data-k="status"]');
    const substatusEl = form?.querySelector('[data-k="substatus"]');
    const continuationEl = form?.querySelector('[data-k="continuation_of_id"]');
    const erpEl = form?.querySelector('[data-k="erp_platform"]');
    const normalizeCnpj = (value) => String(value || "").replace(/\D/g, "");
    const persistedChannels = {
      marketplaces: normalizeTextList(record?.marketplace_channels),
      stores: normalizeTextList(record?.store_platforms).length ? normalizeTextList(record.store_platforms) : normalizeTextList(record?.store_platform ? [record.store_platform] : []),
      freight: normalizeTextList(record?.freight_channels),
      financial: normalizeTextList(record?.financial_accounts)
    };
    if (record) {
      const persistedAuto = deliveryAutoSetups(record.marketplace_channels, projectStoreList(record));
      persistedChannels.freight = normalizeTextList([...persistedChannels.freight, ...persistedAuto.freight]);
      persistedChannels.financial = normalizeTextList([...persistedChannels.financial, ...persistedAuto.financial]);
    }
    let inheritedChannels = { marketplaces: [], stores: [], freight: [], financial: [] };
    let currentAuto = { financial: [], freight: [] };
    let inheritedErp = "";
    const replaceChannelPicker = (key, group, selected, locked) => {
      const picker = document.getElementById(`form-${key}`);
      if (!picker) return;
      picker.outerHTML = multiPickerHtml(`form-${key}`, deliveryChannelOptions(group), new Set(selected), picker.dataset.placeholder || "Selecionar", false, false, new Set(locked));
      wireMultiPicker(`form-${key}`);
    };
    const syncContinuationChannels = () => {
      const previous = continuationEl?.value ? c.projects.find((project) => project.id === continuationEl.value) : null;
      const previousInheritedErp = inheritedErp;
      const currentSelections = {
        marketplaces: multiPickerValues("form-marketplace_channels").filter((channel) => !inheritedChannels.marketplaces.includes(channel)),
        stores: multiPickerValues("form-store_platforms").filter((channel) => !inheritedChannels.stores.includes(channel)),
        freight: multiPickerValues("form-freight_channels").filter((channel) => !inheritedChannels.freight.includes(channel)),
        financial: multiPickerValues("form-financial_accounts").filter((channel) => !inheritedChannels.financial.includes(channel))
      };
      inheritedChannels = {
        marketplaces: normalizeTextList(previous?.marketplace_channels),
        stores: normalizeTextList(previous?.store_platforms).length ? normalizeTextList(previous.store_platforms) : normalizeTextList(previous?.store_platform ? [previous.store_platform] : []),
        freight: normalizeTextList(previous?.freight_channels),
        financial: normalizeTextList(previous?.financial_accounts)
      };
      inheritedErp = previous?.erp_platform || "";
      replaceChannelPicker("marketplace_channels", "marketplaces", normalizeTextList([...currentSelections.marketplaces, ...inheritedChannels.marketplaces]), normalizeTextList([...persistedChannels.marketplaces, ...inheritedChannels.marketplaces]));
      replaceChannelPicker("store_platforms", "stores", normalizeTextList([...currentSelections.stores, ...inheritedChannels.stores]), normalizeTextList([...persistedChannels.stores, ...inheritedChannels.stores]));
      replaceChannelPicker("freight_channels", "freight", normalizeTextList([...currentSelections.freight, ...inheritedChannels.freight]), normalizeTextList([...persistedChannels.freight, ...inheritedChannels.freight]));
      replaceChannelPicker("financial_accounts", "financial", normalizeTextList([...currentSelections.financial, ...inheritedChannels.financial]), normalizeTextList([...persistedChannels.financial, ...inheritedChannels.financial]));
      currentAuto = { financial: [], freight: [] };
      applyAutoSetups();
      if (erpEl) {
        const persistedErp = record?.erp_platform || "";
        const userErp = erpEl.value === previousInheritedErp && !persistedErp ? "" : erpEl.value;
        erpEl.value = persistedErp || inheritedErp || userErp;
        erpEl.disabled = Boolean(persistedErp || inheritedErp);
        erpEl.closest(".field")?.classList.toggle("field-disabled", Boolean(persistedErp || inheritedErp));
      }
    };
    // Mercado Livre, Nuvem Shop e Tray trazem contas financeiras e fretes automáticos.
    function applyAutoSetups() {
      const auto = deliveryAutoSetups(multiPickerValues("form-marketplace_channels"), multiPickerValues("form-store_platforms"));
      [["financial_accounts", "financial"], ["freight_channels", "freight"]].forEach(([key, group]) => {
        const fixed = new Set([...persistedChannels[group], ...inheritedChannels[group]]);
        const dropped = currentAuto[group].filter((value) => !auto[group].includes(value) && !fixed.has(value));
        const current = multiPickerValues(`form-${key}`);
        const selected = normalizeTextList([...current.filter((value) => !dropped.includes(value)), ...auto[group]]);
        const locked = normalizeTextList([...fixed, ...auto[group]]);
        const same = selected.length === current.length && selected.every((value) => current.includes(value));
        if (!same || dropped.length || auto[group].length !== currentAuto[group].length) replaceChannelPicker(key, group, selected, locked);
      });
      currentAuto = auto;
    }
    form?.addEventListener("multi-picker-change", (event) => {
      if (["form-marketplace_channels", "form-store_platforms"].includes(event.target?.id)) applyAutoSetups();
    }, true);
    const syncContinuityOptions = () => {
      if (!continuationEl) return;
      const companyCnpj = normalizeCnpj(companyEl?.value);
      const selected = String(continuationEl.value || record?.continuation_of_id || "");
      const options = companyCnpj ? (c.projects || []).filter((project) =>
        project.id !== id && normalizeCnpj(project.company_id) === companyCnpj
      ) : [];
      continuationEl.innerHTML = ['<option value="">—</option>']
        .concat(options.map((project) => `<option value="${esc(project.id)}"${project.id === selected ? " selected" : ""}>${esc(project.name || project.client_name || "Entrega")}</option>`)).join("");
      if (!options.some((project) => project.id === selected)) continuationEl.value = "";
      continuationEl.closest(".field")?.classList.toggle("field-disabled", !companyCnpj || !options.length);
      continuationEl.disabled = !companyCnpj || !options.length;
    };
    const syncSubstatus = () => {
      const enabled = statusEl?.value === "inactive";
      if (substatusEl) {
        substatusEl.disabled = !enabled;
        if (!enabled) substatusEl.value = statusEl?.value === "closed" ? "closed" : "";
      }
    };
    const recalcName = () => { if (nameEl) nameEl.value = deliveryGeneratedName(clientEl?.value, productEl?.value); };
    const recalcEnd = () => {
      const prod = c.productById[productEl?.value];
      if (startEl?.value && prod?.duration_days) endEl.value = addDaysRoundedToMonthEnd(startEl.value, prod.duration_days);
    };
    startEl?.addEventListener("change", recalcEnd);
    companyEl?.addEventListener("change", () => { syncContinuityOptions(); syncContinuationChannels(); });
    continuationEl?.addEventListener("change", syncContinuationChannels);
    clientEl?.addEventListener("input", recalcName);
    productEl?.addEventListener("change", () => { recalcEnd(); recalcName(); });
    statusEl?.addEventListener("change", syncSubstatus);
    recalcName();
    recalcEnd();
    syncContinuityOptions();
    syncContinuationChannels();
    syncSubstatus();
  }
}

let lastCompanyLookup = "";
let companyLookupFresh = false;
function companyRegistryPayload(data, fallbackCnpj) {
  const address = data.address || {};
  const activity = data.mainActivity || data.company?.mainActivity;
  const phone = data.phones?.map((item) => {
    if (typeof item === "string") return item;
    return [item.area, item.number].filter(Boolean).join(" ");
  }).filter(Boolean).join("; ") || "";
  const qsa = [...new Set((data.company?.members || []).map((member) => {
    const name = String(member?.person?.name || "").trim();
    const role = [member?.role?.id, member?.role?.text]
      .filter((value) => value != null && value !== "")
      .join("-");
    return name && role ? `Nome/Nome Empresarial: ${name} | Qualificação: ${role}` : "";
  }).filter(Boolean))].join("; ");
  return {
    tax_id: String(data.taxId || fallbackCnpj).replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"),
    legal_name: data.company?.name || "",
    trade_name: data.alias || "",
    email: data.emails?.map((item) => typeof item === "string" ? item : item.address).filter(Boolean).join("; ") || "",
    phone: phone ? normalizePhoneList(phone) : "",
    headquarters: data.head === false ? "Filial" : "Matriz",
    founded_at: String(data.founded || data.openedAt || "").slice(0, 10),
    registration_status: data.status?.text || data.status?.name || data.status || "",
    qsa,
    share_capital: data.company?.equity ?? null,
    activities: activity ? [activity.id, activity.text].filter(Boolean).join(" — ") : "",
    address: [address.street, address.number, address.details, address.district].filter(Boolean).join(", "),
    zip_code: address.zip || "",
    city: address.city || "",
    state: address.state || "",
  };
}

async function fetchCompanyRegistryData(cnpjValue) {
  const cnpj = String(cnpjValue || "").replace(/\D/g, "");
  if (cnpj.length !== 14) throw new Error("Informe um CNPJ com 14 dígitos.");
  const response = await fetch(`https://open.cnpja.com/office/${cnpj}`, { headers: { Accept: "application/json" } });
  if (response.status === 429) throw new Error("Limite de consultas atingido. Aguarde alguns segundos.");
  if (!response.ok) throw new Error(`CNPJ não encontrado (${response.status})`);
  const payload = companyRegistryPayload(await response.json(), cnpj);
  const registrations = await fetchStateRegistrations(cnpj);
  if (registrations?.length) payload.state_registrations = registrations;
  return payload;
}

// Inscrições estaduais pela API pública do CNPJ.ws (cobre parte dos
// estados; limite de 3 consultas por minuto). Falha não impede o cadastro.
async function fetchStateRegistrations(cnpj) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`, { headers: { Accept: "application/json" }, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    return (data?.estabelecimento?.inscricoes_estaduais || [])
      .filter((item) => item?.inscricao_estadual && item.ativo !== false)
      .map((item) => ({ uf: String(item.estado?.sigla || "").toUpperCase(), ie: String(item.inscricao_estadual).trim() }))
      .filter((item) => item.uf);
  } catch (error) {
    return null;
  }
}

function normalizeStateRegistrations(value) {
  let list = value;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch (error) { list = []; } }
  return (Array.isArray(list) ? list : [])
    .map((item) => ({ uf: String(item?.uf || "").toUpperCase().trim(), ie: String(item?.ie || "").trim() }))
    .filter((item) => item.uf || item.ie);
}

// Mantém a inscrição do estado da empresa na primeira posição.
function mergeStateRegistrations(current, fetched, companyUf) {
  const byUf = new Map();
  normalizeStateRegistrations(current).forEach((item) => { if (item.uf) byUf.set(item.uf, item.ie); });
  normalizeStateRegistrations(fetched).forEach((item) => { if (item.uf && item.ie) byUf.set(item.uf, item.ie); });
  const uf = String(companyUf || "").toUpperCase();
  const first = uf ? [{ uf, ie: byUf.get(uf) || "" }] : [];
  return [...first, ...[...byUf.entries()].filter(([key]) => key !== uf).map(([key, ie]) => ({ uf: key, ie }))];
}

function stateRegistrationsEditorHtml(value, companyUf) {
  const uf = String(companyUf || "").toUpperCase();
  const list = mergeStateRegistrations(value, [], uf);
  const rows = uf ? list : [{ uf: "", ie: "" }, ...list];
  const ufOptions = (selected) => `<option value="">UF</option>${BR_UFS.map((item) => `<option value="${item}"${item === selected ? " selected" : ""}>${item}</option>`).join("")}`;
  return `<div class="ie-list" id="form-state_registrations" data-company-uf="${esc(uf)}">
    ${rows.map((item, index) => index === 0
      ? `<div class="ie-row" data-fixed="true"><span class="ie-uf" title="Estado da empresa">${esc(item.uf || "UF")}</span><input class="ie-value" value="${esc(item.ie)}" placeholder="Inscrição estadual"><span class="ie-spacer"></span></div>`
      : `<div class="ie-row"><select class="ie-uf-select">${ufOptions(item.uf)}</select><input class="ie-value" value="${esc(item.ie)}" placeholder="Inscrição estadual"><button class="rowbtn ie-remove" type="button" title="Remover">✕</button></div>`).join("")}
    <button class="btn ie-add" type="button">+ Adicionar UF</button>
  </div>`;
}

function stateRegistrationsValue(form) {
  const root = form?.querySelector("#form-state_registrations");
  if (!root) return [];
  const companyUf = String(form.querySelector('[data-k="state"]')?.value || root.dataset.companyUf || "").toUpperCase();
  const rows = [...root.querySelectorAll(".ie-row")].map((row) => ({
    uf: row.dataset.fixed === "true" ? companyUf : String(row.querySelector(".ie-uf-select")?.value || ""),
    ie: String(row.querySelector(".ie-value")?.value || "").trim()
  })).filter((item) => item.uf && item.ie);
  return mergeStateRegistrations(rows, [], companyUf).filter((item) => item.ie);
}

function wireStateRegistrationsEditor(form) {
  const root = form?.querySelector("#form-state_registrations");
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "1";
  root.addEventListener("click", (event) => {
    if (event.target.closest(".ie-remove")) { event.target.closest(".ie-row").remove(); return; }
    if (!event.target.closest(".ie-add")) return;
    const row = document.createElement("div");
    row.className = "ie-row";
    row.innerHTML = `<select class="ie-uf-select"><option value="">UF</option>${BR_UFS.map((item) => `<option value="${item}">${item}</option>`).join("")}</select><input class="ie-value" placeholder="Inscrição estadual"><button class="rowbtn ie-remove" type="button" title="Remover">✕</button>`;
    root.insertBefore(row, root.querySelector(".ie-add"));
    row.querySelector("select").focus();
  });
}

function fillCompanyForm(form, companyData) {
  Object.entries(companyData).forEach(([key, value]) => {
    if (key === "state_registrations") return;
    const field = form?.querySelector(`[data-k="${key}"]`);
    if (field && value != null && value !== "") field.value = value;
  });
  const editor = form?.querySelector("#form-state_registrations");
  if (editor) {
    const current = stateRegistrationsValue(form);
    const merged = mergeStateRegistrations(current, companyData.state_registrations || [], companyData.state || form.querySelector('[data-k="state"]')?.value);
    editor.outerHTML = stateRegistrationsEditorHtml(merged, companyData.state || form.querySelector('[data-k="state"]')?.value);
    wireStateRegistrationsEditor(form);
  }
}

async function lookupCompanyByCnpj(form, button, force = false) {
  const input = form?.querySelector('[data-k="tax_id"]');
  const cnpj = input?.value.replace(/\D/g, "") || "";
  if (cnpj.length !== 14) { toast("Informe um CNPJ com 14 dígitos.", true); return; }
  if (!force && lastCompanyLookup === cnpj && form.querySelector('[data-k="legal_name"]')?.value) return;
  const originalText = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "Buscando..."; }
  try {
    fillCompanyForm(form, await fetchCompanyRegistryData(cnpj));
    lastCompanyLookup = cnpj;
    companyLookupFresh = true;
    toast("Dados da empresa preenchidos.");
  } catch (err) {
    lastCompanyLookup = "";
    toast("Erro ao consultar CNPJ · " + err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText || "Buscar dados"; }
  }
}

function companyDetailValue(label, value) {
  return `<div class="company-detail-item"><span>${esc(label)}</span><strong>${value || "—"}</strong></div>`;
}

function openCompanyDetails(taxId) {
  if (!requireCurrentUserPermission("companies", "view", "Empresas")) return;
  const company = cache?.companies?.find((item) => String(item.tax_id) === String(taxId));
  if (!company) return;
  const contacts = normalizeIdList(company.contact_ids).map((id) => cache.contactById?.[id]?.name).filter(Boolean).join("; ");
  const content = `<div class="company-detail-grid">
      ${companyDetailValue("CNPJ", esc(company.tax_id))}
      ${companyDetailValue("Nome empresarial", esc(company.legal_name))}
      ${companyDetailValue("Nome fantasia", esc(company.trade_name))}
      ${company.registry_pending ? companyDetailValue("Receita", companyRegistryBadgeHtml(company)) : ""}
      ${companyDetailValue("Situação cadastral", esc(company.registration_status))}
      ${companyDetailValue("Tipo de contato", esc(normalizeTextList(company.contact_type).join(", ")))}
      ${companyDetailValue("Inscrições estaduais", esc(normalizeStateRegistrations(company.state_registrations).filter((item) => item.ie).map((item) => `${item.uf}: ${item.ie}`).join(" · ")))}
      ${companyDetailValue("Inscrição municipal", esc(company.municipal_registration))}
      ${companyDetailValue("E-mail", esc(company.email))}
      ${companyDetailValue("Telefone", esc(company.phone))}
      ${companyDetailValue("Abertura", esc(dt(company.founded_at)))}
      ${companyDetailValue("Capital social", company.share_capital == null ? "—" : esc(brl(company.share_capital)))}
      ${companyDetailValue("Endereço", esc([company.address, company.city, company.state, company.zip_code].filter(Boolean).join(" · ")))}
      ${companyDetailValue("Atividade principal", esc(company.activities))}
      ${companyDetailValue("Pessoas vinculadas", esc(contacts))}
      ${companyDetailValue("QSA", multiLineCell(company.qsa))}
    </div>
    <div class="modal-foot">
      <button class="btn" id="company-detail-edit"${currentUserCan("companies", "edit") ? "" : " disabled"}>Editar</button>
      <button class="btn primary" id="company-detail-refresh"${currentUserCan("companies", "edit") ? "" : " disabled"}>Atualizar dados</button>
    </div>`;
  sidePanel(company.trade_name || company.legal_name || "Empresa", content, { closeOnOverlay: true });
  document.getElementById("company-detail-edit")?.addEventListener("click", () => openForm("companies", company.tax_id));
  document.getElementById("company-detail-refresh")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Atualizando...";
    try {
      const enriched = await fetchCompanyRegistryData(company.tax_id);
      delete enriched.tax_id;
      enriched.state_registrations = mergeStateRegistrations(company.state_registrations, enriched.state_registrations || [], enriched.state || company.state).filter((item) => item.ie);
      const payload = { ...Object.fromEntries(Object.entries(enriched).filter(([, value]) => value != null && value !== "")), registry_pending: false, registry_error: null, registry_checked_at: new Date().toISOString() };
      const saved = await updateRow("companies", company.tax_id, payload);
      upsertCachedEntity("companies", saved);
      toast("Dados da empresa atualizados.");
      await init();
      openCompanyDetails(company.tax_id);
    } catch (err) {
      button.disabled = false;
      button.textContent = originalText;
      toast("Erro ao atualizar empresa · " + err.message, true);
    }
  });
}

async function replaceContactCompanyLinks({ contactId = null, companyId = null, relatedIds = [] }) {
  const ids = [...new Set(normalizeIdList(relatedIds))];
  if (!contactId && !companyId) return;
  if (!isLive()) {
    DEMO.contactCompanies = (DEMO.contactCompanies || []).filter((link) =>
      contactId ? link.contact_id !== contactId : link.company_id !== companyId
    );
    const links = ids.map((relatedId) => contactId
      ? { contact_id: contactId, company_id: relatedId }
      : { contact_id: relatedId, company_id: companyId }
    );
    DEMO.contactCompanies.push(...links);
    return;
  }
  if (contactId) {
    await api("rpc/replace_contact_company_links", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ p_contact_id: contactId, p_company_ids: ids })
    });
    return;
  }
  const filter = contactId
    ? `contact_id=eq.${encodeURIComponent(contactId)}`
    : `company_id=eq.${encodeURIComponent(companyId)}`;
  await api(`${remoteTable("contactCompanies")}?${filter}`, { method: "DELETE" });
  if (!ids.length) return;
  const links = ids.map((relatedId) => contactId
    ? { contact_id: contactId, company_id: relatedId }
    : { contact_id: relatedId, company_id: companyId }
  );
  await api(remoteTable("contactCompanies"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(links)
  });
}

async function companyQsaContactIds(companyId, qsaValue = null) {
  const company = cache?.companyById?.[companyId] || (DEMO.companies || []).find((item) => item.tax_id === companyId);
  const qsaNames = qsaPartnerNames(qsaValue ?? company?.qsa);
  if (!qsaNames.length) return [];
  if (!companyId) return [];
  if (!isLive()) {
    const linkedIds = new Set((DEMO.contactCompanies || []).filter((link) => link.company_id === companyId).map((link) => link.contact_id));
    return (DEMO.contacts || []).filter((contact) => linkedIds.has(contact.id) && qsaNames.some((name) => likelySamePersonName(contact.name, name))).map((contact) => contact.id);
  }
  const links = await api(`${remoteTable("contactCompanies")}?select=contact_id&company_id=eq.${encodeURIComponent(companyId)}`);
  const ids = normalizeIdList((links || []).map((link) => link.contact_id));
  if (!ids.length) return [];
  const people = await api(`${remoteTable("contacts")}?select=id,name&id=in.(${ids.map(encodeURIComponent).join(",")})`);
  return (people || []).filter((contact) => qsaNames.some((name) => likelySamePersonName(contact.name, name))).map((contact) => contact.id);
}

function qsaPartnerNames(value) {
  const names = [];
  const pattern = /Nome\/Nome Empresarial\s*:\s*(.*?)\s*\|\s*Qualifica(?:ção|cao)\s*:/gi;
  let match;
  while ((match = pattern.exec(String(value || "")))) names.push(match[1].trim());
  return normalizeTextList(names);
}

function contactChannelFromSource(value) {
  const source = normalizePersonNameValue(value);
  const match = CONTACT_CHANNEL_OPTIONS.find((channel) => source.includes(normalizePersonNameValue(channel)));
  if (match) return match;
  if (source.includes("mail")) return "E-mail";
  if (source.includes("fone") || source.includes("ligacao")) return "Telefone";
  return source ? "Outros" : null;
}

function normalizePersonNameValue(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
}

function personNameDistance(left, right) {
  const a = normalizePersonNameValue(left);
  const b = normalizePersonNameValue(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function likelySamePersonName(left, right) {
  const a = normalizePersonNameValue(left);
  const b = normalizePersonNameValue(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  return aParts.length >= 3 && aParts.length === bParts.length && aParts[0] === bParts[0]
    && Math.abs(a.length - b.length) <= 1 && personNameDistance(a, b) <= 1;
}

function refreshEntityCacheIndexes() {
  if (!cache) return;
  const byId = (rows, key = "id") => Object.fromEntries((rows || []).map((row) => [row[key], row]));
  cache.companyById = byId(cache.companies, pk("companies"));
  cache.contactById = byId(cache.contacts);
  cache.productById = byId(cache.products);
  cache.userById = byId(cache.users);
  cache.userByAuthId = Object.fromEntries((cache.users || []).filter((user) => user.auth_user_id).map((user) => [user.auth_user_id, user]));
  cache.pipelineById = byId(cache.pipelines);
  cache.projectById = byId(cache.projects);
  refreshActivityCache();
}

function upsertCachedEntity(tab, saved) {
  const rows = cache?.[tab];
  if (!Array.isArray(rows) || !saved) return saved;
  const key = pk(tab);
  const index = rows.findIndex((row) => String(row[key]) === String(saved[key]));
  if (index >= 0) rows[index] = { ...rows[index], ...saved };
  else rows.unshift(saved);
  refreshEntityCacheIndexes();
  return index >= 0 ? rows[index] : saved;
}

// Replica os tipos da empresa (Cliente, Fornecedor, Parceiro) para as pessoas
// vinculadas. A pessoa fica com os tipos de todas as suas empresas e mantém os
// próprios tipos que não vêm da empresa (Colaborador, Network). Empresa sem
// tipo não altera ninguém.
async function syncCompanyContactTypes(companyId, contactIds, companyTypes) {
  if (!companyTypes.length || !cache?.contacts) return 0;
  let updated = 0;
  for (const contactId of normalizeIdList(contactIds)) {
    const contact = cache.contacts.find((item) => item.id === contactId);
    if (!contact) continue;
    const companyIds = [...new Set([...normalizeIdList(contact.company_ids), companyId])];
    const fromCompanies = companyIds.flatMap((id) => id === companyId ? companyTypes : normalizeTextList(cache.companyById?.[id]?.contact_type));
    const current = normalizeTextList(contact.contact_type);
    const next = normalizeTextList([...current.filter((type) => !COMPANY_CONTACT_TYPE_OPTIONS.includes(type)), ...fromCompanies]);
    const value = next.join("; ") || null;
    if ((current.join("; ") || null) === value) continue;
    try {
      const saved = await updateRow("contacts", contactId, { contact_type: value });
      contact.contact_type = saved?.contact_type ?? value;
      updated += 1;
    } catch (error) {
      toast(`Erro ao atualizar o tipo de ${contact.name || "pessoa"} · ${error.message}`, true);
    }
  }
  return updated;
}

// Empresa com entrega é cliente: garante o tipo Cliente e replica para as
// pessoas vinculadas.
async function ensureCompanyClientType(companyId) {
  const company = (cache?.companies || []).find((item) => taxIdDigits(item.tax_id) === taxIdDigits(companyId));
  if (!company) return;
  const types = normalizeTextList(company.contact_type);
  if (types.includes("Cliente")) return;
  const next = ["Cliente", ...types.filter((type) => COMPANY_CONTACT_TYPE_OPTIONS.includes(type))];
  try {
    const saved = await updateRow("companies", company.tax_id, { contact_type: next.join("; ") });
    company.contact_type = saved?.contact_type ?? next.join("; ");
    await syncCompanyContactTypes(company.tax_id, company.contact_ids, next);
  } catch (error) {
    toast("Erro ao marcar a empresa como Cliente · " + error.message, true);
  }
}

function updateCachedContactCompanyLinks({ contactId = null, companyId = null, relatedIds = [] }) {
  if (!cache) return;
  const ids = [...new Set(normalizeIdList(relatedIds))];
  const links = (cache.contactCompanies || []).filter((link) => contactId ? link.contact_id !== contactId : link.company_id !== companyId);
  links.push(...ids.map((relatedId) => contactId
    ? { contact_id: contactId, company_id: relatedId }
    : { contact_id: relatedId, company_id: companyId }
  ));
  cache.contactCompanies = links;
  const companyIdsByContact = new Map();
  const contactIdsByCompany = new Map();
  links.forEach((link) => {
    if (!companyIdsByContact.has(link.contact_id)) companyIdsByContact.set(link.contact_id, []);
    if (!contactIdsByCompany.has(link.company_id)) contactIdsByCompany.set(link.company_id, []);
    companyIdsByContact.get(link.contact_id).push(link.company_id);
    contactIdsByCompany.get(link.company_id).push(link.contact_id);
  });
  (cache.contacts || []).forEach((contact) => { contact.company_ids = [...new Set(companyIdsByContact.get(contact.id) || [])]; });
  (cache.companies || []).forEach((company) => { company.contact_ids = [...new Set(contactIdsByCompany.get(company.tax_id) || [])]; });
}

async function saveForm(tab, id, fs, opts = {}) {
  if (!requireCurrentUserPermission(tab, id ? "edit" : "create", ENTITY_LABEL[tab] || modulePermissionLabel(tab))) return;
  const body = {};
  const form = document.querySelector("#modal-root .form");
  const saveButton = document.getElementById("save");
  if (saveButton?.disabled) return;
  for (const f of fs) {
    if (f.type === "multi") {
      body[f.k] = multiPickerValues(`form-${f.k}`);
      continue;
    }
    if (f.type === "ie_list") {
      body[f.k] = stateRegistrationsValue(form);
      continue;
    }
    const el = form?.querySelector(`[data-k="${f.k}"]`);
    if (!el) continue;
    let v;
    if (f.type === "checkbox") v = el.checked;
    else if (f.type === "number") v = el.value === "" ? null : Number(el.value);
    else v = el.value === "" ? null : el.value;
    body[f.k] = v;
  }
  const linkedCompanyIds = tab === "contacts" ? normalizeIdList(body.company_ids) : null;
  const linkedContactIds = tab === "companies" ? normalizeIdList(body.contact_ids) : null;
  if (tab === "deals") {
    body.no_company = Boolean(body.no_company);
    if (body.no_company) {
      body.company_id = null;
      body.contact_id = null;
    } else if (!body.company_id) {
      toast("Preencha: Empresa ou marque Não possui empresa", true);
      return;
    }
  }
  if (tab === "contacts") {
    body.contact_type = normalizeTextList(body.contact_type).join("; ") || null;
    body.groups = normalizeTextList(body.groups).join("; ") || null;
    body.tags = normalizeTextList(body.tags);
    delete body.company_ids;
    body.company_id = linkedCompanyIds[0] || null;
  }
  if (tab === "companies") {
    delete body.contact_ids;
    const types = normalizeTextList(body.contact_type).filter((type) => COMPANY_CONTACT_TYPE_OPTIONS.includes(type));
    if (companyHasDelivery(body.tax_id) && !types.includes("Cliente")) types.unshift("Cliente");
    body.contact_type = types.join("; ") || null;
    body.municipal_registration = String(body.municipal_registration || "").trim() || null;
    if (!id && (!body.legal_name || lastCompanyLookup !== taxIdDigits(body.tax_id))) {
      toast("Clique em Buscar dados: os dados da empresa vêm da Receita.", true);
      return;
    }
    if (companyLookupFresh && lastCompanyLookup === taxIdDigits(body.tax_id) && body.legal_name) Object.assign(body, { registry_pending: false, registry_error: null, registry_checked_at: new Date().toISOString() });
  }
  if (tab === "projects") {
    body.name = deliveryGeneratedName(body.client_name, body.product_id);
    if (body.status === "active") body.substatus = null;
    if (body.status === "closed") body.substatus = "closed";
    if (body.status === "inactive" && !body.substatus) { toast("Selecione o substatus da entrega inativa: Suporte ou Encerrado.", true); return; }
    const current = id ? cache.projects.find((project) => project.id === id) : null;
    const previousDelivery = body.continuation_of_id ? cache.projects.find((project) => project.id === body.continuation_of_id) : null;
    if (body.continuation_of_id && body.continuation_of_id === id) { toast("Uma entrega não pode ser continuidade dela mesma.", true); return; }
    const sameCompanyCnpj = previousDelivery && String(previousDelivery.company_id || "").replace(/\D/g, "") === String(body.company_id || "").replace(/\D/g, "");
    if (previousDelivery && !sameCompanyCnpj) { toast("A continuidade deve pertencer ao mesmo CNPJ.", true); return; }
    if (previousDelivery) {
      if (previousDelivery.erp_platform && body.erp_platform && previousDelivery.erp_platform !== body.erp_platform) { toast(`A continuidade deve manter o ERP ${previousDelivery.erp_platform}.`, true); return; }
      body.erp_platform = previousDelivery.erp_platform || body.erp_platform || null;
      body.marketplace_channels = normalizeTextList([...normalizeTextList(previousDelivery.marketplace_channels), ...normalizeTextList(body.marketplace_channels)]);
      const previousStores = normalizeTextList(previousDelivery.store_platforms).length ? normalizeTextList(previousDelivery.store_platforms) : normalizeTextList(previousDelivery.store_platform ? [previousDelivery.store_platform] : []);
      body.store_platforms = normalizeTextList([...previousStores, ...normalizeTextList(body.store_platforms)]);
      body.freight_channels = normalizeTextList([...normalizeTextList(previousDelivery.freight_channels), ...normalizeTextList(body.freight_channels)]);
      body.financial_accounts = normalizeTextList([...normalizeTextList(previousDelivery.financial_accounts), ...normalizeTextList(body.financial_accounts)]);
    }
    if (current?.erp_platform && body.erp_platform !== current.erp_platform) { toast("O ERP ativado não pode ser alterado ou removido.", true); return; }
    const currentStores = normalizeTextList(current?.store_platforms).length ? normalizeTextList(current.store_platforms) : normalizeTextList(current?.store_platform ? [current.store_platform] : []);
    const removedStore = currentStores.find((channel) => !normalizeTextList(body.store_platforms).includes(channel));
    if (removedStore) { toast(`A loja ${removedStore} já está ativada e não pode ser removida.`, true); return; }
    const removedMarketplace = normalizeTextList(current?.marketplace_channels).find((channel) => !normalizeTextList(body.marketplace_channels).includes(channel));
    if (removedMarketplace) { toast(`O marketplace ${removedMarketplace} já está ativado e não pode ser removido.`, true); return; }
    const autoSetups = deliveryAutoSetups(body.marketplace_channels, body.store_platforms);
    body.freight_channels = normalizeTextList([...normalizeTextList(body.freight_channels), ...autoSetups.freight]);
    body.financial_accounts = normalizeTextList([...normalizeTextList(body.financial_accounts), ...autoSetups.financial]);
    const removedFinancial = normalizeTextList(current?.financial_accounts).find((channel) => !body.financial_accounts.includes(channel));
    if (removedFinancial) { toast(`A conta financeira ${removedFinancial} já está ativada e não pode ser removida.`, true); return; }
    const removedFreight = normalizeTextList(current?.freight_channels).find((channel) => !normalizeTextList(body.freight_channels).includes(channel));
    if (removedFreight) { toast(`O canal de frete ${removedFreight} já está ativado e não pode ser removido.`, true); return; }
  }
  const req = fs.find((f) => f.req && (body[f.k] == null || body[f.k] === ""));
  if (req) { toast(`Preencha: ${req.label}`, true); return; }
  if (tab === "contacts") {
    if (body.phone) body.phone = normalizePhoneList(body.phone);
    if (body.email) body.email = normalizeEmailList(body.email);
  }
  let effectiveId = id || form?.dataset.savedId || null;
  if (tab === "contacts" && !effectiveId) {
    const name = String(body.name || "").trim().toLocaleLowerCase("pt-BR");
    const phone = String(body.phone || "").replace(/\D/g, "");
    const emails = normalizeEmailList(body.email || "").toLocaleLowerCase("pt-BR").split(/[;,]/).map((value) => value.trim()).filter(Boolean);
    const existing = (cache.contacts || []).find((contact) => {
      if (String(contact.name || "").trim().toLocaleLowerCase("pt-BR") !== name) return false;
      const samePhone = phone && String(contact.phone || "").replace(/\D/g, "").includes(phone);
      const contactEmails = normalizeEmailList(contact.email || "").toLocaleLowerCase("pt-BR").split(/[;,]/).map((value) => value.trim()).filter(Boolean);
      const sameEmail = emails.length && emails.some((email) => contactEmails.includes(email));
      return samePhone || sameEmail;
    });
    if (existing) effectiveId = existing.id;
  }
  const originalSaveLabel = saveButton?.textContent || "Salvar";
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
  try {
    let saved;
    if (effectiveId) { saved = await updateRow(tab, effectiveId, body); toast(id ? "Atualizado." : "Pessoa existente atualizada."); }
    else {
      saved = await createRow(tab, body);
      if (form && saved?.id) form.dataset.savedId = saved.id;
      toast("Criado.");
    }
    if (tab === "contacts") await replaceContactCompanyLinks({ contactId: saved.id, relatedIds: linkedCompanyIds });
    if (tab === "companies") {
      const cachedCompany = cache?.companyById?.[saved.tax_id];
      if (cachedCompany) cachedCompany.qsa = saved.qsa;
      const qsaContactIds = await companyQsaContactIds(saved.tax_id, saved.qsa);
      linkedContactIds.push(...qsaContactIds.filter((contactId) => !linkedContactIds.includes(contactId)));
      await replaceContactCompanyLinks({ companyId: saved.tax_id, relatedIds: linkedContactIds });
      const synced = await syncCompanyContactTypes(saved.tax_id, linkedContactIds, normalizeTextList(body.contact_type));
      if (synced) toast(`Tipo de contato atualizado em ${synced} pessoa(s) vinculada(s).`);
    }
    if (tab === "deals" && body.status === "won" && body.company_id) {
      const dealId = effectiveId || saved?.id;
      if (dealId) await createProjectFromDeal({ id: dealId, company_id: body.company_id, contact_id: body.contact_id, product_id: body.product_id, title: body.title });
    }
    const newDelivery = tab === "projects" && !effectiveId && saved?.id ? saved : null;
    if (tab === "contacts") saved.company_ids = linkedCompanyIds;
    if (tab === "companies") saved.contact_ids = linkedContactIds;
    upsertCachedEntity(tab, saved);
    if (tab === "contacts") updateCachedContactCompanyLinks({ contactId: saved.id, relatedIds: linkedCompanyIds });
    if (tab === "companies") updateCachedContactCompanyLinks({ companyId: saved.tax_id, relatedIds: linkedContactIds });
    if (opts.returnToRegistrations && document.getElementById("registrations-root")) {
      opts.closeAction?.();
      renderRegistrationsSection();
    } else if (opts.returnToRegistrations) openRegistrationsModal(opts.returnToRegistrations);
    else {
      closeModal();
      render();
    }
    if (newDelivery) await provisionDeliveryResources(newDelivery);
    if (tab === "projects" && body.company_id) await ensureCompanyClientType(body.company_id);
    void init();
  } catch (err) {
    if (saveButton) { saveButton.disabled = false; saveButton.textContent = originalSaveLabel; }
    toast("Erro ao salvar · " + err.message, true);
  }
}

function confirmDelete(tab, id) {
  if (!requireCurrentUserPermission(tab, "delete", ENTITY_LABEL[tab] || modulePermissionLabel(tab))) return;
  const rec = cache[tab].find((r) => r[pk(tab)] === id);
  const nome = rec?.name || rec?.legal_name || rec?.title || "este registro";
  shell("Excluir", `<div class="panel-list">Excluir <b>${esc(nome)}</b>? Esta ação não pode ser desfeita.</div>
    <div class="modal-foot"><button class="btn" id="cancel">Cancelar</button>
    <button class="btn danger" id="ok">Excluir</button></div>`);
  document.getElementById("cancel").addEventListener("click", closeModal);
  document.getElementById("ok").addEventListener("click", async () => {
    try { await deleteRow(tab, id); toast("Excluído."); closeModal(); await init(); }
    catch (err) { toast("Erro ao excluir · " + err.message, true); }
  });
}

// ---------- Canto de ações ----------
function setTheme(light) {
  document.body.classList.toggle("light", light);
  localStorage.setItem("crm_theme", light ? "light" : "dark");
  const sun = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"/></svg>`;
  const moon = `<svg viewBox="0 0 20 20"><path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5z"/></svg>`;
  document.getElementById("theme-btn").innerHTML = light ? moon : sun;
}

function openSettings() {
  const c = getCfg();
  const privacySettings = IS_EXTENSION_CONTEXT ? `<div class="help-content" style="padding-bottom:0"><h4>Privacidade da extensão</h4>
      <p><a href="privacy-policy.html" target="_blank" rel="noopener">Ler a Política de Privacidade</a> ou revogar o consentimento da extensão.</p>
    </div>` : "";
  const privacyButton = IS_EXTENSION_CONTEXT ? '<button class="btn danger" id="privacy-revoke" type="button">Revogar consentimento</button>' : "";
  sidePanel("Configurações", `<div class="help-content" style="padding-bottom:0">
      <h4 style="margin-top:0">Meus dados</h4>
      <p>Usado pra te identificar nas conversas importadas ou sincronizadas pela extensão.</p>
    </div>
    <div class="form">
      <div class="field full"><label>Meu nome (como aparece nas conversas)</label>
        <input data-k="myName" value="${esc(c.myName || "")}" placeholder="Ex.: Ulisses Ferreira"></div>
      <div class="field full"><label>Meu usuário no Reddit</label>
        <input data-k="myRedditUsername" value="${esc(c.myRedditUsername || "")}" placeholder="sem o u/"></div>
    </div>
    <div class="help-content" style="padding-bottom:0">
      <h4>Conexão Supabase</h4>
    </div>
    <div class="form">
      <div class="field full"><label>Supabase Project URL</label>
        <input data-k="url" value="${esc(c.url)}" placeholder="https://xxxx.supabase.co"></div>
      <div class="field full"><label>anon public key</label>
        <input data-k="anonKey" value="${esc(c.anonKey)}" placeholder="eyJhbGci..."></div>
    </div>
    <div class="panel-list" style="padding-top:0">Deixe URL/key em branco para usar dados de exemplo.</div>
    ${privacySettings}
    <div class="modal-foot">${privacyButton}<button class="btn primary" id="save">Salvar e conectar</button></div>`, { closeOnOverlay: true });
  document.getElementById("privacy-revoke")?.addEventListener("click", async () => {
    if (!window.confirm("Revogar o consentimento da extensão? Será necessário aceitar novamente para usá-la.")) return;
    await savePrivacyConsent(null);
    closeModal();
    await startApp();
  });
  document.getElementById("save").addEventListener("click", async () => {
    const forms = document.querySelectorAll("#modal-root .form");
    const val = (k) => { for (const f of forms) { const el = f.querySelector(`[data-k="${k}"]`); if (el) return el.value.trim(); } return ""; };
    const cfg = {
      ...c,
      myName: val("myName"),
      myRedditUsername: val("myRedditUsername"),
      url: val("url").replace(/\/$/, ""),
      anonKey: val("anonKey")
    };
    localStorage.setItem("crm_cfg", JSON.stringify(cfg));
    closeModal(); toast(cfg.url && cfg.anonKey ? "Conectando…" : "Usando dados de exemplo."); await init();
  });
}

// ---------- Ajuda ----------
// Mesma organização do sistema: os 6 módulos principais no cabeçalho e os
// submódulos de Cadastros, Ferramentas e Social na barra de ferramentas.
// Cada página tem apresentação e seções com passo a passo, recursos e dicas.
const HELP_HEADER_SLOTS = [["contacts", "Pessoas"], ["companies", "Empresas"], ["conversations", "Conversas"], ["deals", "Negócios"], ["projects", "Entregas"], ["activities", "Tarefas"]];
const HELP_TOOLBAR_SLOTS = [["reg-products", "Produtos"], ["reg-pipelines", "Pipeline"], ["reg-users", "Usuários"], ["reg-activities", "Tarefas"], ["reg-goals", "Metas"], ["reg-objectives", "Objetivos"], ["tool-files", "Arquivos"], ["tool-emails", "Emails"], ["tool-processes", "Processos"], ["tool-documents", "Documentação"], ["tool-tables", "Tabelas"], ["social", "Social"]];
const HELP_TABLE_SECTION = { title: "Tabela, filtros e ações", cards: [["Buscar e ordenar", "A busca central filtra na hora; clique no título da coluna para ordenar."], ["Filtrar", "<b>Ctrl+clique</b> no título da coluna (ou <b>toque longo</b> no tablet). Colunas de número têm condição (entre, maior, menor, igual) e colunas de data filtram por período: calendário de início e fim com atalhos (hoje, semana, mês, selecionar mês). Os filtros ativos aparecem na faixa acima da tabela."], ["⊞ Colunas", "Mostra, oculta e reordena colunas arrastando. A escolha fica salva."], ["Edição em massa", "Marque as linhas: AÇÕES vira ✎ (editar um campo em todos) e ✕ (limpar seleção)."], ["⬆⬇ Dados", "Exporta CSV com as colunas visíveis ou com todas. Importa planilha (CSV, XLS ou XLSX) com as colunas do próprio módulo: baixe a <b>planilha modelo</b>, preencha e confira a prévia antes de importar."]] };
const HELP_MIND_MAP_SECTION = { title: "Mapa mental", lead: "O mapa é o reflexo das colunas categorizadas: tarefas por <b>Categoria › Canal › Módulo › Submódulo</b>; metas e objetivos por <b>Categoria › Canal</b>. Níveis vazios não criam ramo.",
  cards: [["Controles", "⊟/⊞ recolhe ou expande tudo, ⇆/⇅ alterna horizontal e vertical, ✋ arrasta por cima dos cards e ⛶ abre em tela cheia (Esc sai)."], ["Zoom", "Ctrl + rolar, botão do mouse pressionado + rolar ou pinça com dois dedos. Clique no percentual para voltar a 100%."], ["Filtros", "Os filtros da tabela valem para o mapa e aparecem também ali."], ["Dependências", "Linhas tracejadas ligam tarefas dependentes. Clique em um card para editar."]] };
const HELP_PAGES = {
  home: { kicker: "Ajuda", title: "Como usar o ENTERPRISER • CMS", path: ["Cabeçalho", "Rodapé"],
    lead: "O CMS reúne relacionamento comercial (CRM), gestão das entregas e tarefas (PM), processos (BPM) e ferramentas do escritório. Escolha acima um dos módulos principais ou, na barra, um submódulo de Cadastros, Ferramentas ou Social.",
    sections: [
      { title: "Primeiros passos", steps: ["Entre com o e-mail e a senha fornecidos pelo administrador. Apenas usuários ativos acessam, e cada um vê só os módulos liberados.", "Na <b>Home</b> confira os totais de pessoas, empresas, negócios abertos, entregas ativas, tarefas pendentes, receita ganha e as próximas tarefas.", "Use o cabeçalho para os módulos principais e o rodapé para Cadastros, Ferramentas, Social e Ajuda.", "Escolha o tema claro ou escuro no ícone do cabeçalho."],
        cards: [["Instalar como aplicativo", "No Chrome use <b>⋮ → Instalar app</b>; no iPad/iPhone use <b>Compartilhar → Adicionar à Tela de Início</b>. O app (ícone <b>E</b> azul) abre em tela cheia e sempre na versão mais recente."], ["Web e extensão", "PLATFORM_TEXT"]] },
      { title: "Cabeçalho e rodapé", cards: [["↻ Atualizar", "Ao lado do sino. Pisca e mostra quantas alterações outros usuários fizeram; clique para trazer os dados novos sem recarregar a página. Comentários chegam sozinhos no painel aberto."], ["Atividades", "Histórico de quem criou, editou, concluiu, iniciou, reabriu, cancelou ou excluiu algo. Administradores veem todos; os demais, só as próprias."], ["Chat", "Conversa interna entre colaboradores e administradores ativos."], ["Integrações", "Canais ativos e em desenvolvimento, usernames das redes e importação do Google Contatos."], ["Notificações, Configurações e Sair", "Avisos do sistema, identificação usada nas conversas, conexão com o banco e encerramento da sessão."]] },
      { title: "Tabelas e visualizações", lead: "Todas as tabelas seguem a mesma barra: <b>≡ Agrupar · ⊞ Colunas · Visualização ▾ · Matriz · Dashboard · ⬆⬇ Dados</b>. O que não se aplica fica desativado.",
        cards: [...HELP_TABLE_SECTION.cards, ["▸ Expandir", "A coluna após a seleção abre subtarefas e grupos; o ▸ do cabeçalho expande ou recolhe tudo."], ["Visualizações", "Tabela, Quadro, Calendário, Gantt, Mapa mental, Matriz e Dashboard, conforme o módulo. Em telas menores os botões viram ícones."]] },
      { title: "Tablet e celular", steps: ["Instale o app pela tela inicial para usar em tela cheia.", "Segure o dedo no título da coluna para filtrar.", "Faça pinça para dar zoom no mapa mental e no fluxo BPMN."] },
      { title: "Administração", cards: [["LOG", "Somente administradores, no rodapé. Chamadas ao banco desta sessão (método, recurso, status, tempo e erro) e erros de todos os usuários, com busca e filtro \"Só erros\"."], ["Atualizações", "Resumo das novidades da versão, no rodapé."]],
        tips: ["Se algo não aparecer depois de uma atualização, recarregue a página (Ctrl+Shift+R) ou feche e abra o app instalado."] }
    ] },
  contacts: { kicker: "Módulo", title: "Pessoas", path: ["Cabeçalho", "Pessoas"],
    lead: "Cadastro único dos contatos — clientes, leads, fornecedores e parceiros — vinculados a uma ou mais empresas.",
    sections: [
      { title: "Cadastrar uma pessoa", steps: ["Clique no <b>+</b> da barra.", "Preencha o nome e ao menos um telefone ou e-mail.", "Vincule uma ou mais empresas, o tipo de contato e o canal de origem.", "Complete cargo, departamento, redes sociais, grupos, tags, CPF, nascimento e observações e salve."],
        cards: [["Padronização", "Telefones e e-mails são padronizados ao salvar."], ["Sem duplicados", "Mesmo nome com o mesmo telefone ou e-mail atualiza o contato existente."], ["Colunas fixas", "Nome e telefone ficam fixos ao rolar a tabela."]] },
      HELP_TABLE_SECTION,
      { title: "Importar contatos", cards: [["Planilha", "Em ⬆⬇ Dados baixe a planilha modelo, preencha e importe. Pessoas com o mesmo nome e telefone ou e-mail são atualizadas; empresas são vinculadas pelo CNPJ ou nome."], ["Google Contatos", "Na extensão Chrome, em Integrações › Google Contatos, conecte a conta, ajuste o mapeamento de campos e importe."], ["Pelas conversas", "Em Conversas, associe a conversa a uma pessoa existente."]] }
    ] },
  companies: { kicker: "Módulo", title: "Empresas", path: ["Cabeçalho", "Empresas"],
    lead: "Empresas clientes e parceiras, com dados cadastrais públicos e as pessoas vinculadas. As entregas são vinculadas a uma empresa pelo CNPJ.",
    sections: [
      { title: "Cadastrar uma empresa", steps: ["Clique no <b>+</b> e digite o CNPJ.", "Clique em <b>Buscar dados</b>: razão social, nome fantasia, contato, abertura, situação, capital social, atividades, endereço e QSA vêm da Receita e não podem ser editados.", "Confira as inscrições estaduais (a primeira é a do estado da empresa; adicione outras UFs) e a inscrição municipal.", "Escolha o tipo de contato, as pessoas vinculadas e as observações e salve. Para corrigir dados, use <b>Atualizar da Receita</b>."],
        cards: [["Importar planilha", "Em ⬆⬇ Dados baixe o modelo e informe só CNPJ, tipo de contato, inscrição municipal e observações. A empresa entra na hora com a tag <b>Desatualizada</b> e o CMS busca os dados da Receita em segundo plano (cerca de 5 por minuto). Se a consulta falhar aparece <b>Erro na Receita</b>: use Atualizar da Receita."], ["Tipo de contato", "Cliente, Fornecedor e/ou Parceiro (ou vazio). Ao salvar, as pessoas vinculadas recebem os mesmos tipos e mantêm os próprios, como Colaborador e Network. Vazio não altera as pessoas. Empresa com entrega vira Cliente automaticamente e não pode deixar de ser."], ["Colunas fixas", "Nome fantasia e CNPJ ficam fixos ao rolar a tabela."]] },
      HELP_TABLE_SECTION
    ] },
  conversations: { kicker: "Módulo", title: "Conversas", path: ["Cabeçalho", "Conversas"],
    lead: "Histórico das conversas de WhatsApp e Reddit Chat, importado ou capturado pela extensão, ligado às pessoas e aos negócios.",
    sections: [
      { title: "Importar do WhatsApp", steps: ["No WhatsApp, abra a conversa e use <b>Exportar conversa</b>.", "No CMS, clique em <b>⬆⬇ Dados</b> e escolha importar.", "Selecione o arquivo .txt ou .zip.", "Associe a conversa a uma pessoa."] },
      { title: "Trabalhar as conversas", cards: [["Ler", "Clique na conversa para abrir as mensagens."], ["Associar contato", "Selecione uma ou várias conversas e ligue a uma pessoa."], ["Criar negociação", "Abre negócios a partir das conversas selecionadas."]] },
      { title: "Extensão Chrome", lead: "Na extensão as conversas do WhatsApp Web e do Reddit Chat são capturadas automaticamente. A versão web mostra o que foi capturado." }
    ] },
  deals: { kicker: "Módulo", title: "Negócios", path: ["Cabeçalho", "Negócios"],
    lead: "Oportunidades comerciais em pipelines com etapas, valor e previsão de fechamento.",
    sections: [
      { title: "Cadastrar um negócio", steps: ["Clique no <b>+</b>.", "Escolha a empresa (ou \"Não possui empresa\") e o contato.", "Escolha produto, pipeline, etapa e origem do lead.", "Informe valor e previsão de fechamento e salve."] },
      { title: "Quadro do pipeline", steps: ["Escolha <b>Quadro</b> na visualização.", "Arraste os cartões entre as etapas.", "Solte em <b>Ganho</b> ou <b>Perdido</b> para fechar."] },
      { title: "Ganho vira entrega", lead: "Quando o negócio é ganho, o CMS cria automaticamente a <b>Entrega</b> do cliente com o produto vendido, já com as tarefas, objetivos e metas do produto.",
        tips: ["Pipelines e etapas são configurados em Cadastros › Pipeline."] }
    ] },
  projects: { kicker: "Módulo", title: "Entregas", path: ["Cabeçalho", "Entregas", "👁 abrir"],
    lead: "A entrega é o projeto ou serviço pós-venda do cliente, no padrão <b>EC365 | Cliente | Produto</b>. Abra pelo ícone de olho para trabalhar nas abas Tarefas, Objetivos, Metas e Dados.",
    sections: [
      { title: "Formulário · aba Dados", steps: ["Clique no <b>+</b> ou no lápis.", "Escolha tipo, empresa (CNPJ), cliente, grupo e produto.", "Em renovações, aponte a entrega anterior do mesmo CNPJ em <b>Continuidade</b>.", "Defina o início; o fim é sugerido pela duração do produto. Inativa pede substatus Suporte ou Encerrado."] },
      { title: "Formulário · aba Setup", lead: "ERP, Marketplaces, Lojas, Frete, Situação da empresa e Contas financeiras (bancos e gateways). Cada canal ativado libera as tarefas daquele Canal e não pode ser desativado depois de salvo.",
        cards: [["Mercado Livre", "Traz Mercado Pago e Mercado Envios."], ["Nuvem Shop", "Traz Nuvem Pago e Nuvem Envio."], ["Tray", "Traz Vindi."], ["Situação da empresa", "Aberta ou em branco. Só informativo."]] },
      { title: "Aba Tarefas", lead: "Tarefas do produto e do dia a dia com subtarefas, checklist, responsáveis (colaboradores e Cliente), dependências, referências a documentos e tabelas, comentários e status.",
        cards: [["Visualizações", "Tabela, Quadro, Calendário, Gantt, Mapa mental, Matriz e Dashboard."], ["Prazos", "Cada tarefa tem duração e <b>Iniciar após dependência (dias)</b>. Quando a anterior termina, as dependentes são recalculadas pela data real ou prevista, com dias úteis e recorrência."]],
        tips: ["Datas editadas à mão não são recalculadas, e dependências circulares são bloqueadas."] },
      { title: "Abas Objetivos e Metas", cards: [["Objetivos", "Critério de conclusão, Categoria, Canal, responsável, prazo e dependências. O progresso vem das tarefas vinculadas."], ["Metas", "Indicador, comparação (no mínimo, no máximo, exato), valor atual, alvo, Categoria, Canal e prazo. Atualize o valor atual direto na tabela."], ["Dashboard", "Atingimento médio, atingidas, atrasadas e bloqueadas, lista de KPIs e quadro OKR."], ["OKR", "Objetivos (O) e metas (KR) com a mesma Categoria e Canal formam um cartão com o progresso geral."]] },
      { title: "Aba Dados", lead: "Faturamento mensal do negócio por canal durante a entrega e o histórico das entregas de continuidade." }
    ] },
  activities: { kicker: "Módulo", title: "Tarefas", path: ["Cabeçalho", "Tarefas"],
    lead: "Todas as tarefas de todas as entregas em um só lugar, com cliente, entrega, origem, prioridade, estrutura, datas, status, prazo e comentários.",
    sections: [
      { title: "Acompanhar", steps: ["Filtre por cliente, status, prioridade ou responsável.", "Altere o status direto na linha.", "Clique no lápis para abrir a tarefa no formulário da entrega."] },
      { title: "Agrupar e editar em massa", cards: [["≡ Agrupar por cliente", "Um grupo por cliente com a contagem; use ▸ para abrir um ou todos."], ["Edição em massa", "Neste módulo altera <b>Status</b> e <b>Prioridade</b>. Marque as tarefas, clique em ✎ em AÇÕES e escolha o valor."]] }
    ] },
  "reg-products": { kicker: "Cadastros", title: "Produtos", path: ["Rodapé", "Cadastros", "Produtos"],
    lead: "Categoria, nome, descrição, preços, página de vendas, duração e status. O produto carrega a estrutura que a entrega herda na venda.",
    sections: [{ title: "Montar um produto", steps: ["Clique no <b>+</b> e preencha os dados e a duração.", "Clique no olho para abrir a estrutura do produto.", "Vincule tarefas, objetivos e metas.", "Ao ganhar um negócio com o produto, a entrega nasce com essa estrutura."] }] },
  "reg-pipelines": { kicker: "Cadastros", title: "Pipeline", path: ["Rodapé", "Cadastros", "Pipeline"],
    lead: "Até cinco fluxos comerciais, cada um com suas etapas. Ganho e Perdido existem sempre.",
    sections: [{ title: "Criar um pipeline", steps: ["Clique no <b>+</b>.", "Dê o nome e adicione as etapas na ordem.", "Salve e use o pipeline nos negócios."] }] },
  "reg-users": { kicker: "Cadastros", title: "Usuários", path: ["Rodapé", "Cadastros", "Usuários"],
    lead: "Nome, apelido, e-mail, telefone, perfil, função, cargo, status, acesso ao login e permissões.",
    sections: [{ title: "Cadastrar e liberar acesso", steps: ["Clique no <b>+</b> e preencha os dados.", "Escolha o perfil: Administrador, Colaborador, Desenvolvedor, Cliente ou Fornecedor.", "Libere o acesso ao login.", "Marque por módulo: ver, criar, editar, clonar, excluir e operar."] }] },
  "reg-activities": { kicker: "Cadastros", title: "Tarefas", path: ["Rodapé", "Cadastros", "Tarefas"],
    lead: "Modelos de tarefa. A mesma tarefa pode valer para vários produtos e, ao salvar, as entregas desses produtos são sincronizadas.",
    sections: [
      { title: "Cadastrar um modelo", steps: ["Escolha os produtos.", "Monte o nome com <b>Usar estrutura</b>: Categoria | Canal | Módulo | Submódulo | Tarefa | Tipo.", "Defina prioridade, recorrência, dias úteis, prazo e iniciar após dependência.", "Adicione checklist, objetivo, responsáveis padrão, dependências e subtarefas."],
        tips: ["Usar estrutura exige Categoria, Canal, Módulo e Tipo. A coluna Tarefa fica fixa ao rolar."] },
      HELP_MIND_MAP_SECTION
    ] },
  "reg-goals": { kicker: "Cadastros", title: "Metas", path: ["Rodapé", "Cadastros", "Metas"],
    lead: "Modelos de meta com indicador, comparação, valor-alvo, Categoria, Canal, Observações, prazo sugerido, responsável e dependências.",
    sections: [{ title: "Visualizações", cards: [["Tabela", "Cadastro e filtros dos modelos."], ["Mapa mental", "Separa por Categoria › Canal."], ["Dashboard", "Fica dentro da entrega (ícone de olho), com os dados reais de cada cliente."]] }] },
  "reg-objectives": { kicker: "Cadastros", title: "Objetivos", path: ["Rodapé", "Cadastros", "Objetivos"],
    lead: "Modelos de objetivo com critério de conclusão, Categoria, Canal, Observações, prazo sugerido, responsável e dependências.",
    sections: [{ title: "Visualizações", cards: [["Tabela", "Cadastro e filtros dos modelos."], ["Mapa mental", "Separa por Categoria › Canal."], ["Dashboard", "Fica dentro da entrega (ícone de olho), com os dados reais de cada cliente."]] }] },
  "tool-files": { kicker: "Ferramentas", title: "Arquivos", path: ["Rodapé", "Ferramentas", "Arquivos"],
    lead: "Catálogo de arquivos por empresa com status, cliente, até cinco níveis de setor, referência ou link do arquivo e data.",
    sections: [{ title: "Cadastrar", steps: ["Clique no <b>+</b>.", "Escolha empresa e cliente.", "Classifique nos setores 1 a 5.", "Informe a referência ou o link e salve."] }] },
  "tool-emails": { kicker: "Ferramentas", title: "Emails", path: ["Rodapé", "Ferramentas", "Emails"],
    lead: "Contas criadas automaticamente para as entregas no domínio <b>@ecommerce365.com.br</b>.",
    sections: [{ title: "Usar", cards: [["Senha", "Pode ser revelada ou copiada. Fica criptografada no banco."], ["Busca", "Filtre por entrega, cliente ou endereço."]] }] },
  "tool-processes": { kicker: "Ferramentas", title: "Processos", path: ["Rodapé", "Ferramentas", "Processos"],
    lead: "Biblioteca de procedimentos com Categoria, Canal, Módulo, Submódulo, tags e etapas, desenhada como fluxo BPMN.",
    sections: [
      { title: "Cadastrar as etapas", steps: ["Preencha Categoria, Canal, Módulo e Submódulo.", "Adicione as etapas e escolha o elemento: <b>Tarefa</b>, <b>Decisão</b> ou <b>Fim</b>.", "Defina o responsável (cargo, Cliente ou Sistema) e a próxima etapa.", "Nas decisões, rotule as saídas (ex.: Sim → 4, Não → 2)."],
        tips: ["Escolher uma etapa anterior como próxima cria um retrabalho (loop)."] },
      { title: "Fluxo BPMN", cards: [["Símbolos", "Início no círculo verde, fim no círculo vermelho, decisões em losango e setas com o rótulo das saídas."], ["Raias", "No botão à direita do painel: Responsável, Sistema ou Módulo (agrupado por Submódulo)."], ["ⓘ Detalhes", "Ao lado das raias. Ativo, cada etapa mostra no próprio fluxo responsável, sistema, módulo, grupo, tipo e detalhes."], ["Controles", "⇆/⇅ orientação, zoom, ✋ mãozinha e ⛶ tela cheia no painel do canto."], ["Exportar", "Em tela cheia aparecem PDF e PNG, com o fluxo inteiro em fundo branco."], ["Editar", "Clique na etapa para ver os detalhes; <b>Editar processo</b> abre o formulário por cima do fluxo e, ao salvar, ele é redesenhado."]] }
    ] },
  "tool-documents": { kicker: "Ferramentas", title: "Documentação", path: ["Rodapé", "Ferramentas", "Documentação"],
    lead: "Documentos em slides com blocos, formatação, cores, orientação e breadcrumb.",
    sections: [{ title: "Criar um documento", steps: ["Informe Categoria, Canal, Módulo, Submódulo e Tipo.", "O nome é montado sozinho: <b>CATEGORIA | CANAL | MÓDULO | SUBMÓDULO | TIPO</b>.", "Monte os slides com os blocos.", "Use ≡ para agrupar por Categoria + Canal + Módulo."] }] },
  "tool-tables": { kicker: "Ferramentas", title: "Tabelas", path: ["Rodapé", "Ferramentas", "Tabelas"],
    lead: "Tabelas personalizadas com abas, que podem ser referenciadas nas tarefas.",
    sections: [
      { title: "Estrutura e nome", steps: ["Na barra da tabela preencha Categoria, Canal, Módulo, Submódulo e Nome.", "Marque <b>Usar como nome do arquivo</b> para o nome virar CATEGORIA | CANAL | MÓDULO | SUBMÓDULO | NOME.", "Salve."] },
      { title: "Colunas", cards: [["Menu da coluna", "Clique no <b>⋮</b> ou com o botão direito no título: congelar, ordenar, filtrar, ajustar largura, inserir à esquerda/direita e excluir."], ["Congelar", "Congela da primeira coluna até a escolhida; elas ficam fixas ao rolar para a direita (📌)."], ["Dimensionar", "Arraste a borda direita do título. Duplo clique ajusta ao conteúdo."], ["Excluir", "Pede confirmação no próprio menu e só é definitivo ao salvar a tabela."]] },
      { title: "Importar", steps: ["Clique em <b>⬆⬇ Dados</b>.", "Escolha um CSV, XLS ou XLSX (administradores)."] }
    ] },
  social: { kicker: "Rodapé", title: "Social", path: ["Rodapé", "Social"],
    lead: "Abre na Home com os perfis configurados em Integrações: Facebook, Instagram, LinkedIn, Reddit, TikTok Shop e YouTube.",
    sections: [{ title: "Redes", lead: "Cada rede tem sua aba com a tabela do módulo, colunas, filtros e exportação de dados." }] }
};
const HELP_PAGE_BY_MAIN = { contacts: "contacts", companies: "companies", conversations: "conversations", deals: "deals", projects: "projects", activities: "activities" };
let helpPageId = "home";

function helpSectionHtml(section) {
  const platformText = IS_EXTENSION_CONTEXT
    ? "Você está na extensão Chrome, com captura de WhatsApp Web e Reddit Chat e importação do Google Contatos."
    : "Você está na versão web. A captura de WhatsApp Web e Reddit Chat e a importação do Google Contatos são exclusivas da extensão Chrome.";
  return `<section class="help-block">
    <h4>${esc(section.title)}</h4>${section.lead ? `<p class="help-block-lead">${section.lead}</p>` : ""}
    ${section.steps?.length ? `<ol class="help-steps">${section.steps.map((step) => `<li>${step}</li>`).join("")}</ol>` : ""}
    ${section.cards?.length ? `<div class="help-cards">${section.cards.map(([title, text]) => `<div class="help-card"><b>${title}</b><p>${text === "PLATFORM_TEXT" ? platformText : text}</p></div>`).join("")}</div>` : ""}
    ${section.tips?.length ? `<div class="help-tips">${section.tips.map((tip) => `<p><span>Dica</span>${tip}</p>`).join("")}</div>` : ""}
  </section>`;
}

function renderHelpSection() {
  const root = document.getElementById("help-root");
  if (!root) return;
  const page = HELP_PAGES[helpPageId] || HELP_PAGES.home;
  document.querySelectorAll("[data-help-page]").forEach((button) => button.classList.toggle("active", button.dataset.helpPage === helpPageId));
  root.querySelector(".help-body").innerHTML = `<article class="help-page">
    <div class="help-hero">
      <div><span class="help-kicker">${esc(page.kicker)}</span><h2>${esc(page.title)}</h2><p>${page.lead}</p></div>
      <div class="help-path"><span>Onde encontrar</span><div>${page.path.map((item) => `<b>${esc(item)}</b>`).join("<i>›</i>")}</div></div>
    </div>
    ${page.sections.map(helpSectionHtml).join("")}
  </article>`;
  root.querySelector(".help-body").scrollTop = 0;
}

function openHelpModal(pageId = HELP_PAGE_BY_MAIN[state.tab] || "home") {
  helpPageId = HELP_PAGES[pageId] ? pageId : "home";
  const headerCenter = `<div class="modal-header-tabs help-header-tabs" role="tablist" aria-label="Módulos">
    ${HELP_HEADER_SLOTS.map(([id, label]) => `<button class="modal-header-tab" data-help-page="${id}" role="tab">${label}</button>`).join("")}
  </div>`;
  shell("Ajuda", `<div id="help-root" class="help-root">
      <div class="help-toolbar">
        <button class="registration-toolbar-title help-home-btn" data-help-page="home" type="button" title="Visão geral da ajuda">Ajuda</button>
        <div class="help-subtabs" role="tablist" aria-label="Submódulos">${HELP_TOOLBAR_SLOTS.map(([id, label]) => `<button class="help-subtab" data-help-page="${id}" role="tab">${label}</button>`).join("")}</div>
      </div>
      <div class="help-body"></div>
    </div>`, {
    cls: "full registrations-modal",
    headerCenter,
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CMS</b></span>'
  });
  document.querySelectorAll("[data-help-page]").forEach((button) => button.addEventListener("click", () => {
    helpPageId = button.dataset.helpPage;
    renderHelpSection();
  }));
  renderHelpSection();
}

// ---------- Pipelines (fluxos de negociação) ----------
// Modal cheio, com estado próprio (lista <-> formulário) dentro do MESMO
// shell — não abre um segundo modal por cima, senão a troca de tela
// substituiria o modal-root inteiro e a lista se perderia.
let pmState = { mode: "list" };
function openPipelinesModal(editId = null, returnToRegistrations = false) {
  if (!requireCurrentUserPermission("pipelines", "view", "Pipeline")) return;
  if (returnToRegistrations) {
    openPipelineDrawer(editId);
    return;
  }
  const pipeline = editId && editId !== "new" ? cache.pipelines.find((item) => item.id === editId) : null;
  pmState = editId
    ? { mode: "form", editId: pipeline?.id || null, name: pipeline?.name || "", stages: pipeline ? [...pipeline.stages] : [""] }
    : { mode: "list" };
  shell("Pipelines · Fluxos de negociação", `<div id="pm-body" class="full-body"></div>`, {
    cls: "full",
    onClose: returnToRegistrations ? () => openRegistrationsModal("pipelines") : null
  });
  renderPipelinesModal();
}
function closePipelineDrawer() {
  document.getElementById("pipeline-drawer-overlay")?.remove();
}
function openPipelineDrawer(editId = "new") {
  if (!requireCurrentUserPermission("pipelines", editId && editId !== "new" ? "edit" : "create", "Pipeline")) return;
  closePipelineDrawer();
  const pipeline = editId && editId !== "new" ? cache.pipelines.find((item) => item.id === editId) : null;
  pmState = { mode: "form", editId: pipeline?.id || null, name: pipeline?.name || "", stages: pipeline ? [...pipeline.stages] : [""] };
  const overlay = document.createElement("div");
  overlay.id = "pipeline-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer">
    <h3>${pmState.editId ? "Editar pipeline" : "Novo pipeline"}<button class="modal-close-x" id="pipeline-drawer-close" title="Fechar">✕</button></h3>
    <div id="pipeline-drawer-body"></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  document.getElementById("pipeline-drawer-close")?.addEventListener("click", closePipelineDrawer);
  renderPipelineDrawer();
}
function renderPipelineDrawer() {
  const body = document.getElementById("pipeline-drawer-body");
  if (!body) return;
  body.innerHTML = pipelineFormHtml();
  wirePipelineForm({
    rerender: renderPipelineDrawer,
    onCancel: closePipelineDrawer,
    onSaved: () => {
      closePipelineDrawer();
      renderRegistrationsSection();
    }
  });
  document.getElementById("pipeline-name")?.focus({ preventScroll: true });
}
function renderPipelinesModal() {
  const el = document.getElementById("pm-body");
  if (!el) return;
  el.innerHTML = pmState.mode === "list" ? pipelinesListHtml() : pipelineFormHtml();
  wirePipelinesModal();
}
function pipelinesListHtml() {
  const list = cache?.pipelines || [];
  const rows = list.map((p) => `<div class="entity-row">
      <div class="entity-main"><b>${esc(p.name)}</b><span class="muted"> · ${p.stages.length} etapa(s)</span>
        <div class="muted" style="margin-top:4px">${p.stages.map(esc).join(" → ")} → <b>Ganho</b> / <b>Perdido</b></div></div>
      <div class="entity-actions">
        <button class="rowbtn edit" data-id="${esc(p.id)}" title="Editar">✎</button>
        <button class="rowbtn del" data-id="${esc(p.id)}" title="Excluir">🗑</button>
      </div></div>`).join("");
  const canAdd = list.length < MAX_PIPELINES;
  return `<div class="modal-toolbar">
      <span class="muted">${list.length}/${MAX_PIPELINES} pipelines</span>
      <button class="btn primary plus" id="new-pipeline" title="Novo pipeline"${canAdd ? "" : " disabled"}>+</button>
    </div>
    <div class="entity-list">${rows || '<div class="empty">Nenhum pipeline criado ainda.</div>'}</div>`;
}
function pipelineFormHtml() {
  const stagesHtml = pmState.stages.map((s, i) => `<div class="stage-row">
      <input type="text" class="stage-input" data-i="${i}" value="${esc(s)}" placeholder="Nome da etapa">
      <button class="rowbtn del-stage" data-i="${i}" title="Remover etapa">✕</button>
    </div>`).join("");
  return `<div class="form" style="grid-template-columns:1fr">
      <div class="field full"><label>Nome do pipeline</label><input id="pipeline-name" value="${esc(pmState.name)}" placeholder="Ex.: Vendas B2B"></div>
      <div class="field full"><label>Etapas (na ordem do funil)</label>
        <div id="stage-list">${stagesHtml}</div>
        <button class="btn" id="add-stage" style="margin-top:8px">+ Etapa</button>
      </div>
    </div>
    <div class="panel-list" style="padding-top:0"><b>Ganho</b> e <b>Perdido</b> são fixos — não precisa cadastrar, todo pipeline já termina com essas duas colunas.</div>
    <div class="modal-foot">
      <button class="btn" id="cancel-form">Voltar</button>
      <button class="btn primary" id="save-pipeline">${pmState.editId ? "Salvar" : "Criar"}</button>
    </div>`;
}
function wirePipelinesModal() {
  if (pmState.mode === "list") {
    document.getElementById("new-pipeline")?.addEventListener("click", () => {
      if ((cache.pipelines || []).length >= MAX_PIPELINES) return;
      pmState = { mode: "form", editId: null, name: "", stages: [""] };
      renderPipelinesModal();
    });
    document.querySelectorAll("#pm-body .rowbtn.edit").forEach((b) =>
      b.addEventListener("click", () => {
        const p = cache.pipelines.find((x) => x.id === b.dataset.id);
        if (!p) return;
        pmState = { mode: "form", editId: p.id, name: p.name, stages: [...p.stages] };
        renderPipelinesModal();
      }));
    document.querySelectorAll("#pm-body .rowbtn.del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Excluir este pipeline? Os negócios que estavam nele ficam sem pipeline.")) return;
        try { await deleteRow("pipelines", b.dataset.id); await init(); renderPipelinesModal(); toast("Pipeline excluído."); }
        catch (err) { toast("Erro ao excluir · " + err.message, true); }
      }));
  } else wirePipelineForm({
    rerender: renderPipelinesModal,
    onCancel: () => { pmState = { mode: "list" }; renderPipelinesModal(); },
    onSaved: () => { pmState = { mode: "list" }; renderPipelinesModal(); }
  });
}
function wirePipelineForm({ rerender, onCancel, onSaved }) {
  document.getElementById("cancel-form")?.addEventListener("click", onCancel);
  document.getElementById("add-stage")?.addEventListener("click", () => { pmState.stages.push(""); rerender(); });
  document.querySelectorAll(".stage-input").forEach((input) =>
    input.addEventListener("input", () => { pmState.stages[Number(input.dataset.i)] = input.value; }));
  document.querySelectorAll(".del-stage").forEach((button) =>
    button.addEventListener("click", () => { pmState.stages.splice(Number(button.dataset.i), 1); rerender(); }));
  document.getElementById("pipeline-name")?.addEventListener("input", (event) => { pmState.name = event.target.value; });
  document.getElementById("save-pipeline")?.addEventListener("click", async () => {
    const saveButton = document.getElementById("save-pipeline");
    if (saveButton?.disabled) return;
    const name = document.getElementById("pipeline-name").value.trim();
    const stages = pmState.stages.map((stage) => stage.trim()).filter(Boolean);
    if (!name) { toast("Dê um nome ao pipeline.", true); return; }
    if (!stages.length) { toast("Adicione ao menos uma etapa.", true); return; }
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
    try {
      const saved = pmState.editId
        ? await updateRow("pipelines", pmState.editId, { name, stages })
        : await createRow("pipelines", { name, stages });
      if (pmState.editId) cache.pipelines = cache.pipelines.map((pipeline) => pipeline.id === pmState.editId ? saved : pipeline);
      else cache.pipelines.push(saved);
      cache.pipelineById = Object.fromEntries(cache.pipelines.map((pipeline) => [pipeline.id, pipeline]));
      toast("Pipeline salvo.");
      onSaved(saved);
    } catch (err) {
      toast("Erro ao salvar pipeline · " + err.message, true);
      if (saveButton?.isConnected) { saveButton.disabled = false; saveButton.textContent = pmState.editId ? "Salvar" : "Criar"; }
    }
  });
}

// ---------- Usuários (responsáveis pelos negócios) ----------
const ROLE_LABEL = {
  collaborator: "Colaborador",
  developer: "Desenvolvedor",
  admin: "Administrador",
  client: "Cliente",
  supplier: "Fornecedor",
};
const ROLE_DESCRIPTION = {
  collaborator: "Realiza operações conforme as permissões por módulo.",
  developer: "Acesso para testes. Nenhuma alteração é gravada no banco.",
  admin: "Pode fazer tudo no sistema, inclusive gerenciar acessos.",
  client: "Acesso somente para visualizar os dados liberados da própria empresa.",
  supplier: "Acesso limitado para empresas terceiras que apoiam a operação.",
};
function normalizedProfileRole(role) {
  return role === "user" || !ROLE_LABEL[role] ? "collaborator" : role;
}
let umState = { mode: "list" };
let umReturnToRegistrations = false;
let umCloseAction = null;
function generateStrongPassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*"];
  const randomFrom = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const chars = groups.map(randomFrom);
  const all = groups.join("");
  while (chars.length < 16) chars.push(randomFrom(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch (e) {
    const input = document.createElement("textarea");
    input.value = value; input.style.position = "fixed"; input.style.opacity = "0";
    document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove();
  }
}
function openUsersModal(editId = null, returnToRegistrations = false) {
  if (!requireCurrentUserAdmin("Usuários")) return;
  const user = editId && editId !== "new" ? cache.users.find((item) => item.id === editId) : null;
  umReturnToRegistrations = returnToRegistrations;
  if (user) umState = { mode: "form", editId: user.id, full_name: user.full_name || user.name || "", nickname: user.nickname || "", email: user.email || "", phone: user.phone || "", role: normalizedProfileRole(user.role), company_ids: normalizeTextList(user.company_ids), function_name: user.function_name || "", job_title: user.job_title || "", status: user.status || "active", password: "", hasAccess: Boolean(user.auth_user_id), permissions: normalizeUserPermissions(user.permissions) };
  else if (editId === "new") umState = { mode: "form", editId: null, full_name: "", nickname: "", email: "", phone: "", role: "collaborator", company_ids: [], function_name: "", job_title: "", status: "active", password: generateStrongPassword(), hasAccess: false, permissions: defaultPermissionsForRole("collaborator") };
  else umState = { mode: "list" };
  const title = user ? "Editar usuário" : editId === "new" ? "Novo usuário" : "Usuários · Responsáveis";
  const nestedRegistration = Boolean(returnToRegistrations && document.getElementById("registrations-root"));
  umCloseAction = nestedRegistration
    ? nestedSidePanel(title, `<div id="um-body"></div>`, { closeOnOverlay: true })
    : sidePanel(title, `<div id="um-body"></div>`, {
      closeOnOverlay: true,
      onClose: returnToRegistrations ? () => openRegistrationsModal("users") : null
    });
  renderUsersModal();
}
function closeUsersModal() {
  if (umReturnToRegistrations && document.getElementById("registrations-root")) {
    umCloseAction?.();
    renderRegistrationsSection();
  } else if (umReturnToRegistrations) openRegistrationsModal("users");
  else { umState = { mode: "list" }; renderUsersModal(); }
}
function renderUsersModal() {
  const el = document.getElementById("um-body");
  if (!el) return;
  el.innerHTML = umState.mode === "list"
    ? usersListHtml()
    : umState.mode === "credentials"
      ? userCredentialsHtml()
      : userFormHtml();
  if (umState.mode === "form") {
    const emailInput = document.getElementById("u-email");
    if (emailInput) emailInput.value = umState.email || "";
  }
  wireUsersModal();
}
function usersListHtml() {
  const list = cache?.users || [];
  const rows = list.map((u) => `<div class="entity-row">
      <div class="entity-main"><b>${esc(u.full_name || u.name || "—")}</b><span class="muted"> · ${esc(u.nickname ? `Apelido: ${u.nickname}` : "Sem apelido")} · ${esc(u.email || "sem e-mail")}</span>
        <div class="muted" style="margin-top:4px">Perfil: ${esc(ROLE_LABEL[u.role] || u.role || "—")} · Função: ${esc(u.function_name || "—")} · Cargo: ${esc(u.job_title || "—")}</div>
        <div class="muted" style="margin-top:3px">${u.status === "active" ? "Ativo" : "Inativo"} · ${u.auth_user_id ? "Login ativo" : "Sem login"}</div></div>
      <div class="entity-actions">
        <button class="rowbtn edit" data-id="${esc(u.id)}" title="Editar">✎</button>
        <button class="rowbtn del" data-id="${esc(u.id)}" title="Excluir">🗑</button>
      </div></div>`).join("");
  return `<div class="modal-toolbar">
      <span class="muted">${list.length} usuário(s)</span>
      <div class="modal-toolbar-actions"><button class="btn primary plus" id="new-user" title="Novo usuário">+</button></div>
    </div>
    <div class="entity-list">${rows || '<div class="empty">Nenhum usuário cadastrado.</div>'}</div>`;
}
function permissionsMatrixHtml() {
  const permissions = normalizeUserPermissions(umState.permissions);
  const admin = umState.role === "admin";
  return `<div class="field full user-permissions-field"><label>Permissões por módulo</label>
    <div class="permissions-matrix${admin ? " is-admin" : ""}">
      <div class="permissions-row permissions-head"><strong>Módulo</strong>${PERMISSION_ACTIONS.map((action) => `<span>${esc(action.label)}</span>`).join("")}</div>
      ${PERMISSION_GROUPS.map((group) => `<div class="permissions-group-title">${esc(group.label)}</div>${group.modules.map(([moduleId, label]) => {
        const values = permissions[moduleId] || {};
        return `<div class="permissions-row" data-permission-module="${esc(moduleId)}"><strong>${esc(label)}</strong>${PERMISSION_ACTIONS.map((action) => {
          const checked = admin || values[action.id];
          const unavailable = moduleId === "users" && !admin;
          return `<label class="permission-check${unavailable ? " unavailable" : ""}" title="${esc(action.label)} · ${esc(label)}"><input type="checkbox" data-permission-action="${action.id}"${checked ? " checked" : ""}${admin || unavailable ? " disabled" : ""}><span></span></label>`;
        }).join("")}</div>`;
      }).join("")}`).join("")}
    </div>
    <small class="muted">Operar permite executar tarefas, atualizar status, prazos e checklist sem liberar alterações estruturais.</small>
  </div>`;
}
function readPermissionsMatrix() {
  const permissions = normalizeUserPermissions(umState.permissions);
  document.querySelectorAll("#um-body [data-permission-module]").forEach((row) => {
    const moduleId = row.dataset.permissionModule;
    row.querySelectorAll("[data-permission-action]").forEach((input) => {
      permissions[moduleId][input.dataset.permissionAction] = input.checked;
    });
  });
  return permissions;
}
function userFormHtml() {
  const companyOptions = (cache?.companies || []).map((company) => ({
    value: company.tax_id,
    label: company.trade_name || company.legal_name || company.name || company.tax_id,
    detail: company.tax_id,
  }));
  const showCompanies = ["client", "supplier"].includes(umState.role);
  return `<div class="form">
      <div class="field full"><label>Nome completo</label><input id="u-name" value="${esc(umState.full_name)}"></div>
      <div class="field"><label>Apelido</label><input id="u-nickname" value="${esc(umState.nickname || "")}" placeholder="Nome exibido nos responsáveis"></div>
      <div class="field"><label>E-mail de acesso</label><input id="u-email" type="email" autocomplete="off" value="${esc(umState.email)}"></div>
      <div class="field"><label>Telefone</label><input id="u-phone" value="${esc(umState.phone)}"></div>
      <div class="field"><label>Perfil</label><select id="u-role">
        ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}"${umState.role === v ? " selected" : ""}>${l}</option>`).join("")}
      </select><small class="muted">${esc(ROLE_DESCRIPTION[umState.role] || "")}</small></div>
      <div class="field"><label>Função</label><input id="u-function" value="${esc(umState.function_name)}" placeholder="Ex.: Gestão de projetos"></div>
      <div class="field"><label>Cargo</label><input id="u-job-title" value="${esc(umState.job_title)}" placeholder="Ex.: Analista de implantação"></div>
      <div class="field"><label>Status</label><select id="u-status">
        <option value="active"${umState.status === "active" ? " selected" : ""}>Ativo</option>
        <option value="inactive"${umState.status === "inactive" ? " selected" : ""}>Inativo</option>
      </select></div>
      ${showCompanies ? `<div class="field full"><label>Empresa(s) vinculada(s)</label>${multiPickerHtml("u-companies", companyOptions, umState.company_ids || [], "Buscar empresa por nome ou CNPJ", true)}<small class="muted">Este perfil visualizará somente registros relacionados às empresas selecionadas.</small></div>` : ""}
      ${permissionsMatrixHtml()}
      <div class="field full"><label>${umState.hasAccess ? "Nova senha (deixe em branco para manter a atual)" : "Senha de acesso"}</label>
        <div class="input-action-row"><input id="u-password" type="text" value="${esc(umState.password)}" readonly placeholder="Gere uma senha segura">
          <button class="btn" type="button" id="generate-password">Gerar</button><button class="btn" type="button" id="copy-password"${umState.password ? "" : " disabled"}>Copiar</button></div>
        <small class="muted">A senha é salva com segurança no Supabase Auth e não fica disponível depois.</small>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="cancel-form">Voltar</button>
      <button class="btn primary" id="save-user">${umState.editId ? "Salvar" : "Criar"}</button>
    </div>`;
}
function userCredentialsHtml() {
  const access = `ENTERPRISER • CMS\nE-mail: ${umState.email}\nSenha: ${umState.password}`;
  return `<div class="panel-list"><b>Acesso salvo</b><p>Copie os dados agora. Por segurança, a senha não poderá ser consultada depois.</p></div>
    <div class="form">
      <div class="field full"><label>E-mail</label><input value="${esc(umState.email)}" readonly></div>
      <div class="field full"><label>Senha</label><div class="input-action-row"><input value="${esc(umState.password)}" readonly><button class="btn primary" id="copy-access" type="button">Copiar acesso</button></div></div>
    </div>
    <div class="modal-foot"><button class="btn primary" id="credentials-done">Concluir</button></div>
    <textarea id="credentials-value" hidden>${esc(access)}</textarea>`;
}
function wireUsersModal() {
  if (umState.mode === "list") {
    document.getElementById("new-user")?.addEventListener("click", () => {
      umState = { mode: "form", editId: null, full_name: "", nickname: "", email: "", phone: "", role: "collaborator", company_ids: [], function_name: "", job_title: "", status: "active", password: generateStrongPassword(), hasAccess: false, permissions: defaultPermissionsForRole("collaborator") };
      renderUsersModal();
    });
    document.querySelectorAll("#um-body .rowbtn.edit").forEach((b) =>
      b.addEventListener("click", () => {
        const u = cache.users.find((x) => x.id === b.dataset.id);
        if (!u) return;
        umState = { mode: "form", editId: u.id, full_name: u.full_name || u.name || "", nickname: u.nickname || "", email: u.email || "", phone: u.phone || "", role: normalizedProfileRole(u.role), company_ids: normalizeTextList(u.company_ids), function_name: u.function_name || "", job_title: u.job_title || "", status: u.status || "active", password: "", hasAccess: Boolean(u.auth_user_id), permissions: normalizeUserPermissions(u.permissions) };
        renderUsersModal();
      }));
    document.querySelectorAll("#um-body .rowbtn.del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Excluir este usuário?")) return;
        try {
          if (isLive()) await callUserAdmin("delete-user", { profile_id: b.dataset.id });
          else await deleteRow("users", b.dataset.id);
          await init(); renderUsersModal(); toast("Usuário excluído.");
        }
        catch (err) { toast("Erro ao excluir · " + err.message, true); }
      }));
  } else if (umState.mode === "credentials") {
    document.getElementById("copy-access")?.addEventListener("click", async () => {
      await copyText(document.getElementById("credentials-value").value); toast("Acesso copiado.");
    });
    document.getElementById("credentials-done")?.addEventListener("click", () => {
      closeUsersModal();
    });
  } else {
    wireMultiPicker("u-companies");
    document.getElementById("u-role")?.addEventListener("change", (event) => {
      umState.full_name = document.getElementById("u-name")?.value || "";
      umState.nickname = document.getElementById("u-nickname")?.value || "";
      umState.email = document.getElementById("u-email")?.value || "";
      umState.phone = document.getElementById("u-phone")?.value || "";
      umState.function_name = document.getElementById("u-function")?.value || "";
      umState.job_title = document.getElementById("u-job-title")?.value || "";
      umState.status = document.getElementById("u-status")?.value || "active";
      umState.password = document.getElementById("u-password")?.value || "";
      umState.company_ids = multiPickerValues("u-companies");
      umState.role = event.target.value;
      umState.permissions = defaultPermissionsForRole(umState.role);
      renderUsersModal();
    });
    document.getElementById("cancel-form")?.addEventListener("click", () => {
      closeUsersModal();
    });
    document.getElementById("generate-password")?.addEventListener("click", () => {
      umState.password = generateStrongPassword();
      document.getElementById("u-password").value = umState.password;
      document.getElementById("copy-password").disabled = false;
    });
    document.getElementById("copy-password")?.addEventListener("click", async () => {
      const password = document.getElementById("u-password").value;
      if (password) { await copyText(password); toast("Senha copiada."); }
    });
    document.getElementById("save-user")?.addEventListener("click", async () => {
      const saveButton = document.getElementById("save-user");
      if (saveButton?.disabled) return;
      const full_name = document.getElementById("u-name").value.trim();
      if (!full_name) { toast("Informe o nome.", true); return; }
      const email = (document.getElementById("u-email").value.trim() || umState.email || "").toLowerCase();
      if (!email) { toast("Informe o e-mail de acesso.", true); return; }
      const password = document.getElementById("u-password").value;
      if (!umState.hasAccess && !password) { toast("Gere uma senha para ativar o acesso.", true); return; }
      const body = {
        full_name,
        nickname: document.getElementById("u-nickname").value.trim() || null,
        email,
        phone: document.getElementById("u-phone").value.trim() || null,
        role: document.getElementById("u-role").value,
        company_ids: multiPickerValues("u-companies"),
        function_name: document.getElementById("u-function").value.trim() || null,
        job_title: document.getElementById("u-job-title").value.trim() || null,
        password,
        status: document.getElementById("u-status").value,
        permissions: document.getElementById("u-role").value === "admin" ? {} : readPermissionsMatrix()
      };
      const saveButtonLabel = saveButton?.textContent || "Salvar";
      if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Salvando..."; }
      try {
        let savedProfile;
        if (isLive()) {
          const result = await callUserAdmin("save-user", { profile_id: umState.editId, ...body });
          savedProfile = fromRemoteRow("users", result.profile);
        } else {
          const { password: ignoredPassword, ...profileBody } = body;
          savedProfile = umState.editId
            ? await updateRow("users", umState.editId, { ...profileBody, auth_user_id: umState.hasAccess ? "demo-auth" : crypto.randomUUID() })
            : await createRow("users", { ...profileBody, auth_user_id: crypto.randomUUID() });
        }
        const cachedProfile = upsertCachedEntity("users", savedProfile);
        if (currentProfile?.id === cachedProfile?.id) currentProfile = cachedProfile;
        toast("Usuário salvo.");
        if (password) {
          umState = { mode: "credentials", email, password };
          renderUsersModal();
        } else if (umReturnToRegistrations) closeUsersModal();
        else { umState = { mode: "list" }; renderUsersModal(); }
        void init();
      } catch (err) {
        if (saveButton?.isConnected) { saveButton.disabled = false; saveButton.textContent = saveButtonLabel; }
        toast("Erro ao salvar usuário · " + err.message, true);
      }
    });
  }
}

// ---------- Cadastros centrais ----------
const REGISTRATION_LABEL = {
  products: "Produtos",
  pipelines: "Pipeline",
  users: "Usuários",
  activities: "Tarefas",
  goals: "Metas",
  objectives: "Objetivos"
};
let registrationsState = { section: "products", tables: {} };

function openRegistrationsModal(section = "products") {
  const available = Object.keys(REGISTRATION_LABEL).filter((id) => currentUserCan(REGISTRATION_PERMISSION_MODULE[id], "view"));
  if (!available.length) { toast("Você não possui acesso aos Cadastros.", true); return; }
  if (!available.includes(section)) section = available[0];
  registrationsState = { section, tables: {} };
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Cadastros">
    ${Object.entries(REGISTRATION_LABEL).filter(([id]) => available.includes(id)).map(([id, label]) => `<button class="modal-header-tab${id === section ? " active" : ""}" data-registration-tab="${id}" role="tab">${label}</button>`).join("")}
  </div>`;
  const disabledFooter = `<div class="registrations-footer" aria-disabled="true">
    ${currentUserIsAdmin() ? '<button class="foot-btn" disabled>LOG</button>' : ""}
    <button class="foot-btn" disabled>AJUDA</button>
    <button class="foot-btn" disabled>CADASTROS</button>
    <button class="foot-btn" disabled>FERRAMENTAS</button>
    <button class="foot-btn" disabled>SOCIAL</button>
    <button class="foot-btn" disabled>ATUALIZAÇÕES</button>
  </div>`;
  shell("Cadastros", `<div id="registrations-root" class="full-body registrations-root"></div>${disabledFooter}`, {
    cls: "full registrations-modal",
    headerCenter,
    headerActions: liveRefreshButtonHtml(),
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CMS</b></span>'
  });
  document.querySelectorAll("[data-registration-tab]").forEach((button) => button.addEventListener("click", () => {
    document.getElementById("registration-filter-dd")?.remove();
    registrationsState.section = button.dataset.registrationTab;
    document.querySelectorAll("[data-registration-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderRegistrationsSection();
  }));
  renderRegistrationsSection();
}

function registrationProductName(productId) {
  return cache.productById?.[productId]?.name || cache.products.find((product) => product.id === productId)?.name || "Produto não encontrado";
}

const REGISTRATION_MIND_MAP_TEMPLATE_ADAPTER = {
  scope: "registration",
  groupId: (item) => item.template_group_id || item.id,
  parent: (item, items) => productTemplateParent(item, items),
  dependencies: (item) => normalizeIdList(item.dependency_template_ids, item.depends_on_template_id),
  subtitle: (node) => [...new Set(node.linked.map((item) => registrationProductName(item.product_id)))].join(", ") || "Sem produto",
  searchText: (item) => registrationProductName(item.product_id),
  editClass: "reg-template-edit",
  editAttrs: (item) => `data-id="${esc(item.id)}" data-product="${esc(item.product_id)}"`
};
const DELIVERY_MIND_MAP_TASK_ADAPTER = {
  scope: "delivery",
  groupId: (item) => item.id,
  parent: (item, items) => item.parent_activity_id ? items.find((candidate) => candidate.id === item.parent_activity_id) || null : null,
  dependencies: (item) => normalizeIdList(item.dependency_ids, item.depends_on_activity_id),
  subtitle: (node) => {
    const status = TASK_STATUS.find((entry) => entry.id === (node.item.status || "todo"))?.label || "Em aberto";
    const due = node.item.due_date || node.item.planned_end_date;
    return due ? `${status} · ${dt(due)}` : status;
  },
  searchText: () => "",
  editClass: "delivery-mind-task-open",
  editAttrs: (item) => `data-id="${esc(item.id)}"`
};

const mindMapTitle = (adapter, item) => (adapter?.title || activityDisplayName)(item);
const MIND_MAP_CATEGORY_LEVELS = [{ key: "category", empty: "Sem categoria" }, { key: "channel", empty: "Sem canal" }];
const mindMapStatusLabel = (item) => TASK_STATUS.find((entry) => entry.id === (item.status || "todo"))?.label || "Em aberto";
const REGISTRATION_MIND_MAP_OBJECTIVE_ADAPTER = {
  scope: "registration-objectives", levels: MIND_MAP_CATEGORY_LEVELS, rootLabel: "Objetivos", countLabel: "objetivo(s)", addTitle: "Adicionar objetivo",
  title: (item) => item.name || "Objetivo",
  groupId: (item) => item.id,
  parent: () => null,
  dependencies: (item) => normalizeIdList(item.dependency_objective_template_ids),
  extraDependencyNames: (item) => normalizeIdList(item.dependency_activity_template_ids).map((id) => loadProductActivities().find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName),
  subtitle: (node) => registrationProductName(node.item.product_id),
  searchText: (item) => [registrationProductName(item.product_id), item.channel, item.completion_criteria, item.comments, item.notes].join(" "),
  editClass: "reg-template-edit",
  editAttrs: (item) => `data-id="${esc(item.id)}" data-product="${esc(item.product_id)}"`
};
const REGISTRATION_MIND_MAP_GOAL_ADAPTER = {
  ...REGISTRATION_MIND_MAP_OBJECTIVE_ADAPTER,
  scope: "registration-goals", rootLabel: "Metas", countLabel: "meta(s)", addTitle: "Adicionar meta",
  title: (item) => item.name || "Meta",
  dependencies: (item) => normalizeIdList(item.dependency_goal_template_ids),
  subtitle: (node) => `${registrationProductName(node.item.product_id)} · ${node.item.metric || "Sem indicador"}`,
  searchText: (item) => [registrationProductName(item.product_id), item.metric, item.unit, item.comments, item.notes].join(" ")
};
const DELIVERY_MIND_MAP_OBJECTIVE_ADAPTER = {
  scope: "delivery-objectives", levels: MIND_MAP_CATEGORY_LEVELS, rootLabel: "Objetivos",
  title: (item) => item.name || "Objetivo",
  groupId: (item) => item.id,
  parent: () => null,
  dependencies: (item) => normalizeIdList(item.dependency_objective_ids),
  extraDependencyNames: (item) => normalizeIdList(item.dependency_activity_ids).map((id) => operationalProjectTasks(item.project_id).find((task) => task.id === id)).filter(Boolean).map(activityDisplayName),
  subtitle: (node) => node.item.due_date ? `${mindMapStatusLabel(node.item)} · ${dt(node.item.due_date)}` : mindMapStatusLabel(node.item),
  searchText: (item) => [item.completion_criteria, item.comments, item.notes].join(" "),
  editClass: "",
  editAttrs: () => ""
};
const DELIVERY_MIND_MAP_GOAL_ADAPTER = {
  ...DELIVERY_MIND_MAP_OBJECTIVE_ADAPTER,
  scope: "delivery-goals", rootLabel: "Metas",
  title: (item) => item.name || "Meta",
  dependencies: (item) => normalizeIdList(item.dependency_goal_ids),
  extraDependencyNames: (item) => normalizeIdList(item.dependency_activity_ids).map((id) => operationalProjectTasks(item.project_id).find((task) => task.id === id)).filter(Boolean).map(activityDisplayName),
  subtitle: (node) => `${Number(node.item.current_value || 0).toLocaleString("pt-BR")} / ${Number(node.item.target_value || 0).toLocaleString("pt-BR")} ${node.item.unit || ""}`.trim() + ` · ${mindMapStatusLabel(node.item)}`,
  searchText: (item) => [item.metric, item.unit, item.comments, item.notes].join(" ")
};

function registrationTaskHierarchy(items, adapter = REGISTRATION_MIND_MAP_TEMPLATE_ADAPTER) {
  const groups = new Map();
  items.forEach((item) => {
    const id = adapter.groupId(item);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  });
  const nodes = [...groups.entries()].map(([id, linked]) => {
    const item = linked[0];
    const parent = linked.map((candidate) => adapter.parent(candidate, items)).find(Boolean);
    return { id, linked, item, parentId: parent ? adapter.groupId(parent) : null, dependencies: new Set() };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groupIdByTemplateId = new Map();
  nodes.forEach((node) => node.linked.forEach((item) => groupIdByTemplateId.set(item.id, node.id)));
  nodes.forEach((node) => node.linked.forEach((item) =>
    adapter.dependencies(item).forEach((id) => {
      const dependencyGroupId = groupIdByTemplateId.get(id);
      if (dependencyGroupId && dependencyGroupId !== node.id) node.dependencies.add(dependencyGroupId);
    })));
  const children = new Map();
  nodes.forEach((node) => {
    if (!node.parentId || !nodeById.has(node.parentId)) return;
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  });
  const roots = nodes.filter((node) => !node.parentId || !nodeById.has(node.parentId));
  const compare = (a, b) => Number(a.item.sort_order || 0) - Number(b.item.sort_order || 0)
    || mindMapTitle(adapter, a.item).localeCompare(mindMapTitle(adapter, b.item), "pt-BR", { sensitivity: "base" });
  const remaining = new Map(roots.map((node) => [node.id, node]));
  const ordered = [];
  while (remaining.size) {
    let ready = [...remaining.values()].filter((node) => [...node.dependencies].every((id) => !remaining.has(id))).sort(compare);
    if (!ready.length) ready = [[...remaining.values()].sort(compare)[0]];
    ready.forEach((node) => { ordered.push(node); remaining.delete(node.id); });
  }
  children.forEach((entries) => entries.sort(compare));
  return { ordered, children, nodeById };
}

function registrationMindMapTaskHtml(node, hierarchy, orderById, adapter) {
  const dependencyNames = [
    ...[...node.dependencies].map((id) => hierarchy.nodeById.get(id)?.item).filter(Boolean).map((item) => mindMapTitle(adapter, item)),
    ...(adapter.extraDependencyNames?.(node.item) || [])
  ];
  const subtasks = hierarchy.children.get(node.id) || [];
  const order = orderById.get(node.id) || 0;
  const depsAttr = (entry) => esc([...entry.dependencies].join(","));
  return `<article class="registration-mind-task${node.item.status === "done" ? " is-done" : ""}" data-node-id="${esc(node.id)}" data-deps="${depsAttr(node)}">
    <button class="registration-mind-task-main ${adapter.editClass || "is-static"}" type="button" ${adapter.editAttrs(node.item)}${adapter.editClass ? "" : ' tabindex="-1"'}>
      <span class="registration-mind-order">${String(order).padStart(2, "0")}</span>
      <span class="registration-mind-task-copy"><strong>${esc(mindMapTitle(adapter, node.item))}</strong><small>${esc(adapter.subtitle(node))}</small></span>
    </button>
    ${dependencyNames.length ? `<div class="registration-mind-dependency"><span>Após</span>${dependencyNames.map((name) => `<b>${esc(name)}</b>`).join("")}</div>` : ""}
    ${subtasks.length ? `<div class="registration-mind-subtasks">${subtasks.map((subtask, index) => `<button class="${adapter.editClass}" type="button" ${adapter.editAttrs(subtask.item)} data-node-id="${esc(subtask.id)}" data-deps="${depsAttr(subtask)}"><span>${order}.${index + 1}</span><strong>${esc(mindMapTitle(adapter, subtask.item))}</strong></button>`).join("")}</div>` : ""}
  </article>`;
}

function registrationMindMapBuckets(nodes, orderById, level, levels = REGISTRATION_MIND_MAP_LEVELS) {
  const { key, empty } = levels[level];
  const buckets = new Map();
  nodes.forEach((node) => {
    const label = String(node.item[key] || "").trim();
    const bucketKey = label.toLocaleLowerCase("pt-BR");
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { key: bucketKey, label: label || empty, empty: !label, nodes: [], firstOrder: Infinity });
    const bucket = buckets.get(bucketKey);
    bucket.nodes.push(node);
    bucket.firstOrder = Math.min(bucket.firstOrder, orderById.get(node.id) || 0);
  });
  return [...buckets.values()].sort((a, b) => a.firstOrder - b.firstOrder);
}

function registrationMindMapBranchHtml(bucket, parentKey, level, hierarchy, orderById, adapter) {
  const branchKey = `${parentKey}::${bucket.key}`;
  const collapsed = !bucket.empty && registrationMindMapCollapsedBranches.has(branchKey);
  const levels = adapter.levels || REGISTRATION_MIND_MAP_LEVELS;
  const leaf = level === levels.length - 1;
  const content = leaf
    ? `<div class="registration-mind-tasks">${bucket.nodes.map((node) => registrationMindMapTaskHtml(node, hierarchy, orderById, adapter)).join("")}</div>`
    : registrationMindMapBuckets(bucket.nodes, orderById, level + 1, levels).map((child) => registrationMindMapBranchHtml(child, branchKey, level + 1, hierarchy, orderById, adapter)).join("");
  const head = bucket.empty
    ? '<span class="registration-mind-pass" aria-hidden="true"></span>'
    : `<button class="registration-mind-toggle" type="button" data-branch-key="${esc(branchKey)}"><span>${collapsed ? "▸" : "▾"}</span><strong>${esc(bucket.label)}</strong><small>${bucket.nodes.length}</small></button>`;
  return `<section class="registration-mind-branch level-${level}${bucket.empty ? " is-pass" : ""}${collapsed ? " is-collapsed" : ""}">
    ${head}
    <div class="registration-mind-children${leaf ? " is-leaf" : ""}"${collapsed ? " hidden" : ""}>${content}</div>
  </section>`;
}

const mindMapPendingScroll = new Map();
function mindMapExpandAllButtonHtml(allExpanded) {
  const label = allExpanded ? "Recolher todo o mapa" : "Expandir todo o mapa";
  return `<button class="view registration-mind-expand-all" type="button" title="${label}" aria-label="${label}" data-expanded="${allExpanded}">${allExpanded ? "⊟" : "⊞"}</button>`;
}

function updateMindMapExpandAllButton(root) {
  const button = root.querySelector(".registration-mind-expand-all");
  if (!button) return;
  const allExpanded = !root.querySelector(".registration-mind-branch.is-collapsed");
  const label = allExpanded ? "Recolher todo o mapa" : "Expandir todo o mapa";
  button.textContent = allExpanded ? "⊟" : "⊞";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.expanded = String(allExpanded);
}

function centerMindMap(shell) {
  const scroller = shell?.querySelector(".registration-mindmap-scroll");
  const rootNode = shell?.querySelector(".registration-mindmap-root");
  if (!scroller || !rootNode) return;
  const frame = scroller.getBoundingClientRect();
  const node = rootNode.getBoundingClientRect();
  if (shell.classList.contains("is-vertical")) {
    scroller.scrollTop = 0;
    scroller.scrollLeft += (node.left + node.width / 2) - (frame.left + scroller.clientWidth / 2);
  } else {
    scroller.scrollLeft = 0;
    scroller.scrollTop += (node.top + node.height / 2) - (frame.top + scroller.clientHeight / 2);
  }
}

function setMindMapBranchCollapsed(button, collapsed) {
  const branch = button.closest(".registration-mind-branch");
  const children = branch?.querySelector(":scope > .registration-mind-children");
  if (!children) return;
  children.hidden = collapsed;
  branch.classList.toggle("is-collapsed", collapsed);
  button.querySelector("span").textContent = collapsed ? "▸" : "▾";
  if (collapsed) registrationMindMapCollapsedBranches.add(button.dataset.branchKey);
  else registrationMindMapCollapsedBranches.delete(button.dataset.branchKey);
}

function registrationMindMapShellHtml(items, adapter, search = "", scopeKey = adapter.scope) {
  const hierarchy = registrationTaskHierarchy(items, adapter);
  const orderById = new Map(hierarchy.ordered.map((node, index) => [node.id, index + 1]));
  const query = String(search || "").trim().toLocaleLowerCase("pt-BR");
  const nodes = hierarchy.ordered.filter((node) => {
    if (!query) return true;
    const children = hierarchy.children.get(node.id) || [];
    const text = [...node.linked, ...children.flatMap((child) => child.linked)].flatMap((item) => [
      mindMapTitle(adapter, item), item.category, item.group, item.subgroup, item.sector, item.subsector, item.module, item.submodule, item.channel, item.type, item.information, adapter.searchText(item)
    ]).join(" ").toLocaleLowerCase("pt-BR");
    return text.includes(query);
  });
  const branches = registrationMindMapBuckets(nodes, orderById, 0, adapter.levels || REGISTRATION_MIND_MAP_LEVELS).map((bucket) => registrationMindMapBranchHtml(bucket, scopeKey, 0, hierarchy, orderById, adapter)).join("");
  const map = branches || `<div class="empty">${query ? "Nenhum item corresponde à busca." : "Nenhum item para exibir."}</div>`;
  const vertical = registrationMindMapOrientation === "vertical";
  const fullscreen = registrationMindMapFullscreen;
  const previousScroll = document.querySelector(`.registration-mindmap-shell[data-scope="${CSS.escape(scopeKey)}"] .registration-mindmap-scroll`);
  mindMapPendingScroll.set(scopeKey, previousScroll ? {
    left: previousScroll.scrollLeft,
    top: previousScroll.scrollTop,
    vertical: previousScroll.closest(".registration-mindmap-shell").classList.contains("is-vertical")
  } : null);
  const anyCollapsed = branches.includes(" is-collapsed\"");
  const fullscreenLabel = fullscreen ? "Sair da tela cheia (Esc)" : "Tela cheia";
  return { count: nodes.length, html: `<div class="registration-mindmap-shell${vertical ? " is-vertical" : ""}${fullscreen ? " is-fullscreen" : ""}${registrationMindMapHandMode ? " is-hand" : ""}" data-scope="${esc(scopeKey)}">
    <div class="registration-mind-controls" role="group" aria-label="Controles do mapa">${mindMapExpandAllButtonHtml(!anyCollapsed)}<button class="view${vertical ? "" : " active"}" type="button" data-orientation="horizontal" title="Mapa na horizontal" aria-label="Mapa na horizontal">⇆</button><button class="view${vertical ? " active" : ""}" type="button" data-orientation="vertical" title="Mapa na vertical" aria-label="Mapa na vertical">⇅</button><button class="view registration-mind-hand${registrationMindMapHandMode ? " active" : ""}" type="button" title="Mãozinha: arraste para navegar" aria-label="Mãozinha: arraste para navegar" aria-pressed="${registrationMindMapHandMode}">✋</button><button class="view registration-mind-zoom" type="button" title="Zoom: Ctrl ou botão do mouse pressionado + rolar a bolinha. Clique para voltar a 100%" aria-label="Zoom ${Math.round(registrationMindMapZoom * 100)}%, clique para voltar a 100%">${Math.round(registrationMindMapZoom * 100)}%</button><button class="view registration-mind-fullscreen" type="button" title="${fullscreenLabel}" aria-label="${fullscreenLabel}">${fullscreen ? "✕" : "⛶"}</button></div>
    <div class="registration-mindmap-scroll"><div class="registration-mindmap-canvas" style="zoom:${registrationMindMapZoom}"><svg class="registration-mind-links" aria-hidden="true"></svg>
    <div class="registration-mindmap-root"><strong>${esc(adapter.rootLabel || "Tarefas")}</strong><span>${nodes.length}</span></div><div class="registration-mindmap-branches">${map}</div>
  </div></div></div>` };
}

// Aplica no mapa mental os mesmos filtros de coluna da tabela (lidos da tabela recém-montada).
function registrationMindMapFilteredItems(root, items, kind, adapter = REGISTRATION_MIND_MAP_TEMPLATE_ADAPTER) {
  const state = registrationTableState();
  const table = root.querySelector("table");
  const active = Object.entries(state.filters || {}).filter(([, values]) => values?.size);
  const labels = new Map();
  [...(table?.querySelectorAll("thead th") || [])].forEach((header, index) => {
    if (header.textContent.trim().toLocaleUpperCase("pt-BR") !== "AÇÕES") labels.set(`c${index}`, { index, label: header.textContent.trim() });
  });
  const filters = active.map(([key, values]) => ({ key, values, label: labels.get(key)?.label || "Coluna" }));
  if (!table || !active.length) return [items, adapter, filters];
  const rows = [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty") && !row.classList.contains("registration-subtask-row"));
  const passing = rows.filter((row) => active.every(([key, selected]) => {
    const index = labels.get(key)?.index;
    return selected.has((index == null ? null : row.children[index])?.textContent.trim() || "—");
  }));
  if (kind === "activities") {
    const groups = new Set(passing.map((row) => row.dataset.taskGroup).filter(Boolean));
    return [items.filter((item) => {
      if (groups.has(item.template_group_id || item.id)) return true;
      const parent = productTemplateParent(item, items);
      return Boolean(parent && groups.has(parent.template_group_id || parent.id));
    }), adapter, filters];
  }
  const ids = new Set(passing.map((row) => row.querySelector("[data-id]")?.dataset.id).filter(Boolean));
  return [items.filter((item) => ids.has(item.id)), adapter, filters];
}

function mindMapFilterStripHtml(filters, badgeClass = "mind-filter-badge", clearClass = "mind-filter-clear-all") {
  if (!filters?.length) return "";
  return `<div class="registration-filter-strip"><div class="registration-filter-badges">${filters.map((filter) =>
    `<button class="registration-filter-badge ${badgeClass}" data-key="${esc(filter.key)}" title="Limpar filtro"><span>${esc(filter.label)}: ${esc([...filter.values].join(", "))}</span><b>×</b></button>`).join("")}</div><button class="filter-clear-all ${clearClass}" type="button"${filters.length < 2 ? " hidden" : ""}><span aria-hidden="true">×</span> Limpar tudo</button></div>`;
}

function registrationTaskMindMapHtml(items, adapter = REGISTRATION_MIND_MAP_TEMPLATE_ADAPTER, filters = []) {
  const state = registrationTableState();
  const map = registrationMindMapShellHtml(items, adapter, state.search);
  return `<div class="modal-toolbar registration-toolbar">
    <div class="registration-toolbar-left"><span class="registration-toolbar-title">Cadastros</span><span class="muted">${map.count} ${adapter.countLabel || "tarefa(s)"} no mapa</span></div>
    <div class="registration-toolbar-center"><input class="search registration-toolbar-search registration-mind-search" placeholder="Buscar..." value="${esc(state.search || "")}"><button class="btn primary plus" id="registration-add" title="${esc(adapter.addTitle || "Adicionar tarefa")}">+</button></div>
    <div class="registration-toolbar-right"><button class="btn table-group-btn" type="button" title="Agrupar (indisponível nesta tabela)" disabled>≡</button><button class="btn registration-cols-btn" type="button" title="Selecionar colunas" disabled>⊞</button><button class="btn view-menu-trigger active" id="registration-view-menu-btn" type="button" title="Modo de visualização: Mapa mental">${viewTriggerInner("mindmap")}</button><button class="view" type="button" disabled title="Matriz" aria-label="Matriz">${viewButtonInner("matrix")}</button>${registrationDashboardButtonHtml()}<button class="btn registration-data-btn" type="button" title="Dados (disponível na visualização Tabela)" disabled>⬆⬇</button></div>
  </div>${mindMapFilterStripHtml(filters)}${map.html}`;
}

let registrationMindMapGlobalWired = false;
function drawRegistrationMindMapLinks(root) {
  const canvas = root?.querySelector(".registration-mindmap-canvas");
  const svg = canvas?.querySelector(":scope > .registration-mind-links");
  if (!canvas || !svg) return;
  const base = canvas.getBoundingClientRect();
  const scale = Number(canvas.style.zoom) || 1;
  const visible = new Map();
  canvas.querySelectorAll("[data-node-id]").forEach((element) => {
    if (element.offsetParent !== null) visible.set(element.dataset.nodeId, element);
  });
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: (rect.left - base.left) / scale, right: (rect.right - base.left) / scale, y: (rect.top - base.top + rect.height / 2) / scale };
  };
  const paths = [];
  visible.forEach((target, targetId) => {
    String(target.dataset.deps || "").split(",").filter(Boolean).forEach((sourceId) => {
      const source = visible.get(sourceId);
      if (!source || source === target) return;
      const from = box(source);
      const to = box(target);
      let d;
      if (Math.abs(from.left - to.left) < 24) {
        const edge = Math.max(from.right, to.right);
        const bulge = 26 + Math.min(70, Math.abs(to.y - from.y) * 0.12);
        d = `M${from.right},${from.y} C${edge + bulge},${from.y} ${edge + bulge},${to.y} ${to.right + 6},${to.y}`;
      } else if (to.left > from.left) {
        const mid = (from.right + to.left) / 2;
        d = `M${from.right},${from.y} C${mid},${from.y} ${mid},${to.y} ${to.left - 6},${to.y}`;
      } else {
        const mid = (from.left + to.right) / 2;
        d = `M${from.left},${from.y} C${mid},${from.y} ${mid},${to.y} ${to.right + 6},${to.y}`;
      }
      paths.push(`<path d="${d}" data-from="${esc(sourceId)}" data-to="${esc(targetId)}" marker-end="url(#registration-mind-arrow)"></path>`);
    });
  });
  svg.setAttribute("width", canvas.scrollWidth);
  svg.setAttribute("height", canvas.scrollHeight);
  svg.innerHTML = `<defs><marker id="registration-mind-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>${paths.join("")}`;
}

function redrawAllMindMapLinks() {
  document.querySelectorAll(".registration-mindmap-shell").forEach((shell) => drawRegistrationMindMapLinks(shell));
}

function setMindMapFullscreen(on, touchBrowser = true) {
  registrationMindMapFullscreen = on;
  const label = on ? "Sair da tela cheia (Esc)" : "Tela cheia";
  document.querySelectorAll(".registration-mindmap-shell").forEach((shell) => {
    shell.classList.toggle("is-fullscreen", on);
    const button = shell.querySelector(".registration-mind-fullscreen");
    if (!button) return;
    button.textContent = on ? "✕" : "⛶";
    button.title = label;
    button.setAttribute("aria-label", label);
  });
  if (touchBrowser) {
    try {
      if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.()?.catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
    } catch {}
  }
  requestAnimationFrame(redrawAllMindMapLinks);
}

function wireMindMapPan(scroller) {
  if (!scroller) return;
  let drag = null;
  let suppressClick = false;
  const setZoom = (next, clientX, clientY) => {
    const canvas = scroller.querySelector(".registration-mindmap-canvas");
    if (!canvas) return;
    const [min, max] = REGISTRATION_MIND_MAP_ZOOM_LIMITS;
    const zoom = Math.min(max, Math.max(min, Math.round(next * 100) / 100));
    const previous = Number(canvas.style.zoom) || 1;
    if (zoom === previous) return;
    const rect = scroller.getBoundingClientRect();
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const contentX = (scroller.scrollLeft + x) / previous;
    const contentY = (scroller.scrollTop + y) / previous;
    registrationMindMapZoom = zoom;
    canvas.style.zoom = zoom;
    scroller.scrollLeft = contentX * zoom - x;
    scroller.scrollTop = contentY * zoom - y;
    const label = scroller.closest(".registration-mindmap-shell")?.querySelector(".registration-mind-zoom");
    if (label) {
      label.textContent = `${Math.round(zoom * 100)}%`;
      label.setAttribute("aria-label", `Zoom ${Math.round(zoom * 100)}%, clique para voltar a 100%`);
    }
    if (drag) Object.assign(drag, { x: drag.lastX ?? drag.x, y: drag.lastY ?? drag.y, left: scroller.scrollLeft, top: scroller.scrollTop });
    drawRegistrationMindMapLinks(scroller.closest(".registration-mindmap-shell"));
  };
  scroller.addEventListener("pointerdown", (event) => { if (event.button === 0 && event.pointerType !== "touch") registrationMindMapPointerPressed = true; }, true);
  if (!registrationMindMapPointerWired) {
    registrationMindMapPointerWired = true;
    const release = () => { registrationMindMapPointerPressed = false; };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  }
  scroller.addEventListener("wheel", (event) => {
    const holding = registrationMindMapPointerPressed || Boolean(event.buttons & 1);
    if (!(event.ctrlKey || event.metaKey || holding)) return;
    event.preventDefault();
    if (holding) suppressClick = true;
    setZoom(registrationMindMapZoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
  }, { passive: false });
  scroller.closest(".registration-mindmap-shell")?.querySelector(".registration-mind-zoom")?.addEventListener("click", () => setZoom(1));
  let pinch = null;
  const touchDistance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  scroller.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2) return;
    pinch = { distance: touchDistance(event.touches) || 1, zoom: registrationMindMapZoom };
    event.preventDefault();
  }, { passive: false });
  scroller.addEventListener("touchmove", (event) => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const [a, b] = event.touches;
    setZoom(pinch.zoom * (touchDistance(event.touches) / pinch.distance), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  }, { passive: false });
  const endPinch = (event) => {
    if (!pinch || event.touches.length >= 2) return;
    pinch = null;
    suppressClick = true;
  };
  scroller.addEventListener("touchend", endPinch);
  scroller.addEventListener("touchcancel", endPinch);
  scroller.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    if (event.button !== 0 || event.pointerType === "touch") return;
    if (event.target.closest(".registration-mind-controls")) return;
    if (!registrationMindMapHandMode && event.target.closest("button, a, input, select, textarea, .registration-mind-task")) return;
    drag = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, id: event.pointerId, moved: false };
  });
  scroller.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      scroller.setPointerCapture?.(drag.id);
      scroller.classList.add("is-panning");
    }
    scroller.scrollLeft = drag.left - dx;
    scroller.scrollTop = drag.top - dy;
    event.preventDefault();
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = suppressClick || drag.moved;
    if (drag.moved) scroller.releasePointerCapture?.(drag.id);
    scroller.classList.remove("is-panning");
    drag = null;
  };
  scroller.addEventListener("pointerup", end);
  scroller.addEventListener("pointercancel", end);
  scroller.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function wireMindMap(root, rerender) {
  root.querySelectorAll(".registration-mind-controls [data-orientation]").forEach((button) => button.addEventListener("click", () => {
    if (registrationMindMapOrientation === button.dataset.orientation) return;
    registrationMindMapOrientation = button.dataset.orientation;
    try { localStorage.setItem("registrationMindMapOrientation", registrationMindMapOrientation); } catch {}
    rerender();
  }));
  root.querySelector(".registration-mind-fullscreen")?.addEventListener("click", () => setMindMapFullscreen(!registrationMindMapFullscreen));
  root.querySelector(".registration-mind-hand")?.addEventListener("click", (event) => {
    registrationMindMapHandMode = !registrationMindMapHandMode;
    const button = event.currentTarget;
    button.classList.toggle("active", registrationMindMapHandMode);
    button.setAttribute("aria-pressed", String(registrationMindMapHandMode));
    root.querySelector(".registration-mindmap-shell")?.classList.toggle("is-hand", registrationMindMapHandMode);
  });
  wireMindMapPan(root.querySelector(".registration-mindmap-scroll"));
  root.querySelectorAll(".registration-mind-toggle").forEach((button) => button.addEventListener("click", () => {
    const children = button.closest(".registration-mind-branch")?.querySelector(":scope > .registration-mind-children");
    if (!children) return;
    setMindMapBranchCollapsed(button, !children.hidden);
    updateMindMapExpandAllButton(root);
    drawRegistrationMindMapLinks(root);
  }));
  root.querySelector(".registration-mind-expand-all")?.addEventListener("click", (event) => {
    const collapse = event.currentTarget.dataset.expanded === "true";
    root.querySelectorAll(".registration-mind-toggle").forEach((button) => setMindMapBranchCollapsed(button, collapse));
    updateMindMapExpandAllButton(root);
    drawRegistrationMindMapLinks(root);
    centerMindMap(root.querySelector(".registration-mindmap-shell"));
  });
  const canvas = root.querySelector(".registration-mindmap-canvas");
  canvas?.addEventListener("mouseover", (event) => {
    const id = event.target.closest("[data-node-id]")?.dataset.nodeId;
    canvas.querySelectorAll(".registration-mind-links path[data-from]").forEach((path) =>
      path.classList.toggle("is-active", Boolean(id) && (path.dataset.from === id || path.dataset.to === id)));
  });
  canvas?.addEventListener("mouseleave", () => canvas.querySelectorAll(".registration-mind-links path.is-active").forEach((path) => path.classList.remove("is-active")));
  const shell = root.querySelector(".registration-mindmap-shell");
  const savedScroll = shell ? mindMapPendingScroll.get(shell.dataset.scope) : null;
  if (shell) mindMapPendingScroll.delete(shell.dataset.scope);
  requestAnimationFrame(() => {
    drawRegistrationMindMapLinks(root);
    const scroller = shell?.querySelector(".registration-mindmap-scroll");
    if (!scroller) return;
    if (savedScroll && savedScroll.vertical === shell.classList.contains("is-vertical")) {
      scroller.scrollLeft = savedScroll.left;
      scroller.scrollTop = savedScroll.top;
    } else centerMindMap(shell);
  });
  if (registrationMindMapGlobalWired) return;
  registrationMindMapGlobalWired = true;
  window.addEventListener("resize", redrawAllMindMapLinks);
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && registrationMindMapFullscreen) setMindMapFullscreen(false, false);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !registrationMindMapFullscreen) return;
    if (document.querySelector("#ov .activity-form-overlay")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setMindMapFullscreen(false);
  }, true);
}

function wireRegistrationMindMap(root) {
  const state = registrationTableState();
  root.querySelectorAll(".mind-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete state.filters[badge.dataset.key];
    renderRegistrationsSection();
  }));
  root.querySelector(".mind-filter-clear-all")?.addEventListener("click", () => {
    state.filters = {};
    renderRegistrationsSection();
  });
  root.querySelector(".registration-mind-search")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderRegistrationsSection();
    const input = document.querySelector("#registrations-root .registration-mind-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  root.querySelector("#registration-view-menu-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openRegistrationViewMenu();
  });
  wireMindMap(root, renderRegistrationsSection);
}

function openRegistrationViewMenu() {
  closeFloaters();
  const button = document.getElementById("registration-view-menu-btn");
  if (!button) return;
  const state = registrationTableState();
  const rect = button.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "registration-view-dd";
  panel.className = "view-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 198))}px`;
  panel.style.top = `${rect.bottom + 5}px`;
  const modes = [
    { id: "table", label: "Tabela", icon: "▦" },
    { id: "mindmap", label: "Mapa mental", icon: "⌘" }
  ];
  panel.innerHTML = modes.map((mode) => `<button class="view-option${state.view === mode.id ? " active" : ""}" data-view="${mode.id}">
    <span class="view-option-icon">${mode.icon}</span><span>${mode.label}</span><span>${state.view === mode.id ? "✓" : ""}</span>
  </button>`).join("");
  document.body.appendChild(panel);
  panel.querySelectorAll(".view-option").forEach((option) => option.addEventListener("click", () => {
    state.view = option.dataset.view;
    panel.remove();
    renderRegistrationsSection();
  }));
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !button.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function renderRegistrationsSection() {
  const root = document.getElementById("registrations-root");
  if (!root) return;
  const section = registrationsState.section;
  const permissionModule = REGISTRATION_PERMISSION_MODULE[section];
  if (!currentUserCan(permissionModule, "view")) {
    root.innerHTML = '<div class="empty">Você não possui acesso a este cadastro.</div>';
    return;
  }
  queueMicrotask(() => {
    const currentRoot = document.getElementById("registrations-root");
    if (!currentRoot) return;
    const addButton = currentRoot.querySelector("#registration-add");
    if (addButton && !currentUserCan(permissionModule, "create")) addButton.disabled = true;
    if (!currentUserCan(permissionModule, "edit")) currentRoot.querySelectorAll(".reg-product-edit,.reg-pipeline-edit,.reg-template-edit,.reg-user-edit").forEach((button) => { button.disabled = true; });
    if (!currentUserCan(permissionModule, "clone")) currentRoot.querySelectorAll(".reg-template-clone").forEach((button) => { button.disabled = true; });
  });
  if (section === "products") {
    const rows = cache.products.map((product) => `<tr>
      <td><div class="registrations-product"><strong>${esc(product.name || "—")}</strong><small>${esc(product.description || "Sem descrição")}</small></div></td>
      <td>${esc(product.category || "—")}</td><td>${esc(product.status || "—")}</td>
      <td>${Number(product.price || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td>
      <td>${product.duration_days ? `${esc(product.duration_days)} dia(s)` : "—"}</td>
      <td class="act table-actions-cell">${tableActionButtons({
        open: { className: "reg-product-setup", attrs: { "data-id": product.id }, title: "Abrir estrutura do produto" },
        edit: { className: "edit reg-product-edit", attrs: { "data-id": product.id }, title: "Editar produto" }
      })}</td>
    </tr>`).join("");
    root.innerHTML = `<div class="modal-toolbar"><span class="muted">${cache.products.length} produto(s)</span><button class="btn primary" id="registration-add">+ Produto</button></div>
      <div class="product-activity-list"><table><thead><tr><th>Produto</th><th>Categoria</th><th>Status</th><th>Valor</th><th>Duração</th>${tableActionsHead()}</tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Nenhum produto cadastrado.</td></tr>'}</tbody></table></div>`;
    document.getElementById("registration-add")?.addEventListener("click", () => openForm("products", null, { returnToRegistrations: "products" }));
    root.querySelectorAll(".reg-product-setup").forEach((button) => button.addEventListener("click", () => openProductActivities(button.dataset.id, { returnToRegistrations: "products" })));
    root.querySelectorAll(".reg-product-edit").forEach((button) => button.addEventListener("click", () => openForm("products", button.dataset.id, { returnToRegistrations: "products" })));
    wireRegistrationTable();
    return;
  }
  if (section === "pipelines") {
    const pipelines = cache.pipelines || [];
    const rows = pipelines.map((pipeline) => {
      const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
      return `<tr><td><strong>${esc(pipeline.name || "—")}</strong></td><td>${stages.length}</td><td>${esc(stages.join(" → ") || "—")}</td><td class="act table-actions-cell">${tableActionButtons({ edit: { className: "reg-pipeline-edit", attrs: { "data-id": pipeline.id }, title: "Editar pipeline" } })}</td></tr>`;
    }).join("");
    root.innerHTML = `<div class="modal-toolbar"><span class="muted">${pipelines.length}/${MAX_PIPELINES} pipeline(s)</span><button class="btn primary" id="registration-add"${pipelines.length >= MAX_PIPELINES ? " disabled" : ""}>+ Pipeline</button></div>
      <div class="product-activity-list"><table><thead><tr><th>Pipeline</th><th>Etapas</th><th>Fluxo</th>${tableActionsHead()}</tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Nenhum pipeline cadastrado.</td></tr>'}</tbody></table></div>`;
    document.getElementById("registration-add")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPipelinesModal("new", true);
    });
    root.querySelectorAll(".reg-pipeline-edit").forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPipelinesModal(button.dataset.id, true);
    }));
    wireRegistrationTable();
    return;
  }
  if (section === "users") {
    const users = cache.users || [];
    const rows = users.map((user) => `<tr><td><strong>${esc(user.full_name || user.name || "—")}</strong></td><td>${esc(user.nickname || "—")}</td><td>${esc(user.email || "—")}</td><td>${esc(user.phone || "—")}</td><td>${esc(ROLE_LABEL[user.role] || user.role || "—")}</td><td>${esc(user.function_name || "—")}</td><td>${esc(user.job_title || "—")}</td><td>${user.status === "active" ? "Ativo" : "Inativo"}</td><td>${user.auth_user_id ? "Login ativo" : "Sem login"}</td><td class="act table-actions-cell">${tableActionButtons({ edit: { className: "edit reg-user-edit", attrs: { "data-id": user.id }, title: "Editar usuário" } })}</td></tr>`).join("");
    root.innerHTML = `<div class="modal-toolbar"><span class="muted">${users.length} usuário(s)</span><button class="btn primary" id="registration-add">+ Usuário</button></div>
      <div class="product-activity-list"><table><thead><tr><th>Usuário</th><th>Apelido</th><th>E-mail</th><th>Telefone</th><th>Perfil</th><th>Função</th><th>Cargo</th><th>Status</th><th>Acesso</th>${tableActionsHead()}</tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">Nenhum usuário cadastrado.</td></tr>'}</tbody></table></div>`;
    document.getElementById("registration-add")?.addEventListener("click", () => openUsersModal("new", true));
    root.querySelectorAll(".reg-user-edit").forEach((button) => button.addEventListener("click", () => openUsersModal(button.dataset.id, true)));
    wireRegistrationTable();
    return;
  }
  if (section === "activities") {
    const items = loadProductActivities();
    const tableState = registrationTableState();
    {
    const groups = new Map();
    items.forEach((item) => {
      const key = item.template_group_id || item.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    const grouped = [...groups.entries()].map(([id, linked]) => {
      const item = linked[0];
      const parent = linked.map((candidate) => productTemplateParent(candidate, items)).find(Boolean);
      return { id, linked, item, parentGroupId: parent ? (parent.template_group_id || parent.id) : null };
    });
    const groupedById = new Map(grouped.map((group) => [group.id, group]));
    const childrenByParent = new Map();
    grouped.forEach((group) => {
      if (!group.parentGroupId || !groupedById.has(group.parentGroupId)) return;
      if (!childrenByParent.has(group.parentGroupId)) childrenByParent.set(group.parentGroupId, []);
      childrenByParent.get(group.parentGroupId).push(group);
    });
    const roots = grouped.filter((group) => !group.parentGroupId || !groupedById.has(group.parentGroupId));
    const summary = (group) => {
      const { linked, item } = group;
      const products = [...new Set(linked.map((candidate) => registrationProductName(candidate.product_id)))].join(", ");
      const ownerIds = [...new Set(linked.flatMap((candidate) => normalizeIdList(candidate.default_assignee_ids, candidate.default_owner_id)))];
      const ownerJobTitles = normalizeTextList(linked.flatMap((candidate) => normalizeTextList(candidate.default_assignee_job_titles)));
      const owners = responsibilityNameList(ownerIds, null, ownerJobTitles, linked.some((candidate) => candidate.assign_to_client));
      const objectives = [...new Set(linked.map((candidate) => loadProductObjectives().find((objective) => objective.id === candidate.objective_template_id)?.name).filter(Boolean))].join(", ") || "—";
      const dependencies = [...new Set(linked.flatMap((candidate) => normalizeIdList(candidate.dependency_template_ids, candidate.depends_on_template_id)).map((id) => activityDisplayName(items.find((other) => other.id === id))).filter((name) => name !== "—"))];
      return { products, owners, objectives, dependencies };
    };
    const rows = roots.map((group) => {
      const { item } = group;
      const details = summary(group);
      const children = (childrenByParent.get(group.id) || []).sort((a, b) => Number(a.item.sort_order || 0) - Number(b.item.sort_order || 0));
      const expanded = registrationExpandedTaskGroups.has(group.id);
      const childNames = children.map((child) => activityDisplayName(child.item)).join(" ");
      const childRows = children.map((child) => {
        const childDetails = summary(child);
        const checklist = normalizeChecklist(child.item.checklist);
        return `<tr class="registration-subtask-row" data-parent-group="${esc(group.id)}" data-expand-parent="${esc(group.id)}" data-id="${esc(child.item.id)}"${expanded ? "" : " hidden"}>
          <td>—</td>
          <td>${esc(childDetails.products)}</td>
          <td>Cadastro</td>
          <td><span class="registration-subtask-name"><b>↳</b><strong>${esc(activityDisplayName(child.item))}</strong></span></td>
          <td>${priorityBadge(child.item.priority)}</td>
          <td class="compact-multi-cell">${stackedCell(childDetails.dependencies)}</td>
          <td>${esc(child.item.information || "—")}</td>
          <td>${esc(child.item.group || "—")}</td>
          <td>${esc(child.item.subgroup || "—")}</td>
          <td>${esc(child.item.sector || "—")}</td>
          <td>${esc(child.item.subsector || "—")}</td>
          <td>${esc(child.item.module || "—")}</td>
          <td>${esc(child.item.submodule || "—")}</td>
          <td>${esc(child.item.category || "—")}</td>
          <td>${esc(child.item.channel || "—")}</td>
          <td>${esc(child.item.type || "—")}</td>
          <td>${esc(RECURRENCE_LABEL[child.item.recurrence] || "Única")}</td>
          <td>${child.item.consider_business_days ? "Sim" : "Não"}</td>
          <td>${child.item.target_days == null ? "—" : `${esc(child.item.target_days)} dia(s)`}</td>
          <td>${checklist.length} item(ns)</td>
          <td>${esc(childDetails.objectives)}</td>
          <td class="compact-multi-cell">${stackedCell(childDetails.owners)}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td><td>Modelo</td>
          <td>${child.item.target_days == null ? "—" : `${esc(child.item.target_days)} dia(s)`}</td><td>—</td>
          <td class="act table-actions-cell">${tableActionButtons({
            edit: { className: "edit reg-template-edit", attrs: { "data-id": child.item.id, "data-product": child.item.product_id }, title: "Editar subtarefa" },
            clone: { className: "reg-template-clone", attrs: { "data-id": child.item.id, "data-product": child.item.product_id }, title: "Clonar subtarefa" }
          })}</td>
        </tr>`;
      }).join("");
      return `<tr data-task-group="${esc(group.id)}" data-expand-id="${esc(group.id)}"><td>—</td><td>${esc(details.products)}</td><td>Cadastro</td><td><span class="registration-task-name">${children.length ? `<button class="registration-task-toggle" data-group="${esc(group.id)}" title="${expanded ? "Recolher" : "Expandir"} subtarefas">${expanded ? "▾" : "▸"}</button>` : '<span class="registration-task-toggle-spacer"></span>'}<strong>${esc(activityDisplayName(item))}</strong><span class="registration-subtask-count">${children.length || ""}</span><span hidden>${esc(childNames)}</span></span></td><td>${priorityBadge(item.priority)}</td><td class="compact-multi-cell">${stackedCell(details.dependencies)}</td><td>${esc(item.information || "—")}</td><td>${esc(item.group || "—")}</td><td>${esc(item.subgroup || "—")}</td><td>${esc(item.sector || "—")}</td><td>${esc(item.subsector || "—")}</td><td>${esc(item.module || "—")}</td><td>${esc(item.submodule || "—")}</td><td>${esc(item.category || "—")}</td><td>${esc(item.channel || "—")}</td><td>${esc(item.type || "—")}</td><td>${esc(RECURRENCE_LABEL[item.recurrence] || "Única")}</td><td>${item.consider_business_days ? "Sim" : "Não"}</td><td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td><td>${children.length ? '<span class="muted">Nas subtarefas</span>' : `${normalizeChecklist(item.checklist).length} item(ns)`}</td><td>${esc(details.objectives)}</td><td class="compact-multi-cell">${stackedCell(details.owners)}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>Modelo</td><td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td><td>—</td><td class="act table-actions-cell">${tableActionButtons({
        open: children.length ? { className: "reg-template-open", attrs: { "data-group": group.id }, title: expanded ? "Recolher subtarefas" : "Abrir subtarefas" } : null,
        edit: { className: "edit reg-template-edit", attrs: { "data-id": item.id, "data-product": item.product_id }, title: "Editar tarefa" },
        clone: { className: "reg-template-clone", attrs: { "data-id": item.id, "data-product": item.product_id }, title: "Clonar tarefa" }
      })}</td></tr>${childRows}`;
    }).join("");
    root.innerHTML = registrationTemplateTable("tarefa", groups.size, "Cliente", "<th>Produto</th><th>Origem</th><th>Tarefa</th><th>Prioridade</th><th class=\"compact-multi-cell\">Depende de</th><th>Informação</th><th>Grupo</th><th>Subgrupo</th><th>Setor</th><th>Subsetor</th><th>Módulo</th><th>Submódulo</th><th>Categoria</th><th>Canal</th><th>Tipo</th><th>Recorrência</th><th>Dias úteis</th><th>Prazo sugerido</th><th>Checklist</th><th>Objetivo</th><th class=\"compact-multi-cell\">Responsáveis padrão</th><th>Início previsto</th><th>Término previsto</th><th>Início real</th><th>Término real</th><th>Status</th><th>Prazo</th><th>Comentários</th>", rows, 30, "Tarefa");
    if (tableState.view === "mindmap") root.innerHTML = registrationTaskMindMapHtml(...registrationMindMapFilteredItems(root, items, "activities"));
    }
  } else if (section === "goals") {
    const items = loadProductGoals();
    const activities = loadProductActivities();
    const rows = items.map((item) => {
      const dependencies = [
        ...normalizeIdList(item.dependency_goal_template_ids).map((id) => items.find((goal) => goal.id === id)?.name),
        ...normalizeIdList(item.dependency_activity_template_ids).map((id) => activities.find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName)
      ].filter(Boolean);
      return `<tr><td><strong>${esc(item.name || "—")}</strong></td><td>${esc(registrationProductName(item.product_id))}</td><td>${esc(item.category || "—")}</td><td>${esc(item.channel || "—")}</td><td>${esc(item.metric || "—")}</td><td>${esc(`${GOAL_COMPARISON_LABEL[item.comparison] || "No mínimo"} ${Number(item.target_value || 0).toLocaleString("pt-BR")} ${item.unit || ""}`.trim())}</td><td>${esc(item.comments || "—")}</td><td>${esc(item.notes || "—")}</td><td class="compact-multi-cell">${stackedCell(dependencies)}</td><td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td><td class="compact-multi-cell">${stackedCell(assigneeNameList(item.default_assignee_ids, item.default_owner_id, item.assign_to_client))}</td><td class="act table-actions-cell">${tableActionButtons({
        edit: { className: "edit reg-template-edit", attrs: { "data-id": item.id, "data-product": item.product_id }, title: "Editar meta" },
        clone: { className: "reg-goal-clone", attrs: { "data-id": item.id, "data-product": item.product_id }, title: "Clonar meta" }
      })}</td></tr>`;
    }).join("");
    root.innerHTML = registrationTemplateTable("meta", items.length, "Meta", "<th>Produto</th><th>Categoria</th><th>Canal</th><th>Indicador</th><th>Valor-alvo</th><th>Comentários</th><th>Observações</th><th class=\"compact-multi-cell\">Depende de</th><th>Prazo sugerido</th><th class=\"compact-multi-cell\">Responsável padrão</th>", rows, 12);
    if (registrationTableState().view === "mindmap") root.innerHTML = registrationTaskMindMapHtml(...registrationMindMapFilteredItems(root, items, "goals", REGISTRATION_MIND_MAP_GOAL_ADAPTER));
  } else {
    const items = loadProductObjectives();
    const activities = loadProductActivities();
    const rows = items.map((item) => {
      const dependencies = [
        ...normalizeIdList(item.dependency_objective_template_ids).map((id) => items.find((objective) => objective.id === id)?.name),
        ...normalizeIdList(item.dependency_activity_template_ids).map((id) => activities.find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName)
      ].filter(Boolean);
      return `<tr><td><strong>${esc(item.name || "—")}</strong></td><td>${esc(registrationProductName(item.product_id))}</td><td>${esc(item.category || "—")}</td><td>${esc(item.channel || "—")}</td><td>${esc(item.completion_criteria || "—")}</td><td>${esc(item.comments || "—")}</td><td>${esc(item.notes || "—")}</td><td class="compact-multi-cell">${stackedCell(dependencies)}</td><td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td><td class="compact-multi-cell">${stackedCell(assigneeNameList(item.default_assignee_ids, item.default_owner_id, item.assign_to_client))}</td><td class="act table-actions-cell">${tableActionButtons({
        edit: { className: "edit reg-template-edit", attrs: { "data-id": item.id, "data-product": item.product_id }, title: "Editar objetivo" },
        clone: { className: "reg-objective-clone", attrs: { "data-id": item.id, "data-product": item.product_id }, title: "Clonar objetivo" }
      })}</td></tr>`;
    }).join("");
    root.innerHTML = registrationTemplateTable("objetivo", items.length, "Objetivo", "<th>Produto</th><th>Categoria</th><th>Canal</th><th>Critério de conclusão</th><th>Comentários</th><th>Observações</th><th class=\"compact-multi-cell\">Depende de</th><th>Prazo sugerido</th><th class=\"compact-multi-cell\">Responsável padrão</th>", rows, 11);
    if (registrationTableState().view === "mindmap") root.innerHTML = registrationTaskMindMapHtml(...registrationMindMapFilteredItems(root, items, "objectives", REGISTRATION_MIND_MAP_OBJECTIVE_ADAPTER));
  }
  document.getElementById("registration-add")?.addEventListener("click", () => {
    if (section === "activities") {
      const firstProduct = cache.products?.[0];
      if (!firstProduct) { toast("Cadastre um produto antes de criar tarefas.", true); return; }
      productActivityState = { productId: firstProduct.id, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
      openProductActivityDrawer();
      return;
    }
    openRegistrationProductPicker(section);
  });
  root.querySelectorAll(".reg-template-edit").forEach((button) => button.addEventListener("click", () => openRegistrationTemplateEditor(section, button.dataset.product, button.dataset.id)));
  root.querySelectorAll(".reg-template-add-subtask").forEach((button) => button.addEventListener("click", () => {
    productActivityState = { productId: button.dataset.product, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
    openProductActivityDrawer(null, null, button.dataset.id);
  }));
  root.querySelectorAll(".registration-task-toggle").forEach((button) => button.addEventListener("click", () => {
    const groupId = button.dataset.group;
    const childRows = [...root.querySelectorAll(`.registration-subtask-row[data-parent-group="${CSS.escape(groupId)}"]`)];
    const rootRow = button.closest("tr");
    if (!childRows.length || !rootRow) return;
    if (registrationExpandedTaskGroups.has(groupId)) registrationExpandedTaskGroups.delete(groupId);
    else registrationExpandedTaskGroups.add(groupId);
    rootRow.after(...childRows);
    const collapsed = !registrationExpandedTaskGroups.has(groupId);
    childRows.forEach((row) => { row.hidden = collapsed; });
    button.textContent = collapsed ? "▸" : "▾";
    button.title = collapsed ? "Expandir subtarefas" : "Recolher subtarefas";
  }));
  root.querySelectorAll(".reg-template-open").forEach((button) => button.addEventListener("click", () =>
    root.querySelector(`.registration-task-toggle[data-group="${CSS.escape(button.dataset.group)}"]`)?.click()));
  root.querySelectorAll(".reg-template-clone").forEach((button) => button.addEventListener("click", () => {
    productActivityState = { productId: button.dataset.product, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
    openProductActivityDrawer(null, button.dataset.id);
  }));
  root.querySelectorAll(".reg-goal-clone").forEach((button) => button.addEventListener("click", () => {
    productActivityState = { productId: button.dataset.product, editId: null, objectiveEditId: null, goalEditId: null, tab: "goals" };
    openProductGoalDrawer(null, button.dataset.id);
  }));
  root.querySelectorAll(".reg-objective-clone").forEach((button) => button.addEventListener("click", () => {
    productActivityState = { productId: button.dataset.product, editId: null, objectiveEditId: null, goalEditId: null, tab: "objectives" };
    openProductObjectiveDrawer(null, button.dataset.id);
  }));
  if (["activities", "goals", "objectives"].includes(section) && registrationTableState().view === "mindmap") wireRegistrationMindMap(root);
  wireRegistrationTable();
}

// Dashboard de metas e objetivos fica só dentro da entrega (ícone de olho),
// onde há dados reais; em Cadastros o botão segue o padrão, desativado.
function registrationDashboardButtonHtml() {
  return `<button class="view" type="button" title="Dashboard (disponível dentro da entrega)" aria-label="Dashboard" disabled>${viewButtonInner("dashboard")}</button>`;
}

function registrationTableState() {
  if (!registrationsState.tables[registrationsState.section]) {
    registrationsState.tables[registrationsState.section] = { sortKey: null, sortDir: 1, filters: {}, search: "", page: 1, pageSize: 50, view: "table" };
  }
  const state = registrationsState.tables[registrationsState.section];
  if (!state.view || state.view === "dashboard") state.view = "table";
  return state;
}

function registrationTableRows(table, includeSubtasks = false) {
  return [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1
    && !row.querySelector(".empty")
    && (includeSubtasks || !row.classList.contains("registration-subtask-row")));
}

function wireRegistrationTable() {
  const root = document.getElementById("registrations-root");
  const table = root?.querySelector("table");
  if (!table) return;
  if (registrationsState.section === "activities") table.classList.add("registration-activities-table");
  setupRegistrationToolbar(root, table);
  const container = table.parentElement;
  if (container?.classList.contains("product-activity-list") && !container.classList.contains("paginated-registration-table")) {
    container.classList.add("paginated-registration-table");
    const scroll = document.createElement("div");
    scroll.className = "registration-table-scroll";
    container.insertBefore(scroll, table);
    scroll.appendChild(table);
    const footer = document.createElement("div");
    footer.className = "table-pagination registration-pagination";
    container.appendChild(footer);
  }
  const headers = [...table.querySelectorAll("thead th")];
  headers.forEach((header, index) => {
    if (header.textContent.trim().toLocaleUpperCase("pt-BR") === "AÇÕES") return;
    const key = `c${index}`;
    header.dataset.registrationKey = key;
    header.dataset.registrationLabel = header.textContent.trim();
    registrationTableRows(table, true).forEach((row) => {
      const cell = row.children[index];
      if (cell) cell.dataset.registrationKey = key;
    });
    header.title = "Clique para ordenar. Ctrl+clique para filtrar.";
    header.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        openRegistrationColumnFilter(header, table, key);
        return;
      }
      const tableState = registrationTableState();
      if (tableState.sortKey === key) tableState.sortDir *= -1;
      else { tableState.sortKey = key; tableState.sortDir = 1; }
      tableState.page = 1;
      applyRegistrationTableState(table);
    });
  });
  if (registrationsState.section === "activities") {
    const taskHeader = headers.find((header) => header.dataset.registrationLabel === "Tarefa");
    if (taskHeader) {
      taskHeader.classList.add("registration-task-sticky");
      registrationTableRows(table, true).forEach((row) => registrationCell(row, taskHeader.dataset.registrationKey)?.classList.add("registration-task-sticky"));
    }
    const prefs = secondaryColumnPrefs("registrations:activities");
    let changed = false;
    ["c0", "c1"].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(prefs, key)) { prefs[key] = false; changed = true; }
    });
    if (changed) saveSecondaryColumnPrefs();
  }
  applyRegistrationColumnPreferences(table);
  applyRegistrationTableState(table);
  wireSecondaryTableSelection(table, `registrations:${registrationsState.section}`);
}

function setupRegistrationToolbar(root, table) {
  const toolbar = root.querySelector(".modal-toolbar");
  if (!toolbar || toolbar.classList.contains("registration-toolbar")) return;
  const count = toolbar.querySelector(".muted");
  const addButton = toolbar.querySelector("#registration-add");
  const tableState = registrationTableState();
  toolbar.classList.add("registration-toolbar");
  const left = document.createElement("div");
  left.className = "registration-toolbar-left";
  const center = document.createElement("div");
  center.className = "registration-toolbar-center";
  const right = document.createElement("div");
  right.className = "registration-toolbar-right";
  if (toolbar.closest("#registrations-root")) left.insertAdjacentHTML("beforeend", '<span class="registration-toolbar-title">Cadastros</span>');
  if (count) left.appendChild(count);
  center.innerHTML = `<input class="search registration-toolbar-search" placeholder="Buscar..." value="${esc(tableState.search || "")}">`;
  if (addButton) {
    const originalLabel = addButton.textContent.trim().replace(/^\+\s*/, "");
    addButton.classList.add("plus");
    addButton.textContent = "+";
    addButton.title = originalLabel ? `Adicionar ${originalLabel.toLocaleLowerCase("pt-BR")}` : "Adicionar";
    center.appendChild(addButton);
  }
  const viewControl = ["activities", "goals", "objectives"].includes(registrationsState.section)
    ? `<button class="btn view-menu-trigger active" id="registration-view-menu-btn" type="button" title="Modo de visualização: Tabela">${viewTriggerInner("table")}</button>`
    : `<button class="btn view-menu-trigger active" type="button" title="Modo de visualização: Tabela">${viewTriggerInner("table")}</button>`;
  right.innerHTML = `<button class="btn table-group-btn" type="button" title="Agrupar (indisponível nesta tabela)" disabled>≡</button><button class="btn registration-cols-btn" type="button" title="Selecionar colunas">⊞</button>${viewControl}<button class="view" type="button" disabled title="Matriz" aria-label="Matriz">${viewButtonInner("matrix")}</button>${registrationDashboardButtonHtml()}<button class="btn registration-data-btn" type="button" title="Dados">⬆⬇</button>`;
  toolbar.replaceChildren(left, center, right);
  right.querySelector(".registration-data-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openRegistrationDataMenu(event.currentTarget, table);
  });
  const filterStrip = document.createElement("div");
  filterStrip.className = "registration-filter-strip";
  filterStrip.innerHTML = `<div class="registration-filter-badges"></div><button class="filter-clear-all registration-filter-clear-all" type="button" hidden><span aria-hidden="true">×</span> Limpar tudo</button>`;
  toolbar.after(filterStrip);
  center.querySelector(".registration-toolbar-search").addEventListener("input", (event) => {
    tableState.search = event.target.value.trim();
    tableState.page = 1;
    applyRegistrationTableState(table);
  });
  right.querySelector(".registration-cols-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openRegistrationColumnManager(table);
  });
  right.querySelector("#registration-view-menu-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openRegistrationViewMenu();
  });
}

function registrationColumnDefinitions(table) {
  return [...table.querySelectorAll("thead th[data-registration-key]")]
    .map((header) => ({ k: header.dataset.registrationKey, h: header.dataset.registrationLabel }))
    .sort((a, b) => Number(a.k.slice(1)) - Number(b.k.slice(1)));
}

function exportRegistrationCSV(table, visibleOnly) {
  const tableState = registrationTableState();
  const query = String(tableState.search || "").toLocaleLowerCase("pt-BR");
  const isShown = (element) => element && !element.hidden && getComputedStyle(element).display !== "none";
  const headers = [...table.querySelectorAll("thead th")].map((th, index) => ({ th, index }))
    .filter(({ th }) => !th.classList.contains("table-actions-head") && !th.classList.contains("select-head") && !th.classList.contains("expand-head")
      && th.textContent.replace(/[▲▼]/g, "").trim() && (!visibleOnly || isShown(th)));
  const rows = registrationTableRows(table, true).filter((row) => (!query || row.textContent.toLocaleLowerCase("pt-BR").includes(query))
    && Object.entries(tableState.filters || {}).every(([key, selected]) => !selected?.size || selected.has(registrationCell(row, key)?.textContent.trim() || "—")))
    .map((row) => headers.map(({ index }) => String(row.children[index]?.textContent || "").replace(/\s+/g, " ").trim()));
  const columns = headers.map(({ th }, position) => ({ k: position, h: th.dataset.registrationLabel || th.textContent.replace(/[▲▼]/g, "").trim(), csv: (_value, row) => row[position] ?? "" }));
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  downloadCSV(columns, rows, `enterpriser_cadastros_${registrationsState.section}_${visibleOnly ? "colunas_visiveis" : "todas_colunas"}_${stamp}.csv`);
  toast(`CSV exportado: ${rows.length} linha(s).`);
}

function openRegistrationDataMenu(anchor, table) {
  document.getElementById("registration-data-dd")?.remove();
  const panel = document.createElement("div");
  panel.id = "registration-data-dd";
  panel.className = "data-dd";
  const importTab = `reg:${registrationsState.section}`;
  const spec = importSpec(importTab);
  const permissionModule = { products: "products", pipelines: "pipelines", users: "users", activities: "activityTemplates", goals: "goalTemplates", objectives: "objectiveTemplates" }[registrationsState.section];
  const canImport = Boolean(spec) && (spec.adminOnly ? currentUserIsAdmin() : currentUserCan(permissionModule, "create"));
  panel.innerHTML = `<div class="dd-head"><span>Dados</span><span>${esc(spec?.title || "Cadastros")}</span></div>
    <div class="dd-head"><span>Exportar</span><span>CSV</span></div>
    <button class="dd-menu-btn registration-export-visible" type="button">Exportar colunas visíveis</button>
    <button class="dd-menu-btn registration-export-all" type="button">Exportar todas as colunas</button>
    ${importMenuHtml(canImport)}`;
  document.body.appendChild(panel);
  openImportMenuItems(panel, importTab, spec);
  const rect = anchor.getBoundingClientRect();
  panel.style.right = "auto";
  panel.style.left = `${Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.querySelector(".registration-export-visible").addEventListener("click", () => { panel.remove(); exportRegistrationCSV(table, true); });
  panel.querySelector(".registration-export-all").addEventListener("click", () => { panel.remove(); exportRegistrationCSV(table, false); });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && event.target !== anchor) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function registrationCell(row, key) {
  return row.querySelector(`td[data-registration-key="${CSS.escape(key)}"]`);
}

function applyRegistrationColumnPreferences(table) {
  const scope = `registrations:${registrationsState.section}`;
  const prefs = secondaryColumnPrefs(scope);
  const definitions = registrationColumnDefinitions(table);
  const ordered = orderedColumnDefinitions(definitions, prefs);
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  const headerByKey = Object.fromEntries([...headRow.cells].filter((cell) => cell.dataset.registrationKey).map((cell) => [cell.dataset.registrationKey, cell]));
  const fixedHeaders = [...headRow.cells].filter((cell) => !cell.dataset.registrationKey);
  ordered.forEach((col) => headRow.appendChild(headerByKey[col.k]));
  orderLeadingTableCells(headRow, fixedHeaders);
  registrationTableRows(table, true).forEach((row) => {
    const cellByKey = Object.fromEntries([...row.cells].filter((cell) => cell.dataset.registrationKey).map((cell) => [cell.dataset.registrationKey, cell]));
    const fixedCells = [...row.cells].filter((cell) => !cell.dataset.registrationKey);
    ordered.forEach((col) => { if (cellByKey[col.k]) row.appendChild(cellByKey[col.k]); });
    orderLeadingTableCells(row, fixedCells);
  });
  ordered.forEach((col) => {
    const visible = prefs[col.k] !== false;
    headerByKey[col.k].hidden = !visible;
    registrationTableRows(table, true).forEach((row) => {
      const cell = registrationCell(row, col.k);
      if (cell) cell.hidden = !visible;
    });
  });
}

function openRegistrationColumnManager(table) {
  const definitions = registrationColumnDefinitions(table);
  openSecondaryColumnManager({
    scope: `registrations:${registrationsState.section}`,
    label: REGISTRATION_LABEL[registrationsState.section] || "Cadastros",
    definitions,
    onChange: () => {
      applyRegistrationColumnPreferences(table);
      applyRegistrationTableState(table);
    }
  });
}

function applyRegistrationTableState(table) {
  const tableState = registrationTableState();
  table.querySelector(".registration-filter-empty")?.remove();
  const rows = registrationTableRows(table);
  const query = String(tableState.search || "").toLocaleLowerCase("pt-BR");
  const filteredRows = rows.filter((row) => (!query || row.textContent.toLocaleLowerCase("pt-BR").includes(query))
    && Object.entries(tableState.filters).every(([key, selected]) => {
      if (!selected?.size) return true;
      return selected.has(registrationCell(row, key)?.textContent.trim() || "—");
    }));
  if (tableState.sortKey) {
    const compare = (a, b) => (registrationCell(a, tableState.sortKey)?.textContent.trim() || "").localeCompare(
      registrationCell(b, tableState.sortKey)?.textContent.trim() || "", "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir;
    rows.sort(compare).forEach((row) => table.tBodies[0].appendChild(row));
    filteredRows.sort(compare);
  }
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / tableState.pageSize));
  tableState.page = Math.min(Math.max(1, tableState.page || 1), totalPages);
  const start = (tableState.page - 1) * tableState.pageSize;
  const pageRows = new Set(filteredRows.slice(start, start + tableState.pageSize));
  rows.forEach((row) => { row.hidden = !pageRows.has(row); });
  if (registrationsState.section === "activities") {
    rows.forEach((row) => {
      const groupId = row.dataset.taskGroup;
      if (!groupId) return;
      const childRows = [...table.querySelectorAll(`.registration-subtask-row[data-parent-group="${CSS.escape(groupId)}"]`)];
      if (!childRows.length) return;
      row.after(...childRows);
      const hideChildren = row.hidden || !registrationExpandedTaskGroups.has(groupId);
      childRows.forEach((childRow) => { childRow.hidden = hideChildren; });
    });
  }
  if (rows.length && !filteredRows.length) {
    const empty = document.createElement("tr");
    empty.className = "registration-filter-empty";
    empty.innerHTML = `<td colspan="${table.querySelectorAll("thead th").length}" class="empty">Nenhum registro corresponde aos filtros.</td>`;
    table.tBodies[0].appendChild(empty);
  }
  table.querySelectorAll("thead th[data-registration-key]").forEach((header) => {
    header.classList.toggle("filtered", Boolean(tableState.filters[header.dataset.registrationKey]?.size));
    header.querySelector(".registration-sort-arrow")?.remove();
    if (tableState.sortKey === header.dataset.registrationKey) {
      header.insertAdjacentHTML("beforeend", `<span class="arrow registration-sort-arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>`);
    }
  });
  renderRegistrationFilterBadges(table);
  renderRegistrationPagination(table, filteredRows.length, totalPages);
  table._refreshSecondarySelection?.();
}

function renderRegistrationPagination(table, total, totalPages) {
  const footer = table.closest(".paginated-registration-table")?.querySelector(".registration-pagination");
  if (!footer) return;
  const tableState = registrationTableState();
  const start = total ? (tableState.page - 1) * tableState.pageSize + 1 : 0;
  const end = Math.min(tableState.page * tableState.pageSize, total);
  footer.innerHTML = `<span>${total ? `${start}-${end} de ${total}` : "0 registros"}</span><div><button class="btn reg-page-prev"${tableState.page <= 1 ? " disabled" : ""}>‹</button><span>Página ${tableState.page} de ${totalPages}</span><button class="btn reg-page-next"${tableState.page >= totalPages ? " disabled" : ""}>›</button></div>`;
  footer.querySelector(".reg-page-prev").addEventListener("click", () => { tableState.page -= 1; applyRegistrationTableState(table); });
  footer.querySelector(".reg-page-next").addEventListener("click", () => { tableState.page += 1; applyRegistrationTableState(table); });
}

function renderRegistrationFilterBadges(table) {
  const strip = document.querySelector("#registrations-root .registration-filter-strip");
  const badges = strip?.querySelector(".registration-filter-badges");
  const clearAll = strip?.querySelector(".registration-filter-clear-all");
  if (!strip || !badges || !clearAll) return;
  const tableState = registrationTableState();
  const orderedKeys = registrationColumnDefinitions(table).map((column) => column.k);
  const active = [
    ...orderedKeys.map((key) => [key, tableState.filters[key]]),
    ...Object.entries(tableState.filters).filter(([key]) => !orderedKeys.includes(key))
  ].filter(([, values]) => values?.size);
  const labels = new Map([...table.querySelectorAll("thead th[data-registration-key]")].map((header) => [header.dataset.registrationKey, header.dataset.registrationLabel]));
  badges.innerHTML = active.map(([key, values]) => `<button class="registration-filter-badge" data-key="${key}" title="Limpar filtro"><span>${esc(labels.get(key) || "Coluna")}: ${esc([...values].join(", "))}</span><b>×</b></button>`).join("");
  badges.querySelectorAll(".registration-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete tableState.filters[badge.dataset.key];
    tableState.page = 1;
    applyRegistrationTableState(table);
  }));
  clearAll.hidden = active.length < 2;
  clearAll.onclick = active.length < 2 ? null : () => {
    tableState.filters = {};
    tableState.page = 1;
    applyRegistrationTableState(table);
  };
}

function openRegistrationColumnFilter(header, table, key) {
  document.getElementById("registration-filter-dd")?.remove();
  const tableState = registrationTableState();
  const values = [...new Set(registrationTableRows(table).map((row) => registrationCell(row, key)?.textContent.trim() || "—"))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }));
  const rect = header.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "registration-filter-dd";
  panel.className = "filter-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 330))}px`;
  panel.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 360)}px`;
  document.body.appendChild(panel);
  mountColumnFilterPanel(panel, {
    title: `Filtrar · ${header.dataset.registrationLabel || key}`, values, key, current: tableState.filters[key],
    onApply: (rule) => {
      if (rule) tableState.filters[key] = rule; else delete tableState.filters[key];
      tableState.page = 1;
      panel.remove();
      applyRegistrationTableState(table);
    }
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !header.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 50);
}

function registrationTemplateTable(singular, count, firstColumn, extraHeaders, rows, colspan, addLabel = firstColumn) {
  return `<div class="modal-toolbar"><span class="muted">${count} ${singular}(s) cadastrada(s) nos produtos</span><button class="btn primary" id="registration-add">+ ${addLabel}</button></div>
    <div class="product-activity-list"><table><thead><tr><th>${firstColumn}</th>${extraHeaders}${tableActionsHead()}</tr></thead><tbody>${rows || `<tr><td colspan="${colspan}" class="empty">Nenhum registro cadastrado.</td></tr>`}</tbody></table></div>`;
}

function openRegistrationTemplateEditor(section, productId, itemId = null) {
  if (!productId) return;
  productActivityState = { productId, editId: null, objectiveEditId: null, goalEditId: null, tab: section };
  if (section === "activities") {
    openProductActivityDrawer(itemId);
    return;
  }
  if (section === "objectives") {
    openProductObjectiveDrawer(itemId);
  } else if (section === "goals") {
    openProductGoalDrawer(itemId);
  }
}

function openRegistrationProductPicker(section) {
  const modal = document.querySelector("#ov .modal.full");
  if (!modal) return;
  const overlay = document.createElement("div");
  overlay.id = "registration-product-picker";
  overlay.className = "activity-form-overlay";
  const label = REGISTRATION_LABEL[section]?.replace(/s$/, "") || "Cadastro";
  overlay.innerHTML = `<aside class="activity-form-drawer"><h3>Selecionar produto<button class="modal-close-x" id="registration-picker-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form"><div class="field"><label>Produto</label><select id="registration-product">${cache.products.map((product) => `<option value="${esc(product.id)}">${esc(product.name)}</option>`).join("")}</select></div><div class="panel-list">O ${label.toLocaleLowerCase("pt-BR")} será vinculado ao produto escolhido.</div></div>
    <div class="modal-foot"><button class="btn" id="registration-picker-cancel">Cancelar</button><button class="btn primary" id="registration-picker-next">Continuar</button></div></aside>`;
  modal.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById("registration-picker-close").addEventListener("click", close);
  document.getElementById("registration-picker-cancel").addEventListener("click", close);
  document.getElementById("registration-picker-next").addEventListener("click", () => {
    const productId = document.getElementById("registration-product").value;
    if (!productId) { toast("Cadastre um produto primeiro.", true); return; }
    close();
    openRegistrationTemplateEditor(section, productId);
  });
}

// ---------- Integrações ----------
const SOCIAL_CHANNEL_CONFIG = {
  facebook: { label: "Facebook", baseUrl: "https://www.facebook.com/" },
  instagram: { label: "Instagram", baseUrl: "https://www.instagram.com/" },
  linkedin: { label: "LinkedIn", baseUrl: "https://www.linkedin.com/in/" },
  reddit: { label: "Reddit", baseUrl: "https://www.reddit.com/user/" },
  tiktokshop: { label: "TikTokShop", baseUrl: "https://www.tiktok.com/@" },
  youtube: { label: "YouTube", baseUrl: "https://www.youtube.com/@" }
};
const SOCIAL_PROFILES_CACHE_KEY = "crm_social_channel_profiles";
function socialProfilesCacheKey() {
  return `${SOCIAL_PROFILES_CACHE_KEY}:${readAuthSession()?.user?.id || "offline"}`;
}
let socialChannelProfiles = (() => {
  try { return JSON.parse(localStorage.getItem(socialProfilesCacheKey()) || "{}"); }
  catch (e) { return {}; }
})();
let socialChannelProfilesLoaded = false;

function normalizeSocialUsername(value, channel) {
  let username = String(value || "").trim();
  if (!username) return "";
  try {
    const url = new URL(username);
    const parts = url.pathname.split("/").filter(Boolean);
    username = parts.at(-1) || "";
  } catch (e) {}
  username = username.replace(/^@/, "");
  if (channel === "reddit") username = username.replace(/^(u|user)\//i, "");
  return username.trim();
}

function socialProfileUrl(channel, username) {
  const config = SOCIAL_CHANNEL_CONFIG[channel];
  const normalized = normalizeSocialUsername(username, channel);
  return config && normalized ? config.baseUrl + encodeURIComponent(normalized) + (["instagram", "linkedin", "reddit"].includes(channel) ? "/" : "") : "";
}

function cacheSocialChannelProfiles() {
  localStorage.setItem(socialProfilesCacheKey(), JSON.stringify(socialChannelProfiles));
}

async function loadSocialChannelProfiles({ force = false } = {}) {
  if (socialChannelProfilesLoaded && !force) return socialChannelProfiles;
  if (isLive()) {
    const rows = await api("social_channel_profiles?select=channel,username&order=channel.asc");
    socialChannelProfiles = Object.fromEntries((rows || []).map((row) => [row.channel, row.username || ""]));
  }
  socialChannelProfilesLoaded = true;
  cacheSocialChannelProfiles();
  return socialChannelProfiles;
}

async function saveSocialChannelProfiles() {
  const values = Object.fromEntries(Object.keys(SOCIAL_CHANNEL_CONFIG).map((channel) => [
    channel,
    normalizeSocialUsername(document.querySelector(`[data-social-username="${channel}"]`)?.value, channel)
  ]));
  if (isLive()) {
    const userId = readAuthSession()?.user?.id;
    if (!userId) throw new Error("Sua sessão expirou.");
    const rows = Object.entries(values).map(([channel, username]) => ({
      user_id: userId,
      channel,
      username,
      updated_at: new Date().toISOString()
    }));
    await api("social_channel_profiles?on_conflict=user_id,channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows)
    });
  }
  socialChannelProfiles = values;
  socialChannelProfilesLoaded = true;
  cacheSocialChannelProfiles();
}

const INTEGRATION_GROUPS = [
  { group: "META", items: [
    { name: "WhatsApp", active: IS_EXTENSION_CONTEXT },
    { name: "Facebook", active: false },
    { name: "Instagram", active: false },
    { name: "Meta Ads", active: false }
  ] },
  { group: "REDDIT", items: [{ name: "Reddit", active: IS_EXTENSION_CONTEXT }] },
  { group: "LINKEDIN", items: [{ name: "LinkedIn", active: false }] },
  { group: "TELEGRAM", items: [{ name: "Telegram", active: false }] }
];

let googleContactsState = { people: [], account: null };
const GOOGLE_CONTACT_MAPPING_STORAGE = "crm_google_contact_field_map_v1";
const GOOGLE_CONTACT_SOURCE_FIELDS = [
  { key: "name", label: "Nome" },
  { key: "phones", label: "Telefones" },
  { key: "emails", label: "E-mails" },
  { key: "job_title", label: "Cargo" },
  { key: "department", label: "Departamento" },
  { key: "notes", label: "Observações / biografia" },
  { key: "birth_date", label: "Data de nascimento" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "reddit", label: "Reddit" },
  { key: "youtube", label: "YouTube" },
  { key: "user_defined", label: "Campos personalizados" }
];
const GOOGLE_CONTACT_TARGET_FIELDS = [
  { value: "", label: "Não importar" },
  { value: "name", label: "Nome completo" },
  { value: "phone", label: "Telefone/celular" },
  { value: "email", label: "E-mail(s)" },
  { value: "contact_type", label: "Tipo de contato" },
  { value: "channel", label: "Canal" },
  { value: "job_title", label: "Cargo" },
  { value: "department", label: "Departamento" },
  { value: "notes", label: "Observações" },
  { value: "tags", label: "Tags" },
  { value: "birth_date", label: "Data de nascimento" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "reddit", label: "Reddit" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "youtube", label: "YouTube" }
];
const DEFAULT_GOOGLE_CONTACT_FIELD_MAP = {
  name: "name", phones: "phone", emails: "email", job_title: "job_title",
  department: "department", notes: "notes", birth_date: "birth_date",
  linkedin: "linkedin", facebook: "facebook", instagram: "instagram",
  reddit: "reddit", youtube: "youtube", user_defined: ""
};

function googleContactFieldMap() {
  try {
    const saved = JSON.parse(localStorage.getItem(GOOGLE_CONTACT_MAPPING_STORAGE) || "{}");
    return { ...DEFAULT_GOOGLE_CONTACT_FIELD_MAP, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch (error) {
    return { ...DEFAULT_GOOGLE_CONTACT_FIELD_MAP };
  }
}

function googleFieldMappingHtml() {
  const mapping = googleContactFieldMap();
  const options = (selected) => GOOGLE_CONTACT_TARGET_FIELDS.map((target) => `<option value="${esc(target.value)}"${target.value === selected ? " selected" : ""}>${esc(target.label)}</option>`).join("");
  return `<div class="panel-list">Escolha o destino de cada dado do Google. Empresa e CNPJ continuam reservados para localizar ou criar a empresa vinculada.</div>
    <div class="table-wrap"><table><thead><tr><th>COLUNA DO GOOGLE</th><th>CAMPO NO CMS</th></tr></thead><tbody>
      ${GOOGLE_CONTACT_SOURCE_FIELDS.map((source) => `<tr><td>${esc(source.label)}</td><td><select class="google-map-target" data-source="${esc(source.key)}">${options(mapping[source.key] || "")}</select></td></tr>`).join("")}
      <tr><td>Empresa / CNPJ</td><td><strong>Empresa vinculada</strong> <span class="muted">(fixo)</span></td></tr>
    </tbody></table></div>
    <div class="modal-foot"><button class="btn" id="google-map-defaults" type="button">Restaurar padrão</button><button class="btn primary" id="google-map-save" type="button">Salvar</button></div>`;
}

function openGoogleFieldMapping() {
  const close = nestedSidePanel("De/para Google Contatos", googleFieldMappingHtml(), { closeOnOverlay: true });
  document.getElementById("google-map-defaults")?.addEventListener("click", () => {
    document.querySelectorAll(".google-map-target").forEach((select) => { select.value = DEFAULT_GOOGLE_CONTACT_FIELD_MAP[select.dataset.source] || ""; });
  });
  document.getElementById("google-map-save")?.addEventListener("click", () => {
    const mapping = {};
    const usedTargets = new Set();
    for (const select of document.querySelectorAll(".google-map-target")) {
      const target = select.value;
      if (target && usedTargets.has(target)) {
        toast(`O campo ${GOOGLE_CONTACT_TARGET_FIELDS.find((item) => item.value === target)?.label || target} foi escolhido mais de uma vez.`, true);
        return;
      }
      if (target) usedTargets.add(target);
      mapping[select.dataset.source] = target;
    }
    localStorage.setItem(GOOGLE_CONTACT_MAPPING_STORAGE, JSON.stringify(mapping));
    close();
    toast("De/para do Google salvo.");
  });
}

function googleOAuthClientId() {
  return globalThis.chrome?.runtime?.getManifest?.().oauth2?.client_id || "";
}

function googleOAuthConfigured() {
  const clientId = googleOAuthClientId();
  return clientId.endsWith(".apps.googleusercontent.com") && !clientId.startsWith("YOUR_");
}

function storedGoogleAccount() {
  try { return JSON.parse(localStorage.getItem("crm_google_account") || "null"); }
  catch (e) { return null; }
}

function getGoogleAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    const chromeApi = globalThis.chrome;
    if (!chromeApi?.identity?.getAuthToken) { reject(new Error("A API de identidade do Chrome não está disponível.")); return; }
    chromeApi.identity.getAuthToken({ interactive }, (result) => {
      const error = chromeApi.runtime.lastError;
      if (error) { reject(new Error(error.message)); return; }
      const token = typeof result === "string" ? result : result?.token;
      if (!token) { reject(new Error("O Google não retornou um token de acesso.")); return; }
      resolve(token);
    });
  });
}

async function googleApiJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google API ${response.status}${detail ? ` · ${detail.slice(0, 140)}` : ""}`);
  }
  return response.json();
}

async function fetchGooglePeople(token) {
  const people = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      personFields: "names,emailAddresses,phoneNumbers,organizations,birthdays,urls,userDefined,biographies,metadata",
      pageSize: "1000",
      sortOrder: "FIRST_NAME_ASCENDING"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleApiJson(`https://people.googleapis.com/v1/people/me/connections?${params}`, token);
    people.push(...(data.connections || []).filter((person) => {
      if (person.metadata?.deleted) return false;
      return ["names", "emailAddresses", "phoneNumbers", "organizations", "urls", "userDefined", "biographies"]
        .some((field) => Array.isArray(person[field]) && person[field].length);
    }));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return people;
}

function googlePersonPrimary(person, field) {
  const values = person?.[field] || [];
  return values.find((item) => item.metadata?.primary) || values[0] || null;
}

function normalizeCompanyName(value) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}

function normalizeTaxId(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatImportedCnpj(value) {
  const digits = normalizeTaxId(value);
  if (digits.length !== 14) return digits;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function looksLikeLegalCompanyName(value) {
  const text = String(value || "").trim();
  return /\bLTDA\b/i.test(text) || /^\d{2}\.?\d{3}\.?\d{3}\b/.test(text);
}

function deduplicateCompanyNames(tradeName, legalName) {
  const trade = String(tradeName || "").trim();
  const legal = String(legalName || "").trim();
  if (trade && legal && normalizeCompanyName(trade) !== normalizeCompanyName(legal)) {
    return { trade_name: trade, legal_name: legal };
  }
  const duplicated = legal || trade;
  return looksLikeLegalCompanyName(duplicated)
    ? { trade_name: "", legal_name: duplicated }
    : { trade_name: duplicated, legal_name: "" };
}

function parseGoogleCompany(person) {
  const organization = googlePersonPrimary(person, "organizations") || {};
  const customValues = (person.userDefined || []).map((item) => item.value).filter(Boolean);
  const displayName = googlePersonPrimary(person, "names")?.displayName || "";
  const candidates = [organization.name, ...customValues, displayName].map((value) => String(value || "").trim()).filter(Boolean);
  const descriptor = candidates.find((value) => value.includes("|") && value.split("|").some((part) => normalizeTaxId(part).length >= 12))
    || candidates.find((value) => value.includes("|"))
    || organization.name || "";
  const parts = String(descriptor).split("|").map((part) => part.trim()).filter(Boolean);
  const taxPart = [...parts].reverse().find((part) => {
    const length = normalizeTaxId(part).length;
    return length >= 12 && length <= 14;
  });
  const taxId = taxPart ? formatImportedCnpj(taxPart) : "";
  const names = parts.filter((part) => part !== taxPart);
  if (names.length >= 2) {
    return { ...deduplicateCompanyNames(names[0], names[1]), tax_id: taxId, raw: descriptor };
  }
  const companyName = names[0] || String(organization.name || "").trim();
  return { ...deduplicateCompanyNames(companyName, companyName), tax_id: taxId, raw: descriptor };
}

function findImportedCompany(companyData) {
  if (!companyData) return null;
  const taxDigits = normalizeTaxId(companyData.tax_id);
  return (cache.companies || []).find((item) => taxDigits && normalizeTaxId(item.tax_id) === taxDigits)
    || (cache.companies || []).find((item) => {
      const names = [item.trade_name, item.legal_name].map(normalizeCompanyName);
      return [companyData.trade_name, companyData.legal_name].map(normalizeCompanyName).filter(Boolean).some((name) => names.includes(name));
    }) || null;
}

function googlePersonSourceData(person) {
  const emails = (person.emailAddresses || []).map((item) => item.value).filter(Boolean);
  const phones = (person.phoneNumbers || []).map((item) => item.value).filter(Boolean);
  const organization = googlePersonPrimary(person, "organizations") || {};
  const googleCompany = parseGoogleCompany(person);
  const emailName = emails[0]?.split("@")[0]?.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "";
  const name = googlePersonPrimary(person, "names")?.displayName || emailName || googleCompany.trade_name || "Contato Google";
  const birthday = googlePersonPrimary(person, "birthdays")?.date;
  const birthDate = birthday?.year && birthday?.month && birthday?.day
    ? `${birthday.year}-${String(birthday.month).padStart(2, "0")}-${String(birthday.day).padStart(2, "0")}` : "";
  const urls = person.urls || [];
  const social = (domain) => urls.find((item) => String(item.value || "").toLowerCase().includes(domain))?.value || "";
  return {
    name,
    phones: normalizePhoneList(phones.join("; ")),
    emails: normalizeEmailList(emails.join("; ")),
    job_title: organization.title || "",
    department: organization.department || "",
    notes: (person.biographies || []).map((item) => item.value).filter(Boolean).join("\n"),
    birth_date: birthDate,
    linkedin: social("linkedin.com"),
    facebook: social("facebook.com"),
    instagram: social("instagram.com"),
    reddit: social("reddit.com"),
    youtube: social("youtube.com"),
    user_defined: (person.userDefined || []).map((item) => [item.key, item.value].filter(Boolean).join(": ")).filter(Boolean).join("; "),
    google_company: googleCompany
  };
}

function googlePersonToContact(person) {
  const source = googlePersonSourceData(person);
  const mapping = googleContactFieldMap();
  const company = findImportedCompany(source.google_company);
  const mapped = {
    company_id: company?.tax_id || null,
    google_resource_name: person.resourceName,
    google_etag: person.etag || null,
    google_synced_at: new Date().toISOString(),
    google_company: source.google_company
  };
  GOOGLE_CONTACT_SOURCE_FIELDS.forEach(({ key }) => {
    const target = mapping[key];
    const value = source[key];
    if (!target || value == null || value === "") return;
    mapped[target] = target === "tags" ? normalizeTextList(value) : value;
  });
  mapped.name = mapped.name || "Contato Google";
  if (mapped.birth_date === "") mapped.birth_date = null;
  return mapped;
}

function googleContactDatabaseBody(mapped) {
  const { google_company: _googleCompany, ...body } = mapped;
  return body;
}

async function ensureGoogleCompany(companyData) {
  if (!companyData) return null;
  const existing = findImportedCompany(companyData);
  if (existing) return existing;
  if (!companyData.tax_id || (!companyData.legal_name && !companyData.trade_name)) return null;
  const body = {
    tax_id: companyData.tax_id,
    legal_name: companyData.legal_name || null,
    trade_name: companyData.trade_name || null,
    registration_status: "Importada do Google",
    notes: `Importada do Google Contatos: ${companyData.raw || companyData.legal_name}`
  };
  const saved = await createRow("companies", body);
  cache.companies.push(saved);
  cache.companyById[saved.tax_id] = saved;
  return saved;
}

function existingContactForGoogle(person) {
  const email = googlePersonPrimary(person, "emailAddresses")?.value?.toLowerCase();
  return (cache.contacts || []).find((item) => item.google_resource_name === person.resourceName)
    || (email ? (cache.contacts || []).find((item) => String(item.email || "").toLowerCase().split(/[;,]/).map((v) => v.trim()).includes(email)) : null);
}

function integrationsHtml() {
  const googleAccount = storedGoogleAccount();
  const groups = INTEGRATION_GROUPS.map((g) => `<div class="integrations-group">
      <h4>${esc(g.group)}</h4>
      ${g.items.map((it) => `<div class="integration-row">
          <span>${esc(it.name)}</span>
          <span class="integration-status ${it.active ? "active" : "soon"}">${it.active ? "Ativo" : "Em breve"}</span>
        </div>`).join("")}
    </div>`).join("");
  const socialProfiles = `<div class="integrations-group social-integrations-group"><h4>Perfis sociais</h4>
    ${Object.entries(SOCIAL_CHANNEL_CONFIG).map(([channel, config]) => `<label class="integration-row social-integration-row"><span>${esc(config.label)}</span><input data-social-username="${channel}" value="${esc(socialChannelProfiles[channel] || "")}" placeholder="Username"></label>`).join("")}
    <div class="integration-save-row"><button class="btn primary" id="social-integrations-save" type="button">Salvar perfis</button></div>
  </div>`;
  const googleStatus = IS_EXTENSION_CONTEXT
    ? (!googleOAuthConfigured() ? "Configuração pendente" : googleAccount ? googleAccount.email || "Conectado" : "Desconectado")
    : "Disponível na extensão Chrome";
  return `${groups}${socialProfiles}<div class="integrations-group"><h4>Google</h4>
    <div class="integration-row google-integration-row">
      <div><strong>Google Contatos</strong><div class="muted">${esc(googleStatus)}</div></div>
      <div class="integration-actions">
        <button class="btn" id="google-field-map" type="button">De/para</button>
        ${googleAccount ? '<button class="btn" id="google-disconnect">Desconectar</button>' : ""}
        <button class="btn primary" id="google-connect"${IS_EXTENSION_CONTEXT ? "" : " disabled"}>${IS_EXTENSION_CONTEXT ? (googleAccount ? "Importar contatos" : googleOAuthConfigured() ? "Conectar" : "Configurar") : "Usar extensão"}</button>
      </div>
    </div>
  </div><div class="panel-list">${IS_EXTENSION_CONTEXT
    ? "WhatsApp e Reddit capturam conversas. O Google Contatos importa somente os contatos selecionados para Pessoas."
    : "A versão web mantém o CMS, login, cadastros, negócios, entregas, tarefas e importação manual de conversas. Captura automática e Google Contatos ficam na extensão Chrome."}</div>`;
}

function wireIntegrations() {
  document.getElementById("google-field-map")?.addEventListener("click", openGoogleFieldMapping);
  document.getElementById("google-connect")?.addEventListener("click", openGoogleContactsImport);
  document.getElementById("google-disconnect")?.addEventListener("click", disconnectGoogleAccount);
  document.getElementById("social-integrations-save")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Salvando...";
    try {
      await saveSocialChannelProfiles();
      toast("Perfis sociais salvos.");
    } catch (err) {
      toast("Erro ao salvar perfis sociais · " + err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Salvar perfis";
    }
  });
  loadSocialChannelProfiles().then(() => {
    document.querySelectorAll("[data-social-username]").forEach((input) => {
      if (document.activeElement !== input) input.value = socialChannelProfiles[input.dataset.socialUsername] || "";
    });
  }).catch((err) => toast("Erro ao carregar perfis sociais · " + err.message, true));
}

function showGoogleOAuthSetup() {
  const extensionId = globalThis.chrome?.runtime?.id || "Disponível após carregar a extensão no Chrome";
  sidePanel("Configurar Google", `<div class="google-setup">
    <div class="field"><label>ID desta extensão</label><input value="${esc(extensionId)}" readonly></div>
    <ol><li>Ative a People API no Google Cloud.</li><li>Crie um cliente OAuth do tipo Extensão do Chrome usando o ID acima.</li><li>Informe o Client ID para substituir o valor pendente no manifest.json.</li></ol>
    <div class="panel-list">Depois, recarregue a extensão em chrome://extensions e clique em Conectar.</div>
  </div>`, { closeOnOverlay: true });
}

async function openGoogleContactsImport() {
  if (!googleOAuthConfigured()) { showGoogleOAuthSetup(); return; }
  try {
    const button = document.getElementById("google-connect");
    if (button) { button.disabled = true; button.textContent = "Conectando..."; }
    const token = await getGoogleAuthToken(true);
    const [account, people] = await Promise.all([
      googleApiJson("https://www.googleapis.com/oauth2/v2/userinfo", token),
      fetchGooglePeople(token)
    ]);
    googleContactsState = { people, account };
    localStorage.setItem("crm_google_account", JSON.stringify({ email: account.email, name: account.name || "", picture: account.picture || "" }));
    renderGoogleContactsPreview();
  } catch (err) {
    toast("Não foi possível conectar ao Google · " + err.message, true);
    sidePanel("Integrações", integrationsHtml(), { closeOnOverlay: true });
    wireIntegrations();
  }
}

function renderGoogleContactsPreview() {
  const people = googleContactsState.people || [];
  const rows = people.map((person, index) => {
    const mapped = googlePersonToContact(person);
    const existing = existingContactForGoogle(person);
    const company = mapped.google_company || {};
    return `<tr><td class="select-cell"><input class="google-contact-check" type="checkbox" data-index="${index}" checked></td>
      <td>${esc(mapped.name)}</td><td>${esc(mapped.email || "—")}</td><td>${esc(mapped.phone || "—")}</td><td>${esc(mapped.job_title || "—")}</td>
      <td>${esc(company.trade_name || "—")}</td><td>${esc(company.legal_name || "—")}</td><td>${esc(company.tax_id || "—")}</td>
      <td>${existing ? '<span class="badge b-lead">Atualizar</span>' : '<span class="badge b-open">Novo</span>'}</td><td class="table-actions-cell">${tableActionButtons()}</td></tr>`;
  }).join("");
  shell("Importar contatos do Google", `<div class="google-import-head">
      <div><strong>${esc(googleContactsState.account?.email || "Conta Google")}</strong><div class="muted">${people.length} contato(s) encontrado(s)</div></div>
      <label class="google-select-all"><input type="checkbox" id="google-select-all" checked> Selecionar todos</label>
    </div>
    <div class="google-import-fields"><strong>Dados importados</strong><span>As colunas seguem o De/Para salvo nas Integrações. Empresa, razão social e CNPJ são usados no vínculo com a empresa.</span></div>
    <div class="google-contact-list"><table><thead><tr><th></th><th>Nome</th><th>E-mail(s)</th><th>Telefone(s)</th><th>Cargo</th><th>Nome fantasia</th><th>Razão social</th><th>CNPJ</th><th>Situação</th>${tableActionsHead()}</tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">Nenhum contato encontrado.</td></tr>'}</tbody></table></div>
    <div class="modal-foot"><button class="btn" id="google-import-cancel">Cancelar</button><button class="btn primary" id="google-import-confirm"${people.length ? "" : " disabled"}>Importar selecionados</button></div>`, { cls: "full" });
  document.getElementById("google-select-all")?.addEventListener("change", (event) => {
    document.querySelectorAll(".google-contact-check").forEach((input) => { input.checked = event.target.checked; });
  });
  document.getElementById("google-import-cancel")?.addEventListener("click", closeModal);
  document.getElementById("google-import-confirm")?.addEventListener("click", importSelectedGoogleContacts);
}

async function importSelectedGoogleContacts() {
  const indexes = [...document.querySelectorAll(".google-contact-check:checked")].map((input) => Number(input.dataset.index));
  if (!indexes.length) { toast("Selecione ao menos um contato.", true); return; }
  const button = document.getElementById("google-import-confirm");
  button.disabled = true;
  let created = 0;
  let updated = 0;
  let companiesCreated = 0;
  try {
    for (const index of indexes) {
      const person = googleContactsState.people[index];
      const mapped = googlePersonToContact(person);
      const existing = existingContactForGoogle(person);
      const companyBefore = findImportedCompany(mapped.google_company);
      const company = await ensureGoogleCompany(mapped.google_company);
      if (!companyBefore && company) companiesCreated++;
      const contactBody = googleContactDatabaseBody(mapped);
      if (company) contactBody.company_id = company.tax_id;
      if (existing) {
        const patch = {
          google_resource_name: contactBody.google_resource_name,
          google_etag: contactBody.google_etag,
          google_synced_at: contactBody.google_synced_at
        };
        ["name", "phone", "email", "contact_type", "channel", "job_title", "department", "notes", "tags", "company_id", "linkedin", "facebook", "instagram", "reddit", "whatsapp", "youtube", "birth_date"].forEach((key) => {
          if (Array.isArray(contactBody[key]) ? contactBody[key].length : contactBody[key]) patch[key] = contactBody[key];
        });
        const saved = await updateRow("contacts", existing.id, patch);
        Object.assign(existing, saved || patch);
        if (company) await replaceContactCompanyLinks({
          contactId: existing.id,
          relatedIds: [...normalizeIdList(existing.company_ids), company.tax_id]
        });
        updated++;
      } else {
        const saved = await createRow("contacts", contactBody);
        if (company) await replaceContactCompanyLinks({ contactId: saved.id, relatedIds: [company.tax_id] });
        cache.contacts.push(saved);
        created++;
      }
      button.textContent = `Importando ${created + updated}/${indexes.length}`;
    }
    await init();
    state.tab = "contacts";
    state.view = "table";
    closeModal();
    render();
    toast(`${created} contato(s) criado(s), ${updated} atualizado(s) e ${companiesCreated} empresa(s) criada(s).`);
  } catch (err) {
    button.disabled = false;
    button.textContent = "Importar selecionados";
    toast("Erro ao importar contatos · " + err.message, true);
  }
}

async function disconnectGoogleAccount() {
  try {
    const token = await getGoogleAuthToken(false);
    await new Promise((resolve) => globalThis.chrome.identity.removeCachedAuthToken({ token }, resolve));
  } catch (e) {}
  localStorage.removeItem("crm_google_account");
  sidePanel("Integrações", integrationsHtml(), { closeOnOverlay: true });
  wireIntegrations();
  toast("Conta Google desconectada desta extensão.");
}

function currentUserIsAdmin() {
  return !isLive() || currentProfile?.role === "admin";
}

function currentUserCanUseChat() {
  if (!isLive()) return true;
  return currentProfile?.status === "active"
    && ["admin", "collaborator"].includes(normalizedProfileRole(currentProfile?.role));
}

function currentUserCan(moduleId, action = "view") {
  if (currentUserIsAdmin()) return true;
  if (!currentProfile || currentProfile.status !== "active") return false;
  if (["developer", "client"].includes(currentProfile.role) && action !== "view") return false;
  return Boolean(normalizeUserPermissions(currentProfile.permissions)[moduleId]?.[action]);
}

function requireCurrentUserPermission(moduleId, action = "view", area = modulePermissionLabel(moduleId)) {
  if (currentUserCan(moduleId, action)) return true;
  const actionLabel = PERMISSION_ACTIONS.find((item) => item.id === action)?.label || action;
  toast(`Sem permissão para ${actionLabel.toLocaleLowerCase("pt-BR")} em ${area}.`, true);
  return false;
}

function hasAnyModuleAccess(moduleIds) {
  return moduleIds.some((moduleId) => currentUserCan(moduleId, "view"));
}

function currentSessionLabel() {
  const session = readAuthSession();
  return currentProfile?.full_name || currentProfile?.email || session?.user?.email || "conta não identificada";
}

function requireCurrentUserAdmin(area = "Esta área") {
  if (currentUserIsAdmin()) return true;
  toast(`${area} disponível apenas para administradores. Sessão atual: ${currentSessionLabel()}.`, true);
  return false;
}

const TOOL_FOLDERS_KEY = "crm_tool_folders";
const TOOL_FILES_KEY = "crm_tool_files_v2";
const TOOL_EMAILS_KEY = "crm_tool_emails";
const TOOL_TABLES_KEY = "crm_tool_tables";
const TOOL_COLUMN_DEFS = {
  files: [
    { k: "status", h: "Status" }, { k: "client", h: "Cliente" }, { k: "company", h: "Empresa" },
    { k: "sector_1", h: "Setor 1" }, { k: "sector_2", h: "Setor 2" }, { k: "sector_3", h: "Setor 3" },
    { k: "sector_4", h: "Setor 4" }, { k: "sector_5", h: "Setor 5" }, { k: "file_reference", h: "Arquivo" },
    { k: "file_date", h: "Data" }
  ],
  emails: [{ k: "cnpj", h: "CNPJ" }, { k: "client", h: "Cliente" }, { k: "email", h: "Email" }, { k: "password", h: "Senha" }, { k: "tags", h: "Tags" }],
  processes: [
    { k: "title", h: "Nome do processo" }, { k: "category", h: "Categoria" }, { k: "system_name", h: "Canal" },
    { k: "module_name", h: "Módulo" }, { k: "submodule_name", h: "Submódulo" },
    { k: "tags", h: "Tags" }, { k: "steps", h: "Etapas" }
  ],
  documents: [
    { k: "title", h: "Nome" }, { k: "document_type", h: "Tipo" },
    { k: "category", h: "Categoria" }, { k: "system_name", h: "Canal" },
    { k: "module_name", h: "Módulo" }, { k: "submodule_name", h: "Submódulo" }, { k: "tags", h: "Tags" }, { k: "updated_at", h: "Atualizado em" }
  ],
  tables: [
    { k: "name", h: "Nome" }, { k: "category", h: "Categoria" }, { k: "system_name", h: "Canal" },
    { k: "module_name", h: "Módulo" }, { k: "submodule_name", h: "Submódulo" },
    { k: "sheet_count", h: "Abas" }, { k: "column_count", h: "Colunas" },
    { k: "row_count", h: "Linhas" }, { k: "updated_at", h: "Atualizado em" }
  ]
};
const TOOLS_PAGE_SIZE = 50;
const TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;
const TOOLS_CACHE_PREFIX = "crm_tools_cache_v1:";
let toolsState = { section: "files", search: "", tables: {} };
let remoteToolFiles = [];
let remoteToolFilesLoaded = false;
let remoteToolFilesLoading = false;
let remoteToolFilesError = "";
let remoteToolFilesLoadedAt = 0;
let remoteToolEmails = [];
let remoteToolEmailsLoaded = false;
let remoteToolEmailsLoading = false;
let remoteToolEmailsError = "";
let remoteToolEmailsLoadedAt = 0;
let remoteToolProcesses = [];
let remoteToolProcessesLoaded = false;
let remoteToolProcessesLoading = false;
let remoteToolProcessesError = "";
let remoteToolProcessesLoadedAt = 0;
let remoteToolDocuments = [];
let remoteToolDocumentsLoaded = false;
let remoteToolDocumentsLoading = false;
let remoteToolDocumentsError = "";
let remoteToolDocumentsLoadedAt = 0;
let remoteToolTables = [];
let remoteToolTablesLoaded = false;
let remoteToolTablesLoading = false;
let remoteToolTablesError = "";
let remoteToolTablesLoadedAt = 0;
const hydratedToolsCache = new Set();

function readToolsSessionCache(section) {
  try {
    const cached = JSON.parse(sessionStorage.getItem(`${TOOLS_CACHE_PREFIX}${section}`) || "null");
    return cached && Array.isArray(cached.rows) ? cached : null;
  } catch (e) {
    return null;
  }
}

function saveToolsSessionCache(section, rows, loadedAt = Date.now()) {
  if (!["files", "processes", "documents", "tables"].includes(section)) return;
  try {
    sessionStorage.setItem(`${TOOLS_CACHE_PREFIX}${section}`, JSON.stringify({ rows, loadedAt }));
  } catch (e) {}
}

function hydrateToolsSessionCache(section) {
  if (hydratedToolsCache.has(section) || !["files", "processes", "documents", "tables"].includes(section)) return;
  hydratedToolsCache.add(section);
  const cached = readToolsSessionCache(section);
  if (!cached) return;
  if (section === "files") {
    remoteToolFiles = cached.rows;
    remoteToolFilesLoaded = true;
    remoteToolFilesLoadedAt = Number(cached.loadedAt || 0);
  } else if (section === "processes") {
    remoteToolProcesses = cached.rows;
    remoteToolProcessesLoaded = true;
    remoteToolProcessesLoadedAt = Number(cached.loadedAt || 0);
  } else if (section === "documents") {
    remoteToolDocuments = cached.rows;
    remoteToolDocumentsLoaded = true;
    remoteToolDocumentsLoadedAt = Number(cached.loadedAt || 0);
  } else {
    remoteToolTables = cached.rows;
    remoteToolTablesLoaded = true;
    remoteToolTablesLoadedAt = Number(cached.loadedAt || 0);
  }
}

function toolsCacheIsStale(loaded, loadedAt) {
  return !loaded || !loadedAt || Date.now() - loadedAt > TOOLS_CACHE_TTL_MS;
}

function readToolRows(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

function saveToolRows(key, rows) {
  localStorage.setItem(key, JSON.stringify(rows));
}

function toolsDisabledFooter() {
  return `<div class="registrations-footer" aria-disabled="true">
    ${currentUserIsAdmin() ? '<button class="foot-btn" disabled>LOG</button>' : ""}
    <button class="foot-btn" disabled>AJUDA</button>
    <button class="foot-btn" disabled>CADASTROS</button>
    <button class="foot-btn" disabled>FERRAMENTAS</button>
    <button class="foot-btn" disabled>SOCIAL</button>
    <button class="foot-btn" disabled>ATUALIZAÇÕES</button>
  </div>`;
}

function openToolsModal(section = "files") {
  const available = ["files", "emails", "processes", "documents", "tables"].filter((id) => currentUserCan(id, "view"));
  if (!available.length) { toast("Você não possui acesso às Ferramentas.", true); return; }
  if (!available.includes(section)) section = available[0];
  if (toolsState.section !== section) toolsState.search = "";
  toolsState.section = section;
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Ferramentas">
    ${[["files", "Arquivos"], ["emails", "Emails"], ["processes", "Processos"], ["documents", "Documentação"], ["tables", "Tabelas"]].filter(([id]) => available.includes(id)).map(([id, label]) => `<button class="modal-header-tab${section === id ? " active" : ""}" data-tools-tab="${id}" role="tab">${label}</button>`).join("")}
  </div>`;
  shell("Ferramentas", `<div id="tools-root" class="tools-root"></div>${toolsDisabledFooter()}`, {
    cls: "full registrations-modal",
    headerCenter,
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CMS</b></span>'
  });
  document.querySelectorAll("[data-tools-tab]").forEach((button) => button.addEventListener("click", () => {
    toolsState.section = button.dataset.toolsTab;
    toolsState.search = "";
    toolTableState(toolsState.section).page = 1;
    document.querySelectorAll("[data-tools-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderToolsSection();
  }));
  renderToolsSection();
}

function visibleToolColumns(section = toolsState.section) {
  const prefs = secondaryColumnPrefs(`tools:${section}`);
  return orderedColumnDefinitions(TOOL_COLUMN_DEFS[section], prefs).filter((col) => prefs[col.k] !== false);
}

function toolTableState(section = toolsState.section) {
  if (!toolsState.tables[section]) toolsState.tables[section] = { sortKey: null, sortDir: 1, filters: {}, page: 1, pageSize: TOOLS_PAGE_SIZE };
  return toolsState.tables[section];
}

function paginateToolRows(rows, section = toolsState.section) {
  const tableState = toolTableState(section);
  const totalPages = Math.max(1, Math.ceil(rows.length / tableState.pageSize));
  tableState.page = Math.min(Math.max(1, tableState.page || 1), totalPages);
  const start = (tableState.page - 1) * tableState.pageSize;
  return { rows: rows.slice(start, start + tableState.pageSize), totalPages, start };
}

function toolsPaginationHtml(total, section = toolsState.section) {
  const tableState = toolTableState(section);
  const totalPages = Math.max(1, Math.ceil(total / tableState.pageSize));
  const start = total ? (tableState.page - 1) * tableState.pageSize + 1 : 0;
  const end = Math.min(tableState.page * tableState.pageSize, total);
  return `<div class="table-pagination tools-pagination"><span>${total ? `${start}-${end} de ${total}` : "0 registros"}</span>
    <div><button class="btn tools-page-prev"${tableState.page <= 1 ? " disabled" : ""}>‹</button><span>Página ${tableState.page} de ${totalPages}</span><button class="btn tools-page-next"${tableState.page >= totalPages ? " disabled" : ""}>›</button></div></div>`;
}

function wireToolsPagination(root, section = toolsState.section) {
  const tableState = toolTableState(section);
  root.querySelector(".tools-page-prev")?.addEventListener("click", () => {
    tableState.page -= 1;
    renderToolsSection();
  });
  root.querySelector(".tools-page-next")?.addEventListener("click", () => {
    tableState.page += 1;
    renderToolsSection();
  });
}

function toolEmailValue(account, key) {
  if (key === "password") return account.password ? "Disponível" : "Não disponível";
  if (key === "tags") return (account.tags || []).join(", ");
  return String(account[key] || "—");
}

function toolsToolbarHtml(count, addTitle, addId, canAdd = true, searchPlaceholder = "Buscar...") {
  return `<div class="tools-toolbar">
    <div class="registration-toolbar-left"><span class="registration-toolbar-title">Ferramentas</span><span class="muted">${count} item(ns)</span></div>
    <div class="registration-toolbar-center"><input class="search registration-toolbar-search tools-search" placeholder="${esc(searchPlaceholder)}" value="${esc(toolsState.search || "")}">${canAdd ? `<button class="btn primary plus" id="${addId}" title="${esc(addTitle)}">+</button>` : ""}</div>
    <div class="registration-toolbar-right"><button class="btn table-group-btn" type="button" title="Agrupar (indisponível nesta tabela)" disabled>≡</button><button class="btn tools-cols-btn" type="button" title="Selecionar colunas">⊞</button><button class="btn view-menu-trigger active" type="button" title="Modo de visualização: Tabela">${viewTriggerInner("table")}</button><button class="view" type="button" disabled title="Matriz" aria-label="Matriz">${viewButtonInner("matrix")}</button><button class="view" type="button" disabled title="Dashboard" aria-label="Dashboard">${viewButtonInner("dashboard")}</button><button class="btn tools-data-btn" type="button" title="Dados">⬆⬇</button></div>
  </div>`;
}

function wireToolsToolbar(root) {
  const input = root.querySelector(".tools-search");
  input?.addEventListener("input", (event) => {
    toolsState.search = event.target.value;
    toolTableState().page = 1;
    renderToolsSection();
    const next = document.querySelector("#tools-root .tools-search");
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  });
  root.querySelector(".tools-cols-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSecondaryColumnManager({
      scope: `tools:${toolsState.section}`,
      label: toolsState.section === "files" ? "Arquivos" : toolsState.section === "emails" ? "Emails" : toolsState.section === "processes" ? "Processos" : toolsState.section === "documents" ? "Documentação" : "Tabelas",
      definitions: TOOL_COLUMN_DEFS[toolsState.section],
      onChange: renderToolsSection
    });
  });
  root.querySelector(".tools-data-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openToolsDataMenu(event.currentTarget);
  });
}

function toolsDataSource(section = toolsState.section) {
  if (section === "files") return { rows: toolFileRows(), value: toolFileValue };
  if (section === "emails") return { rows: toolEmailRows(), value: toolEmailValue };
  if (section === "processes") return { rows: toolProcessRows(), value: toolProcessValue };
  if (section === "documents") return { rows: toolDocumentRows(), value: toolDocumentValue };
  return { rows: toolCustomTableRows(), value: toolCustomTableValue };
}

function exportToolsCSV() {
  const section = toolsState.section;
  const definitions = TOOL_COLUMN_DEFS[section];
  const source = toolsDataSource(section);
  const columns = definitions.map((column) => ({
    ...column,
    csv: (_value, row) => source.value(row, column.k)
  }));
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  downloadCSV(columns, source.rows, `enterpriser_ferramentas_${section}_${stamp}.csv`);
  toast(`CSV exportado: ${source.rows.length} linha(s).`);
}

function openToolsDataMenu(anchor) {
  document.getElementById("tools-data-dd")?.remove();
  const panel = document.createElement("div");
  panel.id = "tools-data-dd";
  panel.className = "data-dd";
  panel.innerHTML = `<div class="dd-head"><span>Dados</span><span>Ferramentas</span></div>
    <div class="dd-head"><span>Exportar</span><span>CSV</span></div>
    <button class="dd-menu-btn tools-export-all" type="button">Exportar todas as colunas</button>
    ${toolsState.section === "tables" && currentUserIsAdmin() ? '<div class="dd-head"><span>Importar</span><span>Nova tabela</span></div><button class="dd-menu-btn tools-import-table" type="button">CSV, XLS ou XLSX</button>' : ""}`;
  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.right = "auto";
  panel.style.left = `${Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.querySelector(".tools-export-all").addEventListener("click", () => { panel.remove(); exportToolsCSV(); });
  panel.querySelector(".tools-import-table")?.addEventListener("click", () => {
    panel.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) importCustomTableFile(file);
    }, { once: true });
    input.click();
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && event.target !== anchor) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function customTableSheetFromMatrix(matrix, name, index = 0) {
  const normalized = matrix.map((row) => Array.from(row || []));
  while (normalized.length && !normalized[normalized.length - 1].some((value) => String(value || "").trim())) normalized.pop();
  if (!normalized.length) return null;
  const width = Math.min(200, Math.max(...normalized.map((row) => row.length), 1));
  const header = normalized[0].slice(0, width);
  const usedNames = new Set();
  const columns = header.map((value, columnIndex) => {
    const base = String(value || "").trim() || `Coluna ${columnIndex + 1}`;
    let columnName = base;
    let suffix = 2;
    while (usedNames.has(columnName.toLocaleLowerCase("pt-BR"))) columnName = `${base} ${suffix++}`;
    usedNames.add(columnName.toLocaleLowerCase("pt-BR"));
    return { id: crypto.randomUUID(), name: columnName };
  });
  const rows = normalized.slice(1, 20001)
    .filter((row) => row.slice(0, width).some((value) => String(value || "").trim()))
    .map((row) => ({
      id: crypto.randomUUID(),
      cells: Object.fromEntries(columns.map((column, columnIndex) => [column.id, String(row[columnIndex] ?? "")]))
    }));
  return { id: crypto.randomUUID(), name: String(name || `Planilha ${index + 1}`).trim() || `Planilha ${index + 1}`, columns, rows };
}

async function importCustomTableFile(file) {
  if (!requireCurrentUserPermission("tables", "create", "Tabelas")) return;
  const parser = globalThis.XLSX;
  if (!parser?.read || !parser?.utils?.sheet_to_json) {
    toast("O leitor de planilhas ainda não foi carregado. Atualize a página e tente novamente.", true);
    return;
  }
  try {
    const workbook = parser.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const sheets = workbook.SheetNames.map((sheetName, index) => {
      const worksheet = workbook.Sheets[sheetName];
      const matrix = worksheet ? parser.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false }) : [];
      return customTableSheetFromMatrix(matrix, sheetName, index);
    }).filter(Boolean);
    if (!sheets.length) throw new Error("O arquivo não possui planilhas com dados.");
    const { columns, rows } = sheets[0];
    const name = file.name.replace(/\.(csv|xlsx?|xls)$/i, "").trim() || "Tabela importada";
    const body = { name, sheets, columns, rows, updated_at: new Date().toISOString() };
    let saved;
    if (isLive()) saved = await createRow("customTables", body);
    else {
      saved = { id: crypto.randomUUID(), ...body, created_at: new Date().toISOString() };
      saveToolRows(TOOL_TABLES_KEY, [saved, ...toolCustomTableRows()]);
    }
    if (isLive()) updateToolCustomTableCache(saved);
    renderToolsSection();
    const rowCount = sheets.reduce((total, sheet) => total + sheet.rows.length, 0);
    toast(`Tabela importada: ${sheets.length} aba(s) e ${rowCount} linha(s).`);
  } catch (err) {
    toast("Erro ao importar planilha · " + err.message, true);
  }
}

function renderToolsSection() {
  const root = document.getElementById("tools-root");
  if (!root) return;
  hydrateToolsSessionCache(toolsState.section);
  if (toolsState.section === "emails") renderToolEmails(root);
  else if (toolsState.section === "processes") renderToolProcesses(root);
  else if (toolsState.section === "documents") renderToolDocuments(root);
  else if (toolsState.section === "tables") renderToolCustomTables(root);
  else renderToolFolders(root);
}

const SOCIAL_MODULE_LABELS = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  tiktokshop: "TikTokShop",
  youtube: "YouTube"
};
const SOCIAL_COLUMN_DEFS = [
  { k: "profile", h: "Perfil" },
  { k: "status", h: "Status" },
  { k: "details", h: "Detalhes" },
  { k: "updated_at", h: "Atualizado em" }
];
let socialState = { section: "home", search: "", tables: {} };

function socialTableState(section = socialState.section) {
  if (!socialState.tables[section]) {
    socialState.tables[section] = { sortKey: null, sortDir: 1, filters: {}, page: 1, pageSize: TOOLS_PAGE_SIZE };
  }
  return socialState.tables[section];
}

function visibleSocialColumns(section = socialState.section) {
  const prefs = secondaryColumnPrefs(`social:${section}`);
  return orderedColumnDefinitions(SOCIAL_COLUMN_DEFS, prefs).filter((column) => prefs[column.k] !== false);
}

function openSocialModal(section = "home") {
  const available = Object.keys(SOCIAL_MODULE_LABELS).filter((id) => currentUserCan(id, "view"));
  if (!available.length) { toast("Você não possui acesso ao Social.", true); return; }
  socialState.section = section === "home" || available.includes(section) ? section : "home";
  socialState.search = "";
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Social">
    ${Object.entries(SOCIAL_MODULE_LABELS).filter(([id]) => available.includes(id)).map(([id, label]) => `<button class="modal-header-tab${id === socialState.section ? " active" : ""}" data-social-tab="${id}" role="tab">${label}</button>`).join("")}
  </div>`;
  shell("Social", `<div id="social-root" class="tools-root"></div>${toolsDisabledFooter()}`, {
    cls: "full registrations-modal",
    headerCenter,
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CMS</b></span>'
  });
  document.querySelectorAll("[data-social-tab]").forEach((button) => button.addEventListener("click", () => {
    socialState.section = button.dataset.socialTab;
    socialState.search = "";
    socialTableState().page = 1;
    document.querySelectorAll("[data-social-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderSocialSection();
  }));
  renderSocialSection();
}

function renderSocialHome(root) {
  root.innerHTML = `<div class="social-home-grid">${Object.entries(SOCIAL_CHANNEL_CONFIG).filter(([channel]) => currentUserCan(channel, "view")).map(([channel, config]) => {
    const username = socialChannelProfiles[channel] || "";
    const url = socialProfileUrl(channel, username);
    return `<section class="social-home-module">
      <header><div><strong>${esc(config.label)}</strong><span>${username ? "@" + esc(username) : "Não configurado"}</span></div>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Abrir ${esc(config.label)} em nova aba">↗</a>` : ""}</header>
      ${url ? `<iframe src="${esc(url)}" title="${esc(config.label)} · @${esc(username)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>` : '<div class="social-home-empty">Cadastre o username em Integrações.</div>'}
    </section>`;
  }).join("")}</div>`;
  if (!socialChannelProfilesLoaded) {
    loadSocialChannelProfiles().then(() => {
      if (socialState.section === "home" && document.getElementById("social-root")) renderSocialHome(root);
    }).catch((err) => toast("Erro ao carregar perfis sociais · " + err.message, true));
  }
}

function openSocialDataMenu(anchor) {
  document.getElementById("social-data-dd")?.remove();
  const panel = document.createElement("div");
  panel.id = "social-data-dd";
  panel.className = "data-dd";
  panel.innerHTML = `<div class="dd-head"><span>Dados</span><span>Social</span></div>
    <div class="dd-head"><span>Exportar</span><span>CSV</span></div>
    <button class="dd-menu-btn social-export-visible" type="button">Exportar colunas visíveis</button>
    <button class="dd-menu-btn social-export-all" type="button">Exportar todas as colunas</button>`;
  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.right = "auto";
  panel.style.left = `${Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  const exportCsv = (visibleOnly) => {
    panel.remove();
    const columns = (visibleOnly ? visibleSocialColumns() : SOCIAL_COLUMN_DEFS).map((column) => ({ ...column, csv: (_value, row) => row?.[column.k] ?? "" }));
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
    downloadCSV(columns, [], `enterpriser_social_${socialState.section}_${visibleOnly ? "colunas_visiveis" : "todas_colunas"}_${stamp}.csv`);
    toast("CSV exportado: 0 linha(s).");
  };
  panel.querySelector(".social-export-visible").addEventListener("click", () => exportCsv(true));
  panel.querySelector(".social-export-all").addEventListener("click", () => exportCsv(false));
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && event.target !== anchor) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function renderSocialSection() {
  const root = document.getElementById("social-root");
  if (!root) return;
  if (socialState.section === "home") { renderSocialHome(root); return; }
  const columns = visibleSocialColumns();
  const tableState = socialTableState();
  root.innerHTML = `<div class="tools-toolbar">
      <div class="registration-toolbar-left"><span class="registration-toolbar-title">Social</span><span class="muted">0 item(ns)</span></div>
      <div class="registration-toolbar-center"><input class="search registration-toolbar-search social-search" placeholder="Buscar..." value="${esc(socialState.search)}"><button class="btn primary plus" type="button" disabled title="Cadastro será definido">+</button></div>
      <div class="registration-toolbar-right"><button class="btn table-group-btn" type="button" title="Agrupar (indisponível nesta tabela)" disabled>≡</button><button class="btn social-cols-btn" type="button" title="Selecionar colunas">⊞</button><button class="btn view-menu-trigger active" type="button" title="Modo de visualização: Tabela">${viewTriggerInner("table")}</button><button class="view" type="button" disabled title="Matriz" aria-label="Matriz">${viewButtonInner("matrix")}</button><button class="view" type="button" disabled title="Dashboard" aria-label="Dashboard">${viewButtonInner("dashboard")}</button><button class="btn social-data-btn" type="button" title="Dados">⬆⬇</button></div>
    </div>
    <div class="registration-filter-strip tools-filter-strip"><div class="registration-filter-badges"></div><button class="filter-clear-all" type="button" hidden><span aria-hidden="true">×</span> Limpar tudo</button></div>
    <div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((column) => `<th data-social-key="${esc(column.k)}" title="Clique para ordenar.">${esc(column.h)}${tableState.sortKey === column.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}${tableActionsHead()}</tr></thead><tbody><tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhum registro em ${esc(SOCIAL_MODULE_LABELS[socialState.section])}.</td></tr></tbody></table></div>
    <div class="table-pagination tools-pagination"><span>0 registros</span><div><button class="btn" disabled>‹</button><span>Página 1 de 1</span><button class="btn" disabled>›</button></div></div>`;
  root.querySelector(".social-search")?.addEventListener("input", (event) => {
    socialState.search = event.target.value;
  });
  root.querySelector(".social-data-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSocialDataMenu(event.currentTarget);
  });
  root.querySelector(".social-cols-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSecondaryColumnManager({
      scope: `social:${socialState.section}`,
      label: SOCIAL_MODULE_LABELS[socialState.section],
      definitions: SOCIAL_COLUMN_DEFS,
      onChange: renderSocialSection
    });
  });
  root.querySelectorAll("th[data-social-key]").forEach((header) => header.addEventListener("click", () => {
    const key = header.dataset.socialKey;
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderSocialSection();
  }));
  wireSecondaryTableSelection(root.querySelector("table"), `social:${socialState.section}`);
}

const TOOL_FILE_STATUS_LABEL = { active: "Ativo", inactive: "Inativo", downloaded: "Baixado" };

function migrateLegacyToolFiles() {
  if (readToolRows(TOOL_FILES_KEY).length) return;
  const legacy = readToolRows(TOOL_FOLDERS_KEY);
  if (!legacy.length) return;
  saveToolRows(TOOL_FILES_KEY, legacy.map((folder) => ({
    id: folder.id || crypto.randomUUID(), status: "active", client: folder.description || null, company_id: null,
    sector_1: null, sector_2: null, sector_3: null, sector_4: null, sector_5: null,
    file_reference: folder.url || folder.name || "Arquivo", file_date: String(folder.updated_at || "").slice(0, 10) || null,
    created_at: folder.updated_at || new Date().toISOString(), updated_at: folder.updated_at || new Date().toISOString()
  })));
}

function toolFileRows() {
  if (isLive()) return remoteToolFiles;
  migrateLegacyToolFiles();
  return readToolRows(TOOL_FILES_KEY);
}

function toolFileCompany(file) {
  return cache?.companyById?.[file.company_id] || cache?.companies?.find((company) => company.tax_id === file.company_id) || null;
}

function toolFileValue(file, key) {
  if (key === "status") return TOOL_FILE_STATUS_LABEL[file.status] || file.status || "—";
  if (key === "company") {
    const company = toolFileCompany(file);
    return company?.trade_name || company?.legal_name || file.company_id || "—";
  }
  if (key === "file_date") return dt(file.file_date);
  return String(file[key] || "—");
}

function toolFileStatusBadge(status) {
  const tone = status === "active" ? "won" : status === "inactive" ? "lost" : "lead";
  return badge(tone, TOOL_FILE_STATUS_LABEL[status] || status || "—");
}

async function loadRemoteToolFiles({ force = false } = {}) {
  if (!isLive() || remoteToolFilesLoading) return;
  if (!force && !toolsCacheIsStale(remoteToolFilesLoaded, remoteToolFilesLoadedAt)) return;
  remoteToolFilesLoading = true;
  remoteToolFilesError = "";
  try {
    remoteToolFiles = await fetchTable("files");
    remoteToolFilesLoaded = true;
    remoteToolFilesLoadedAt = Date.now();
    saveToolsSessionCache("files", remoteToolFiles, remoteToolFilesLoadedAt);
  } catch (err) {
    remoteToolFilesError = err.message;
  } finally {
    remoteToolFilesLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "files") renderToolFolders(root);
  }
}

function renderToolFolders(root) {
  if (isLive() && !remoteToolFilesLoading && !remoteToolFilesError && toolsCacheIsStale(remoteToolFilesLoaded, remoteToolFilesLoadedAt)) loadRemoteToolFiles();
  const allFiles = toolFileRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("files");
  const files = allFiles.filter((file) => {
    const company = toolFileCompany(file);
    const companySearch = [company?.trade_name, company?.legal_name, company?.tax_id, file.company_id]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return (!query || companySearch) && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolFileValue(file, key))
    );
  });
  if (tableState.sortKey) {
    files.sort((a, b) => toolFileValue(a, tableState.sortKey).localeCompare(
      toolFileValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const page = paginateToolRows(files, "files");
  const columns = visibleToolColumns("files");
  const rows = page.rows.length ? page.rows.map((file) => `<tr data-id="${esc(file.id)}">
    ${columns.map((col) => {
      if (col.k === "status") return `<td>${toolFileStatusBadge(file.status)}</td>`;
      if (col.k === "file_reference") {
        const link = safeHttpUrl(file.file_reference);
        return `<td>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(file.file_reference)}</a>` : esc(file.file_reference || "—")}</td>`;
      }
      return `<td>${esc(toolFileValue(file, col.k))}</td>`;
    }).join("")}
    <td class="table-actions-cell">${tableActionButtons({
      open: safeHttpUrl(file.file_reference) ? { className: "tool-folder-open", attrs: { "data-id": file.id }, title: "Abrir arquivo" } : null,
      edit: { className: "tool-folder-edit", attrs: { "data-id": file.id }, title: "Editar arquivo", enabled: currentUserCan("files", "edit") },
      delete: { className: "tool-folder-delete", attrs: { "data-id": file.id }, title: "Excluir arquivo", enabled: currentUserCan("files", "delete") }
    })}</td>
  </tr>`).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhum arquivo cadastrado.</td></tr>`;
  root.innerHTML = `${toolsToolbarHtml(files.length, "Adicionar arquivo", "tool-folder-add", currentUserCan("files", "create"), "Buscar empresa...")}${toolFilterStrip("files", tableState, { loading: remoteToolFilesLoading, error: remoteToolFilesError })}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((col) => `<th data-tool-key="${esc(col.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(col.h)}${tableState.sortKey === col.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}${tableActionsHead()}</tr></thead><tbody>${rows}</tbody></table></div>${toolsPaginationHtml(files.length, "files")}`;
  wireToolsToolbar(root);
  wireToolsPagination(root, "files");
  wireToolsLoadRetry(root, "files");
  wireSecondaryTableSelection(root.querySelector("table"), "tools:files");
  document.getElementById("tool-folder-add")?.addEventListener("click", () => openToolFolderForm());
  root.querySelectorAll(".tool-folder-open").forEach((button) => button.addEventListener("click", () => openToolFolder(button.dataset.id)));
  root.querySelectorAll(".tool-folder-edit").forEach((button) => button.addEventListener("click", () => openToolFolderForm(button.dataset.id)));
  root.querySelectorAll(".tool-folder-delete").forEach((button) => button.addEventListener("click", () => deleteToolFolder(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allFiles, toolFileValue, "files"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((filter) => filter.addEventListener("click", () => {
    delete tableState.filters[filter.dataset.key]; renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => { tableState.filters = {}; renderToolsSection(); });
}

function openToolFolder(id) {
  const file = toolFileRows().find((item) => item.id === id);
  const url = safeHttpUrl(file?.file_reference);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function closeToolFilePanel(closePanel) {
  closePanel?.();
  if (document.getElementById("tools-root")) renderToolsSection();
  else openToolsModal("files");
}

function openToolFolderForm(id = null) {
  if (!requireCurrentUserPermission("files", id ? "edit" : "create", "Arquivos")) return;
  const current = toolFileRows().find((item) => item.id === id) || {};
  const companyPicker = singleSearchPickerHtml("tool-file-company", companyRefOptions(cache), current.company_id, "Buscar por nome ou CNPJ");
  const content = `<div class="form">
    <div class="field"><label>Status *</label><select id="tool-file-status"><option value="active"${(current.status || "active") === "active" ? " selected" : ""}>Ativo</option><option value="inactive"${current.status === "inactive" ? " selected" : ""}>Inativo</option><option value="downloaded"${current.status === "downloaded" ? " selected" : ""}>Baixado</option></select></div>
    <div class="field"><label>Cliente</label><input id="tool-file-client" value="${esc(current.client || "")}"></div>
    <div class="field full"><label>Empresa *</label>${companyPicker}</div>
    ${[1, 2, 3, 4, 5].map((number) => `<div class="field"><label>Setor ${number}</label><input id="tool-file-sector-${number}" value="${esc(current[`sector_${number}`] || "")}"></div>`).join("")}
    <div class="field full"><label>Arquivo *</label><input id="tool-file-reference" value="${esc(current.file_reference || "")}" placeholder="Nome, caminho ou link do arquivo"></div>
    <div class="field"><label>Data</label><input id="tool-file-date" type="date" value="${esc(current.file_date || isoDay(new Date()))}"></div>
  </div><div class="modal-foot"><button class="btn" id="tool-folder-cancel">Cancelar</button><button class="btn primary" id="tool-folder-save">Salvar</button></div>`;
  const closePanel = document.getElementById("tools-root")
    ? nestedSidePanel(id ? "Editar arquivo" : "Novo arquivo", content, { closeOnOverlay: true })
    : sidePanel(id ? "Editar arquivo" : "Novo arquivo", content, { closeOnOverlay: true, onClose: () => openToolsModal("files") });
  wireSingleSearchPicker("tool-file-company");
  document.getElementById("tool-folder-cancel").addEventListener("click", () => closeToolFilePanel(closePanel));
  document.getElementById("tool-folder-save").addEventListener("click", async () => {
    const companyId = document.querySelector("#tool-file-company input[type=hidden]").value;
    const fileReference = document.getElementById("tool-file-reference").value.trim();
    if (!companyId) { toast("Selecione uma empresa pela busca.", true); return; }
    if (!fileReference) { toast("Informe o arquivo.", true); return; }
    const button = document.getElementById("tool-folder-save");
    button.disabled = true; button.textContent = "Salvando...";
    const body = {
      status: document.getElementById("tool-file-status").value,
      client: document.getElementById("tool-file-client").value.trim() || null,
      company_id: companyId,
      ...Object.fromEntries([1, 2, 3, 4, 5].map((number) => [`sector_${number}`, document.getElementById(`tool-file-sector-${number}`).value.trim() || null])),
      file_reference: fileReference,
      file_date: document.getElementById("tool-file-date").value || null,
      updated_at: new Date().toISOString()
    };
    try {
      let saved;
      if (isLive()) saved = id ? await updateRow("files", id, body) : await createRow("files", body);
      else {
        const localRows = toolFileRows();
        saved = { id: current.id || crypto.randomUUID(), ...current, ...body, created_at: current.created_at || new Date().toISOString() };
        const index = localRows.findIndex((row) => row.id === saved.id);
        if (index >= 0) localRows[index] = saved; else localRows.unshift(saved);
        saveToolRows(TOOL_FILES_KEY, localRows);
      }
      if (isLive()) {
        const index = remoteToolFiles.findIndex((item) => item.id === saved.id);
        if (index >= 0) remoteToolFiles[index] = saved; else remoteToolFiles.unshift(saved);
        remoteToolFilesLoaded = true;
        remoteToolFilesLoadedAt = Date.now();
        saveToolsSessionCache("files", remoteToolFiles, remoteToolFilesLoadedAt);
      }
      toast("Arquivo salvo.");
      closeToolFilePanel(closePanel);
    } catch (err) {
      button.disabled = false; button.textContent = "Salvar";
      toast("Erro ao salvar arquivo · " + err.message, true);
    }
  });
}

async function deleteToolFolder(id) {
  if (!requireCurrentUserPermission("files", "delete", "Arquivos")) return;
  const rows = toolFileRows();
  const file = rows.find((item) => item.id === id);
  if (!file || !window.confirm(`Excluir o arquivo "${file.file_reference}"?`)) return;
  try {
    if (isLive()) {
      await deleteRow("files", id);
      remoteToolFiles = remoteToolFiles.filter((item) => item.id !== id);
      remoteToolFilesLoadedAt = Date.now();
      saveToolsSessionCache("files", remoteToolFiles, remoteToolFilesLoadedAt);
    } else saveToolRows(TOOL_FILES_KEY, rows.filter((item) => item.id !== id));
    renderToolsSection();
    toast("Arquivo excluído.");
  } catch (err) { toast("Erro ao excluir arquivo · " + err.message, true); }
}

function normalizeProcessSteps(value) {
  let steps = value;
  if (typeof steps === "string") {
    try { steps = JSON.parse(steps); } catch (e) { steps = []; }
  }
  return Array.isArray(steps) ? steps.map((step) => ({
    id: String(step?.id || crypto.randomUUID()),
    system: String(step?.system || "").trim(),
    module: String(step?.module || step?.title || "").trim(),
    submodule: String(step?.submodule || "").trim(),
    group: String(step?.group || "").trim(),
    type: String(step?.type || "").trim(),
    url: String(step?.url || "").trim(),
    details: String(step?.details || step?.instruction || "").trim(),
    element: PROCESS_ELEMENTS[step?.element] ? step.element : "task",
    label: String(step?.label || "").trim(),
    responsible: String(step?.responsible || "").trim(),
    next: String(step?.next || "").trim(),
    outcomes: (Array.isArray(step?.outcomes) ? step.outcomes : []).map((outcome) => ({
      id: String(outcome?.id || crypto.randomUUID()),
      label: String(outcome?.label || "").trim(),
      target: String(outcome?.target || "").trim()
    }))
  })) : [];
}

function toolProcessRows() {
  return isLive() ? remoteToolProcesses : (DEMO.processes || []);
}

function toolProcessValue(process, key) {
  if (key === "steps") return String(normalizeProcessSteps(process.steps).length);
  if (key === "tags") return normalizeTextList(process.tags).join(", ");
  return String(process[key] || "—");
}

async function loadRemoteToolProcesses({ force = false } = {}) {
  if (!isLive() || remoteToolProcessesLoading) return;
  if (!force && !toolsCacheIsStale(remoteToolProcessesLoaded, remoteToolProcessesLoadedAt)) return;
  remoteToolProcessesLoading = true;
  remoteToolProcessesError = "";
  try {
    remoteToolProcesses = await fetchTable("processes");
    remoteToolProcessesLoaded = true;
    remoteToolProcessesLoadedAt = Date.now();
    saveToolsSessionCache("processes", remoteToolProcesses, remoteToolProcessesLoadedAt);
  } catch (err) {
    remoteToolProcessesError = err.message;
  } finally {
    remoteToolProcessesLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "processes") renderToolProcesses(root);
  }
}

function toolFilterStrip(section, tableState, { loading = false, error = "" } = {}) {
  const activeFilters = Object.entries(tableState.filters).filter(([, values]) => values?.size);
  return `<div class="registration-filter-strip tools-filter-strip${loading ? " is-loading" : ""}"><div class="registration-filter-badges">${activeFilters.map(([key, values]) => {
    const label = TOOL_COLUMN_DEFS[section].find((col) => col.k === key)?.h || key;
    return `<button class="registration-filter-badge tool-filter-badge" data-key="${esc(key)}" title="Limpar filtro"><span>${esc(label)}: ${esc([...values].join(", "))}</span><b>×</b></button>`;
  }).join("")}</div>${error ? '<button class="tool-load-retry" type="button">Falha ao atualizar · Tentar novamente</button>' : ""}<button class="filter-clear-all tool-filter-clear-all" type="button"${activeFilters.length < 2 ? " hidden" : ""}><span aria-hidden="true">×</span> Limpar tudo</button>${loading ? '<div class="tools-loading-progress" role="progressbar" aria-label="Atualizando dados"><span></span></div>' : ""}</div>`;
}

function wireToolsLoadRetry(root, section = toolsState.section) {
  root.querySelector(".tool-load-retry")?.addEventListener("click", () => {
    if (section === "files") {
      remoteToolFilesError = "";
      loadRemoteToolFiles({ force: true });
    } else if (section === "emails") {
      remoteToolEmailsError = "";
      loadRemoteToolEmails({ force: true });
    } else if (section === "processes") {
      remoteToolProcessesError = "";
      loadRemoteToolProcesses({ force: true });
    } else if (section === "documents") {
      remoteToolDocumentsError = "";
      loadRemoteToolDocuments({ force: true });
    } else if (section === "tables") {
      remoteToolTablesError = "";
      loadRemoteToolTables({ force: true });
    }
    renderToolsSection();
  });
}

function renderToolProcesses(root) {
  if (isLive() && !remoteToolProcessesLoading && !remoteToolProcessesError && toolsCacheIsStale(remoteToolProcessesLoaded, remoteToolProcessesLoadedAt)) loadRemoteToolProcesses();
  const allProcesses = toolProcessRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("processes");
  const processes = allProcesses.filter((process) => {
    const stepValues = normalizeProcessSteps(process.steps).flatMap((step) =>
      [step.system, step.module, step.submodule, step.group, step.type, step.url, step.details]
    );
    const searchable = [process.title, process.category, process.system_name, process.module_name, process.submodule_name, ...normalizeTextList(process.tags), ...stepValues];
    const matchesSearch = !query || searchable.some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolProcessValue(process, key))
    );
  });
  if (tableState.sortKey) {
    processes.sort((a, b) => toolProcessValue(a, tableState.sortKey).localeCompare(
      toolProcessValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const page = paginateToolRows(processes, "processes");
  const columns = visibleToolColumns("processes");
  const rows = page.rows.length ? page.rows.map((process) => `<tr data-id="${esc(process.id)}">
    ${columns.map((col) => {
      if (col.k === "title") return `<td><button class="process-open-link" data-id="${esc(process.id)}">${esc(process.title || "—")}</button></td>`;
      if (col.k === "tags") return `<td><span class="tool-tags">${normalizeTextList(process.tags).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("") || '<span class="muted">—</span>'}</span></td>`;
      if (col.k === "steps") return `<td>${normalizeProcessSteps(process.steps).length} etapa(s)</td>`;
      return `<td>${esc(toolProcessValue(process, col.k))}</td>`;
    }).join("")}
    <td class="table-actions-cell">${tableActionButtons({
      open: { className: "tool-process-flow", attrs: { "data-id": process.id }, title: "Abrir fluxo visual" },
      edit: { className: "tool-process-edit", attrs: { "data-id": process.id }, title: "Editar processo", enabled: currentUserCan("processes", "edit") },
      delete: { className: "tool-process-delete", attrs: { "data-id": process.id }, title: "Excluir processo", enabled: currentUserCan("processes", "delete") }
    })}</td>
  </tr>`).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhum processo cadastrado.</td></tr>`;
  root.innerHTML = `${toolsToolbarHtml(processes.length, "Adicionar processo", "tool-process-add", currentUserCan("processes", "create"))}${toolFilterStrip("processes", tableState, { loading: remoteToolProcessesLoading, error: remoteToolProcessesError })}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((col) => `<th data-tool-key="${esc(col.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(col.h)}${tableState.sortKey === col.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}${tableActionsHead()}</tr></thead><tbody>${rows}</tbody></table></div>${toolsPaginationHtml(processes.length, "processes")}`;
  wireToolsToolbar(root);
  wireToolsPagination(root, "processes");
  wireToolsLoadRetry(root, "processes");
  wireSecondaryTableSelection(root.querySelector("table"), "tools:processes");
  document.getElementById("tool-process-add")?.addEventListener("click", () => openToolProcessForm());
  root.querySelectorAll(".tool-process-flow").forEach((button) => button.addEventListener("click", () => openToolProcessFlow(button.dataset.id)));
  root.querySelectorAll(".process-open-link,.tool-process-open").forEach((button) => button.addEventListener("click", () => openToolProcess(button.dataset.id)));
  root.querySelectorAll(".tool-process-edit").forEach((button) => button.addEventListener("click", () => openToolProcessForm(button.dataset.id)));
  root.querySelectorAll(".tool-process-delete").forEach((button) => button.addEventListener("click", () => deleteToolProcess(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allProcesses, toolProcessValue, "processes"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((filter) => filter.addEventListener("click", () => {
    delete tableState.filters[filter.dataset.key]; renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => { tableState.filters = {}; renderToolsSection(); });
}

function toolDocumentRows() {
  return isLive() ? remoteToolDocuments : (DEMO.documents || []);
}

function sanitizeDocumentHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  const allowedTags = new Set(["DIV", "P", "BR", "STRONG", "B", "EM", "I", "SPAN", "FONT", "H1", "H2", "H3", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "PRE", "CODE", "A"]);
  const blockedTags = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);
  [...template.content.querySelectorAll("*")].forEach((element) => {
    if (blockedTags.has(element.tagName)) { element.remove(); return; }
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      return;
    }
    const color = element.style.color || element.getAttribute("color") || "";
    const backgroundColor = element.style.backgroundColor || "";
    const textAlign = element.style.textAlign || element.getAttribute("align") || "";
    const href = element.tagName === "A" ? safeHttpUrl(element.getAttribute("href")) : "";
    [...element.attributes].forEach((attribute) => element.removeAttribute(attribute.name));
    if (color && CSS.supports("color", color)) element.style.color = color;
    if (backgroundColor && CSS.supports("color", backgroundColor)) element.style.backgroundColor = backgroundColor;
    if (["left", "center", "right", "justify"].includes(textAlign)) element.style.textAlign = textAlign;
    if (href) {
      element.setAttribute("href", href);
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener");
    }
  });
  return template.innerHTML;
}

const DOCUMENT_BLOCK_TYPES = {
  text: "Texto",
  heading: "Título",
  table: "Tabela",
  list: "Lista",
  code: "Código",
  note: "Observação",
  rule: "Regra",
  warning: "Atenção",
  example: "Exemplo",
  link: "Link"
};
const DOCUMENT_TYPE_LABELS = {
  documentation: "Documentação",
  procedure: "Procedimento",
  specification: "Especificação"
};

function documentGeneratedTitle(documentItem) {
  const type = DOCUMENT_TYPE_LABELS[documentItem.document_type] || DOCUMENT_TYPE_LABELS.documentation;
  return [
    documentItem.category || "Sem categoria",
    documentItem.system_name || "ENTERPRISER CMS",
    documentItem.module_name || "Geral",
    documentItem.submodule_name,
    type
  ].map((value) => String(value || "").trim()).filter(Boolean).map((value) => value.toLocaleUpperCase("pt-BR")).join(" | ");
}

function normalizeDocumentBlock(block, fallbackHtml = "") {
  const type = DOCUMENT_BLOCK_TYPES[block?.type] ? block.type : "text";
  return {
    id: String(block?.id || crypto.randomUUID()),
    type,
    span: Math.min(6, Math.max(1, Number(block?.span) || 6)),
    html: sanitizeDocumentHtml(block?.html || fallbackHtml || "")
  };
}

function documentBlockStarterHtml(type) {
  if (type === "heading") return "Título da seção";
  if (type === "table") return "<table><thead><tr><th>Campo</th><th>Descrição</th></tr></thead><tbody><tr><td>Campo</td><td>Descrição</td></tr></tbody></table>";
  if (type === "list") return "<ul><li>Item da lista</li></ul>";
  if (type === "code") return "<pre><code>GET /api/v1/recurso</code></pre>";
  if (type === "link") return "https://";
  return "";
}

function normalizeDocumentSlides(value, fallbackContent = "", fallbackTitle = "") {
  let slides = value;
  if (typeof slides === "string") {
    try { slides = JSON.parse(slides); } catch (e) { slides = []; }
  }
  if (!Array.isArray(slides) || !slides.length) {
    slides = [{ id: crypto.randomUUID(), title: fallbackTitle || "Página 1", html: esc(fallbackContent || "").replace(/\r?\n/g, "<br>"), background: "#ffffff" }];
  }
  return slides.map((slide, index) => {
    const legacyHtml = sanitizeDocumentHtml(slide?.html || "");
    const blocks = Array.isArray(slide?.blocks) && slide.blocks.length
      ? slide.blocks.map((block) => normalizeDocumentBlock(block))
      : [normalizeDocumentBlock({ type: "text", span: 6, html: legacyHtml })];
    const title = String(slide?.subject || slide?.title || `Página ${index + 1}`).trim();
    const breadcrumbParts = Array.isArray(slide?.breadcrumb_parts)
      ? slide.breadcrumb_parts.map((item) => String(item || "").trim()).filter(Boolean)
      : String(slide?.breadcrumb || "").split(">").map((item) => item.trim()).filter(Boolean);
    return {
      id: String(slide?.id || crypto.randomUUID()),
      title,
      subject: title,
      breadcrumb: String(slide?.breadcrumb || "").trim(),
      breadcrumb_parts: Array.isArray(slide?.breadcrumb_parts) || breadcrumbParts.length ? breadcrumbParts : null,
      breadcrumb_url: String(slide?.breadcrumb_url || "").trim(),
      blocks,
      html: blocks.map((block) => block.html).join("<br>"),
      background: CSS.supports("color", String(slide?.background || "")) ? String(slide.background) : "#ffffff",
      group: String(slide?.group || "Geral").trim() || "Geral"
    };
  });
}

function documentSlideGroups(slides) {
  const groups = new Map();
  slides.forEach((slide, index) => {
    if (!groups.has(slide.group)) groups.set(slide.group, []);
    groups.get(slide.group).push({ slide, index });
  });
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

function documentSlideText(slides) {
  const template = document.createElement("template");
  return normalizeDocumentSlides(slides).map((slide) => {
    const blockText = slide.blocks.map((block) => {
      template.innerHTML = block.html;
      return template.content.textContent || "";
    }).join(" ");
    return [slide.subject, documentPageBreadcrumbParts({}, slide).join(" "), slide.breadcrumb_url, blockText].join(" ");
  }).join("\n");
}

function toolDocumentValue(documentItem, key) {
  if (key === "title") return documentGeneratedTitle(documentItem);
  if (key === "tags") return normalizeTextList(documentItem.tags).join(", ");
  if (key === "orientation") return documentOrientation(documentItem) === "portrait" ? "Retrato" : "Paisagem";
  if (key === "document_type") return DOCUMENT_TYPE_LABELS[documentItem.document_type] || DOCUMENT_TYPE_LABELS.documentation;
  if (key === "system_name") return String(documentItem.system_name || "ENTERPRISER CMS");
  if (key === "updated_at") return documentItem.updated_at
    ? new Date(documentItem.updated_at).toLocaleString("pt-BR")
    : "—";
  return String(documentItem[key] || "—");
}

async function loadRemoteToolDocuments({ force = false } = {}) {
  if (!isLive() || remoteToolDocumentsLoading) return;
  if (!force && !toolsCacheIsStale(remoteToolDocumentsLoaded, remoteToolDocumentsLoadedAt)) return;
  remoteToolDocumentsLoading = true;
  remoteToolDocumentsError = "";
  try {
    remoteToolDocuments = await fetchTable("documents");
    remoteToolDocumentsLoaded = true;
    remoteToolDocumentsLoadedAt = Date.now();
    saveToolsSessionCache("documents", remoteToolDocuments, remoteToolDocumentsLoadedAt);
  } catch (err) {
    remoteToolDocumentsError = err.message;
  } finally {
    remoteToolDocumentsLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "documents") renderToolDocuments(root);
  }
}

function renderToolDocuments(root) {
  if (isLive() && !remoteToolDocumentsLoading && !remoteToolDocumentsError && toolsCacheIsStale(remoteToolDocumentsLoaded, remoteToolDocumentsLoadedAt)) loadRemoteToolDocuments();
  const allDocuments = toolDocumentRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("documents");
  const documents = allDocuments.filter((documentItem) => {
    const searchable = [toolDocumentValue(documentItem, "title"), documentItem.system_name, documentItem.module_name, documentItem.submodule_name, toolDocumentValue(documentItem, "document_type"), documentItem.category, documentItem.content, documentSlideText(documentItem.slides), ...normalizeTextList(documentItem.tags)];
    const matchesSearch = !query || searchable.some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolDocumentValue(documentItem, key))
    );
  });
  if (tableState.sortKey) {
    documents.sort((a, b) => toolDocumentValue(a, tableState.sortKey).localeCompare(
      toolDocumentValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const grouped = Boolean(toolsState.groupDocuments);
  const groupKey = (documentItem) => [documentItem.category, documentItem.system_name || "ENTERPRISER CMS", documentItem.module_name]
    .map((value) => String(value || "—").trim().toLocaleUpperCase("pt-BR")).join(" | ");
  if (grouped) {
    const order = new Map();
    documents.forEach((documentItem) => { const key = groupKey(documentItem); if (!order.has(key)) order.set(key, order.size); });
    documents.sort((a, b) => order.get(groupKey(a)) - order.get(groupKey(b)));
  }
  const groupCounts = documents.reduce((counts, documentItem) => counts.set(groupKey(documentItem), (counts.get(groupKey(documentItem)) || 0) + 1), new Map());
  const page = paginateToolRows(documents, "documents");
  const columns = visibleToolColumns("documents");
  let previousGroup = null;
  const rows = page.rows.length ? page.rows.map((documentItem) => {
    const key = groupKey(documentItem);
    const groupId = `doc-group:${key}`;
    const header = grouped && key !== previousGroup
      ? `<tr class="client-group-row tool-group-row" data-group-row="true" data-expand-id="${esc(groupId)}">${columns.map((col, index) => index === 0
        ? `<td><button class="client-group-toggle tool-group-toggle" type="button" title="Expandir/recolher ${esc(key)}"><strong>${esc(key)}</strong><span class="registration-subtask-count">${groupCounts.get(key) || 0}</span></button></td>`
        : "<td></td>").join("")}<td class="table-actions-cell"></td></tr>`
      : "";
    previousGroup = key;
    return header + `<tr data-id="${esc(documentItem.id)}"${grouped ? ` data-expand-parent="${esc(groupId)}" hidden` : ""}>
    ${columns.map((col) => {
      if (col.k === "title") return `<td><button class="process-open-link tool-document-open" data-id="${esc(documentItem.id)}">${esc(toolDocumentValue(documentItem, "title"))}</button></td>`;
      if (col.k === "tags") return `<td><span class="tool-tags">${normalizeTextList(documentItem.tags).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("") || '<span class="muted">—</span>'}</span></td>`;
      return `<td>${esc(toolDocumentValue(documentItem, col.k))}</td>`;
    }).join("")}
    <td class="table-actions-cell">${tableActionButtons({
      open: { className: "tool-document-open", attrs: { "data-id": documentItem.id }, title: "Abrir documentação" },
      edit: { className: "tool-document-edit", attrs: { "data-id": documentItem.id }, title: "Editar documentação", enabled: currentUserCan("documents", "edit") },
      clone: { className: "tool-document-clone", attrs: { "data-id": documentItem.id }, title: "Clonar documentação", enabled: currentUserCan("documents", "clone") },
      delete: { className: "tool-document-delete", attrs: { "data-id": documentItem.id }, title: "Excluir documentação", enabled: currentUserCan("documents", "delete") }
    })}</td>
  </tr>`;
  }).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhuma documentação cadastrada.</td></tr>`;
  root.innerHTML = `${toolsToolbarHtml(documents.length, "Adicionar documentação", "tool-document-add", currentUserCan("documents", "create"))}${toolFilterStrip("documents", tableState, { loading: remoteToolDocumentsLoading, error: remoteToolDocumentsError })}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((col) => `<th data-tool-key="${esc(col.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(col.h)}${tableState.sortKey === col.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}${tableActionsHead()}</tr></thead><tbody>${rows}</tbody></table></div>${toolsPaginationHtml(documents.length, "documents")}`;
  wireToolsToolbar(root);
  wireToolsPagination(root, "documents");
  wireToolsLoadRetry(root, "documents");
  wireSecondaryTableSelection(root.querySelector("table"), "tools:documents");
  const groupButton = root.querySelector(".table-group-btn");
  if (groupButton) {
    groupButton.disabled = false;
    groupButton.title = grouped ? "Desagrupar" : "Agrupar por Categoria, Canal e Módulo";
    groupButton.setAttribute("aria-pressed", String(grouped));
    groupButton.classList.toggle("active", grouped);
    groupButton.addEventListener("click", () => {
      toolsState.groupDocuments = !toolsState.groupDocuments;
      renderToolsSection();
    });
  }
  root.querySelectorAll(".tool-group-toggle").forEach((button) => button.addEventListener("click", () =>
    button.closest("tr")?.querySelector(":scope > .expand-cell .table-row-expand")?.click()));
  document.getElementById("tool-document-add")?.addEventListener("click", () => openToolDocumentForm());
  root.querySelectorAll(".tool-document-open").forEach((button) => button.addEventListener("click", () => openToolDocument(button.dataset.id)));
  root.querySelectorAll(".tool-document-edit").forEach((button) => button.addEventListener("click", () => openToolDocumentForm(button.dataset.id)));
  root.querySelectorAll(".tool-document-clone").forEach((button) => button.addEventListener("click", () => cloneToolDocument(button.dataset.id)));
  root.querySelectorAll(".tool-document-delete").forEach((button) => button.addEventListener("click", () => deleteToolDocument(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allDocuments, toolDocumentValue, "documents"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((filter) => filter.addEventListener("click", () => {
    delete tableState.filters[filter.dataset.key]; renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => { tableState.filters = {}; renderToolsSection(); });
}

const CUSTOM_TABLE_DEFAULT_WIDTH = 190;
const CUSTOM_TABLE_MIN_WIDTH = 80;
const CUSTOM_TABLE_MAX_WIDTH = 800;
const CUSTOM_TABLE_INDEX_WIDTH = 44;
const customTableColumnWidth = (column) => column?.width || CUSTOM_TABLE_DEFAULT_WIDTH;
// Nome do arquivo montado pela estrutura: CATEGORIA | CANAL | MÓDULO | SUBMÓDULO | NOME.
function customTableStructuredName(table) {
  return [table.category, table.system_name, table.module_name, table.submodule_name, table.base_name]
    .map((value) => String(value || "").trim()).filter(Boolean).map((value) => value.toLocaleUpperCase("pt-BR")).join(" | ");
}

function normalizeCustomTableColumns(value) {
  let columns = value;
  if (typeof columns === "string") {
    try { columns = JSON.parse(columns); } catch (e) { columns = []; }
  }
  if (!Array.isArray(columns) || !columns.length) columns = [{ name: "Coluna 1" }];
  return columns.map((column, index) => {
    const width = Number(column?.width);
    return {
      id: String(column?.id || crypto.randomUUID()),
      name: String(column?.name || `Coluna ${index + 1}`).trim() || `Coluna ${index + 1}`,
      ...(Number.isFinite(width) && width > 0 ? { width: Math.round(Math.min(CUSTOM_TABLE_MAX_WIDTH, Math.max(CUSTOM_TABLE_MIN_WIDTH, width))) } : {})
    };
  });
}

function normalizeCustomTableRows(value, columns) {
  let rows = value;
  if (typeof rows === "string") {
    try { rows = JSON.parse(rows); } catch (e) { rows = []; }
  }
  if (!Array.isArray(rows)) rows = [];
  return rows.map((row) => {
    const source = row?.cells && typeof row.cells === "object" ? row.cells : row || {};
    return {
      id: String(row?.id || crypto.randomUUID()),
      cells: Object.fromEntries(columns.map((column) => [column.id, String(source[column.id] ?? "")]))
    };
  });
}

function normalizeCustomTableSheets(value, fallbackColumns, fallbackRows) {
  let sheets = value;
  if (typeof sheets === "string") {
    try { sheets = JSON.parse(sheets); } catch (e) { sheets = []; }
  }
  if (!Array.isArray(sheets) || !sheets.length) {
    sheets = [{ name: "Planilha 1", columns: fallbackColumns, rows: fallbackRows }];
  }
  return sheets.map((sheet, index) => {
    const columns = normalizeCustomTableColumns(sheet?.columns);
    return {
      id: String(sheet?.id || crypto.randomUUID()),
      name: String(sheet?.name || `Planilha ${index + 1}`).trim() || `Planilha ${index + 1}`,
      columns,
      rows: normalizeCustomTableRows(sheet?.rows, columns),
      frozen: Math.max(0, Math.min(columns.length, Math.floor(Number(sheet?.frozen) || 0)))
    };
  });
}

function normalizeCustomTable(item = {}) {
  const legacyColumns = normalizeCustomTableColumns(item.columns);
  const sheets = normalizeCustomTableSheets(item.sheets, legacyColumns, item.rows);
  const name = String(item.name || "Nova tabela").trim() || "Nova tabela";
  return {
    ...item,
    name,
    base_name: String(item.base_name || "").trim() || (item.use_structured_name ? "" : name),
    use_structured_name: Boolean(item.use_structured_name),
    sheets,
    columns: sheets[0].columns,
    rows: sheets[0].rows
  };
}

function toolCustomTableRows() {
  const source = isLive() ? remoteToolTables : readToolRows(TOOL_TABLES_KEY);
  return source.map(normalizeCustomTable);
}

function toolCustomTableValue(item, key) {
  const table = normalizeCustomTable(item);
  if (key === "sheet_count") return String(table.sheets.length);
  if (key === "column_count") return String(Math.max(...table.sheets.map((sheet) => sheet.columns.length), 0));
  if (key === "row_count") return String(table.sheets.reduce((total, sheet) => total + sheet.rows.length, 0));
  if (key === "updated_at") return item.updated_at ? new Date(item.updated_at).toLocaleString("pt-BR") : "—";
  return String(item[key] || "—");
}

async function loadRemoteToolTables({ force = false } = {}) {
  if (!isLive() || remoteToolTablesLoading) return;
  if (!force && !toolsCacheIsStale(remoteToolTablesLoaded, remoteToolTablesLoadedAt)) return;
  remoteToolTablesLoading = true;
  remoteToolTablesError = "";
  try {
    remoteToolTables = await fetchTable("customTables");
    remoteToolTablesLoaded = true;
    remoteToolTablesLoadedAt = Date.now();
    saveToolsSessionCache("tables", remoteToolTables, remoteToolTablesLoadedAt);
  } catch (err) {
    remoteToolTablesError = err.message;
  } finally {
    remoteToolTablesLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "tables") renderToolCustomTables(root);
  }
}

function renderToolCustomTables(root) {
  if (isLive() && !remoteToolTablesLoading && !remoteToolTablesError && toolsCacheIsStale(remoteToolTablesLoaded, remoteToolTablesLoadedAt)) loadRemoteToolTables();
  const allTables = toolCustomTableRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("tables");
  const tables = allTables.filter((item) => {
    const searchable = [item.name, ...item.sheets.flatMap((sheet) => [sheet.name, ...sheet.columns.map((column) => column.name)])];
    const matchesSearch = !query || searchable.some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolCustomTableValue(item, key))
    );
  });
  if (tableState.sortKey) {
    tables.sort((a, b) => toolCustomTableValue(a, tableState.sortKey).localeCompare(
      toolCustomTableValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const page = paginateToolRows(tables, "tables");
  const columns = visibleToolColumns("tables");
  const rows = page.rows.length ? page.rows.map((item) => `<tr data-id="${esc(item.id)}">
    ${columns.map((column) => column.k === "name"
      ? `<td><button class="process-open-link tool-custom-table-open" data-id="${esc(item.id)}">${esc(item.name)}</button></td>`
      : `<td>${esc(toolCustomTableValue(item, column.k))}</td>`).join("")}
    <td class="table-actions-cell">${tableActionButtons({
      open: { className: "tool-custom-table-open", attrs: { "data-id": item.id }, title: "Abrir tabela" },
      edit: { className: "tool-custom-table-edit", attrs: { "data-id": item.id }, title: "Editar tabela", enabled: currentUserCan("tables", "edit") },
      clone: { className: "tool-custom-table-clone", attrs: { "data-id": item.id }, title: "Clonar tabela", enabled: currentUserCan("tables", "clone") },
      delete: { className: "tool-custom-table-delete", attrs: { "data-id": item.id }, title: "Excluir tabela", enabled: currentUserCan("tables", "delete") }
    })}</td>
  </tr>`).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhuma tabela cadastrada.</td></tr>`;
  root.innerHTML = `${toolsToolbarHtml(tables.length, "Adicionar tabela", "tool-custom-table-add", currentUserCan("tables", "create"), "Buscar tabela...")}${toolFilterStrip("tables", tableState, { loading: remoteToolTablesLoading, error: remoteToolTablesError })}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((column) => `<th data-tool-key="${esc(column.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(column.h)}${tableState.sortKey === column.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}${tableActionsHead()}</tr></thead><tbody>${rows}</tbody></table></div>${toolsPaginationHtml(tables.length, "tables")}`;
  wireToolsToolbar(root);
  wireToolsPagination(root, "tables");
  wireToolsLoadRetry(root, "tables");
  wireSecondaryTableSelection(root.querySelector("table"), "tools:tables");
  document.getElementById("tool-custom-table-add")?.addEventListener("click", () => openToolCustomTableEditor());
  root.querySelectorAll(".tool-custom-table-open").forEach((button) => button.addEventListener("click", () => openToolCustomTableEditor(button.dataset.id, true)));
  root.querySelectorAll(".tool-custom-table-edit").forEach((button) => button.addEventListener("click", () => openToolCustomTableEditor(button.dataset.id)));
  root.querySelectorAll(".tool-custom-table-clone").forEach((button) => button.addEventListener("click", () => cloneToolCustomTable(button.dataset.id)));
  root.querySelectorAll(".tool-custom-table-delete").forEach((button) => button.addEventListener("click", () => deleteToolCustomTable(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allTables, toolCustomTableValue, "tables"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((filter) => filter.addEventListener("click", () => {
    delete tableState.filters[filter.dataset.key]; renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => { tableState.filters = {}; renderToolsSection(); });
}

function updateToolCustomTableCache(saved) {
  const index = remoteToolTables.findIndex((item) => item.id === saved.id);
  if (index >= 0) remoteToolTables[index] = saved; else remoteToolTables.unshift(saved);
  remoteToolTablesLoaded = true;
  remoteToolTablesLoadedAt = Date.now();
  saveToolsSessionCache("tables", remoteToolTables, remoteToolTablesLoadedAt);
}

function openToolCustomTableEditor(id = null, readOnly = false) {
  if (!requireCurrentUserPermission("tables", readOnly ? "view" : id ? "edit" : "create", "Tabelas")) return;
  const source = toolCustomTableRows().find((item) => item.id === id);
  if (id && !source) return;
  const draft = normalizeCustomTable(source || {
    name: "Nova tabela",
    columns: [{ name: "Coluna 1" }, { name: "Coluna 2" }, { name: "Coluna 3" }],
    rows: []
  });
  let activeSheetId = draft.sheets[0].id;
  const activeSheet = () => draft.sheets.find((sheet) => sheet.id === activeSheetId) || draft.sheets[0];
  const view = { sortKey: null, sortDir: 1, filters: {} };
  const content = `<div class="custom-table-editor${readOnly ? " is-readonly" : ""}">
    <div class="custom-table-editor-toolbar">
      <div class="custom-table-meta">
        ${[["category", "Categoria"], ["system_name", "Canal"], ["module_name", "Módulo"], ["submodule_name", "Submódulo"]].map(([key, label]) => `<input class="custom-table-meta-input" data-meta="${key}" value="${esc(draft[key] || "")}" placeholder="${label}" title="${label}" list="custom-table-meta-${key}"${readOnly ? " disabled" : ""}><datalist id="custom-table-meta-${key}">${[...new Set(toolCustomTableRows().map((item) => String(item[key] || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")).map((value) => `<option value="${esc(value)}"></option>`).join("")}</datalist>`).join("")}
        <input id="custom-table-name" class="custom-table-name-input" value="${esc(draft.base_name || draft.name)}" placeholder="Nome" title="Nome"${readOnly ? " disabled" : ""}>
        <label class="custom-table-structured" title="O nome do arquivo passa a ser Categoria | Canal | Módulo | Submódulo | Nome"><input type="checkbox" id="custom-table-structured"${draft.use_structured_name ? " checked" : ""}${readOnly ? " disabled" : ""}><span>Usar como nome do arquivo</span></label>
      </div>
      <span id="custom-table-file-name" class="custom-table-file-name"></span>
      <span id="custom-table-summary" class="muted"></span>
      ${readOnly ? "" : '<button class="btn" id="custom-table-add-column" type="button">+ Coluna</button><button class="btn primary" id="custom-table-add-row" type="button">+ Linha</button>'}
    </div>
    <div class="registration-filter-strip custom-table-filter-strip"><div class="registration-filter-badges"></div><button class="filter-clear-all custom-table-filter-clear-all" type="button" hidden><span aria-hidden="true">×</span> Limpar tudo</button></div>
    <div class="custom-table-grid-wrap" id="custom-table-grid-wrap"></div>
    <div class="custom-table-sheet-tabs"><div id="custom-table-sheet-list"></div>${readOnly ? "" : '<button class="custom-table-add-sheet" id="custom-table-add-sheet" type="button" title="Adicionar aba">+</button>'}</div>
  </div><div class="modal-foot"><button class="btn" id="custom-table-cancel">${readOnly ? "Fechar" : "Cancelar"}</button>${readOnly ? "" : '<button class="btn primary" id="custom-table-save">Salvar</button>'}</div>`;
  const closePanel = nestedCenterModal(readOnly ? `Tabela · ${draft.name}` : (id ? "Editar tabela" : "Nova tabela"), content, { cls: "full custom-table-editor-modal", closeOnOverlay: true });
  document.querySelectorAll(".custom-table-meta-input, #custom-table-name, #custom-table-structured").forEach((input) => input.addEventListener(input.type === "checkbox" ? "change" : "input", () => updateFileName()));

  const resetSheetView = () => {
    view.sortKey = null;
    view.sortDir = 1;
    view.filters = {};
  };

  const renderSheetTabs = () => {
    const root = document.getElementById("custom-table-sheet-list");
    if (!root) return;
    root.innerHTML = draft.sheets.map((sheet) => `<div class="custom-table-sheet-tab${sheet.id === activeSheetId ? " active" : ""}" data-sheet-id="${esc(sheet.id)}"><button type="button" class="custom-table-sheet-select" title="Abrir aba">${esc(sheet.name)}</button>${readOnly ? "" : '<button type="button" class="custom-table-sheet-rename" title="Renomear aba">✎</button><button type="button" class="custom-table-sheet-delete" title="Excluir aba">×</button>'}</div>`).join("");
    root.querySelectorAll(".custom-table-sheet-select").forEach((button) => button.addEventListener("click", () => {
      activeSheetId = button.closest("[data-sheet-id]").dataset.sheetId;
      resetSheetView();
      renderGrid();
    }));
    if (readOnly) return;
    root.querySelectorAll(".custom-table-sheet-rename").forEach((button) => button.addEventListener("click", () => {
      const sheet = draft.sheets.find((item) => item.id === button.closest("[data-sheet-id]").dataset.sheetId);
      const name = window.prompt("Nome da aba:", sheet?.name || "")?.trim();
      if (!sheet || !name) return;
      sheet.name = name;
      renderSheetTabs();
    }));
    root.querySelectorAll(".custom-table-sheet-delete").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (draft.sheets.length === 1) { toast("A tabela precisa ter ao menos uma aba.", true); return; }
      const sheetId = button.closest("[data-sheet-id]").dataset.sheetId;
      const sheet = draft.sheets.find((item) => item.id === sheetId);
      if (!window.confirm(`Excluir a aba "${sheet?.name || ""}"?`)) return;
      draft.sheets = draft.sheets.filter((item) => item.id !== sheetId);
      if (activeSheetId === sheetId) activeSheetId = draft.sheets[0].id;
      resetSheetView();
      renderGrid();
    }));
  };

  const openColumnFilter = (header, column) => {
    document.getElementById("custom-table-filter-dd")?.remove();
    const values = [...new Set(activeSheet().rows.map((row) => String(row.cells[column.id] || "")))].sort((a, b) =>
      a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" })
    );
    const rect = header.getBoundingClientRect();
    const panel = document.createElement("div");
    panel.id = "custom-table-filter-dd";
    panel.className = "filter-dd";
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.maxHeight = `${Math.max(220, window.innerHeight - rect.bottom - 20)}px`;
    document.body.appendChild(panel);
    mountColumnFilterPanel(panel, {
      title: `Filtrar · ${column.name}`, values, key: column.name || "", current: view.filters[column.id],
      labelFor: (value) => value || "(vazio)",
      onApply: (rule) => {
        if (rule) view.filters[column.id] = rule; else delete view.filters[column.id];
        panel.remove();
        renderGrid();
      }
    });
    setTimeout(() => {
      const outside = (event) => {
        if (!panel.contains(event.target) && !header.contains(event.target)) {
          panel.remove();
          document.removeEventListener("mousedown", outside);
        }
      };
      document.addEventListener("mousedown", outside);
    }, 50);
  };

  const updateFileName = () => {
    const meta = Object.fromEntries([...document.querySelectorAll(".custom-table-meta-input")].map((input) => [input.dataset.meta, input.value]));
    const base = document.getElementById("custom-table-name")?.value || "";
    const structured = document.getElementById("custom-table-structured")?.checked;
    const label = document.getElementById("custom-table-file-name");
    if (!label) return;
    const fileName = structured ? customTableStructuredName({ ...meta, base_name: base }) : base.trim();
    label.textContent = fileName ? `Arquivo: ${fileName}` : "";
    label.title = fileName;
  };

  const deleteColumn = (columnId) => {
    const sheet = activeSheet();
    if (sheet.columns.length === 1) { toast("A aba precisa ter ao menos uma coluna.", true); return; }
    const index = sheet.columns.findIndex((column) => column.id === columnId);
    sheet.columns = sheet.columns.filter((column) => column.id !== columnId);
    sheet.rows.forEach((row) => delete row.cells[columnId]);
    if (index >= 0 && index < sheet.frozen) sheet.frozen -= 1;
    delete view.filters[columnId];
    if (view.sortKey === columnId) view.sortKey = null;
    renderGrid();
  };

  const insertColumn = (columnId, offset) => {
    const sheet = activeSheet();
    const index = sheet.columns.findIndex((column) => column.id === columnId);
    const name = window.prompt("Nome da nova coluna:", `Coluna ${sheet.columns.length + 1}`)?.trim();
    if (!name) return;
    const column = { id: crypto.randomUUID(), name };
    const at = Math.max(0, index + offset);
    sheet.columns.splice(at, 0, column);
    sheet.rows.forEach((row) => { row.cells[column.id] = ""; });
    if (at < sheet.frozen) sheet.frozen += 1;
    renderGrid();
  };

  const autoFitColumn = (columnId) => {
    const sheet = activeSheet();
    const column = sheet.columns.find((item) => item.id === columnId);
    if (!column) return;
    const canvas = autoFitColumn.canvas || (autoFitColumn.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    context.font = "13px system-ui, sans-serif";
    const widest = Math.max(context.measureText(String(column.name || "").toLocaleUpperCase("pt-BR")).width + 70,
      ...sheet.rows.map((row) => context.measureText(String(row.cells[columnId] || "")).width + 26));
    column.width = Math.round(Math.min(CUSTOM_TABLE_MAX_WIDTH, Math.max(CUSTOM_TABLE_MIN_WIDTH, widest)));
    renderGrid();
  };

  const startColumnResize = (event, columnId) => {
    event.preventDefault();
    event.stopPropagation();
    const sheet = activeSheet();
    const column = sheet.columns.find((item) => item.id === columnId);
    const col = document.querySelector(`#custom-table-grid-wrap col[data-col-id="${CSS.escape(columnId)}"]`);
    const table = document.querySelector("#custom-table-grid-wrap .custom-table-grid");
    if (!column || !col || !table) return;
    const startX = event.clientX;
    const startWidth = customTableColumnWidth(column);
    const startTable = table.offsetWidth;
    document.body.classList.add("ct-resizing");
    const move = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startX) < 2) return;
      const width = Math.round(Math.min(CUSTOM_TABLE_MAX_WIDTH, Math.max(CUSTOM_TABLE_MIN_WIDTH, startWidth + moveEvent.clientX - startX)));
      column.width = width;
      col.style.width = `${width}px`;
      table.style.width = `${startTable + width - startWidth}px`;
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("ct-resizing");
      if (customTableColumnWidth(column) !== startWidth) renderGrid();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  // Menu da coluna (⋮ ou botão direito): congelar, ordenar, filtrar,
  // dimensionar, inserir e excluir com confirmação.
  const openColumnMenu = (anchor, column, point = null) => {
    document.getElementById("custom-table-column-menu")?.remove();
    const sheet = activeSheet();
    const index = sheet.columns.findIndex((item) => item.id === column.id);
    const frozenHere = index < sheet.frozen;
    const menu = document.createElement("div");
    menu.id = "custom-table-column-menu";
    menu.className = "ct-menu";
    const items = [
      [frozenHere ? "unfreeze" : "freeze", frozenHere ? "Descongelar colunas" : `Congelar até esta coluna (${index + 1})`],
      ["sort-asc", "Ordenar A → Z"],
      ["sort-desc", "Ordenar Z → A"],
      ["filter", "Filtrar…"],
      ["fit", "Ajustar largura ao conteúdo"],
      ["reset-width", "Largura padrão"],
      ...(readOnly ? [] : [["insert-left", "Inserir coluna à esquerda"], ["insert-right", "Inserir coluna à direita"], ["delete", "Excluir coluna…", "danger"]])
    ];
    const drawItems = () => {
      menu.innerHTML = `<div class="ct-menu-head">${esc(column.name)}</div>${items.map(([action, label, tone]) => `<button type="button" class="ct-menu-item${tone ? ` ${tone}` : ""}" data-action="${action}">${label}</button>`).join("")}`;
    };
    const drawConfirm = () => {
      const filled = sheet.rows.filter((row) => String(row.cells[column.id] || "").trim()).length;
      menu.innerHTML = `<div class="ct-menu-head">Excluir coluna</div>
        <p class="ct-menu-confirm">Excluir a coluna <b>${esc(column.name)}</b>?${filled ? ` ${filled} célula(s) preenchida(s) serão apagadas.` : ""} Só é definitivo ao salvar a tabela.</p>
        <div class="ct-menu-actions"><button type="button" class="btn" data-action="cancel">Cancelar</button><button type="button" class="btn danger" data-action="confirm-delete">Excluir</button></div>`;
    };
    drawItems();
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const place = () => {
      const box = menu.getBoundingClientRect();
      const x = point ? point.x : rect.right - box.width;
      const y = point ? point.y : rect.bottom + 4;
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    };
    place();
    const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); };
    const outside = (event) => { if (!menu.contains(event.target)) close(); };
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
    menu.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      if (action === "delete") { drawConfirm(); place(); return; }
      if (action === "cancel") { drawItems(); place(); return; }
      close();
      if (action === "freeze") { sheet.frozen = index + 1; renderGrid(); }
      else if (action === "unfreeze") { sheet.frozen = 0; renderGrid(); }
      else if (action === "sort-asc" || action === "sort-desc") { view.sortKey = column.id; view.sortDir = action === "sort-asc" ? 1 : -1; renderGrid(); }
      else if (action === "filter") { const header = document.querySelector(`#custom-table-grid-wrap th[data-custom-table-key="${CSS.escape(column.id)}"]`); if (header) openColumnFilter(header, column); }
      else if (action === "fit") autoFitColumn(column.id);
      else if (action === "reset-width") { delete column.width; renderGrid(); }
      else if (action === "insert-left") insertColumn(column.id, 0);
      else if (action === "insert-right") insertColumn(column.id, 1);
      else if (action === "confirm-delete") deleteColumn(column.id);
    });
  };

  const renderGrid = () => {
    const sheet = activeSheet();
    let visibleRows = sheet.rows.filter((row) => sheet.columns.every((column) => {
      const selected = view.filters[column.id];
      return !selected?.size || selected.has(String(row.cells[column.id] || ""));
    }));
    if (view.sortKey) {
      visibleRows = [...visibleRows].sort((a, b) => String(a.cells[view.sortKey] || "").localeCompare(
        String(b.cells[view.sortKey] || ""), "pt-BR", { numeric: true, sensitivity: "base" }
      ) * view.sortDir);
    }
    document.getElementById("custom-table-summary").textContent = `${draft.sheets.length} aba(s) · ${sheet.columns.length} coluna(s) · ${visibleRows.length}/${sheet.rows.length} linha(s)`;
    const activeFilters = Object.entries(view.filters).filter(([, values]) => values?.size);
    const filterStrip = document.querySelector(".custom-table-filter-strip");
    filterStrip.querySelector(".registration-filter-badges").innerHTML = activeFilters.map(([columnId, values]) => {
      const label = sheet.columns.find((column) => column.id === columnId)?.name || "Coluna";
      return `<button class="registration-filter-badge custom-table-filter-badge" data-column-id="${esc(columnId)}" title="Limpar filtro"><span>${esc(label)}: ${esc([...values].map((value) => value || "(vazio)").join(", "))}</span><b>×</b></button>`;
    }).join("");
    filterStrip.querySelector(".custom-table-filter-clear-all").hidden = activeFilters.length < 2;
    filterStrip.querySelectorAll(".custom-table-filter-badge").forEach((button) => button.addEventListener("click", () => {
      delete view.filters[button.dataset.columnId];
      renderGrid();
    }));
    filterStrip.querySelector(".custom-table-filter-clear-all").onclick = () => {
      view.filters = {};
      renderGrid();
    };
    const wrap = document.getElementById("custom-table-grid-wrap");
    const frozenLeft = [];
    sheet.columns.reduce((left, column, index) => { frozenLeft[index] = left; return left + customTableColumnWidth(column); }, CUSTOM_TABLE_INDEX_WIDTH);
    const cellAttrs = (index) => index < sheet.frozen
      ? ` class="ct-frozen${index === sheet.frozen - 1 ? " ct-frozen-edge" : ""}" style="left:${frozenLeft[index]}px"`
      : "";
    const tableWidth = CUSTOM_TABLE_INDEX_WIDTH + 34 + sheet.columns.reduce((total, column) => total + customTableColumnWidth(column), 0);
    wrap.innerHTML = `<table class="custom-table-grid" style="width:${tableWidth}px"><colgroup><col style="width:${CUSTOM_TABLE_INDEX_WIDTH}px">${sheet.columns.map((column) => `<col data-col-id="${esc(column.id)}" style="width:${customTableColumnWidth(column)}px">`).join("")}<col style="width:34px"></colgroup><thead>
      <tr><th class="custom-table-index-cell">#</th>${sheet.columns.map((column, index) => `<th data-custom-table-key="${esc(column.id)}"${cellAttrs(index)} title="Clique para ordenar. Ctrl+clique para filtrar. Botão direito ou ⋮ para opções.">
        <div class="custom-table-column-head">${readOnly ? `<span class="custom-table-column-label">${esc(column.name)}</span>` : `<input value="${esc(column.name)}" data-column-name="${esc(column.id)}">`}<span class="arrow">${index < sheet.frozen ? '<span class="ct-pin" title="Coluna congelada">📌</span>' : ""}${view.sortKey === column.id ? (view.sortDir > 0 ? "▲" : "▼") : ""}</span><button class="tool-icon-btn ct-col-menu-btn" data-column-id="${esc(column.id)}" type="button" title="Opções da coluna">⋮</button></div>
        <span class="ct-resize" data-column-id="${esc(column.id)}" title="Arraste para dimensionar. Duplo clique ajusta ao conteúdo."></span>
      </th>`).join("")}<th class="custom-table-row-action"></th></tr>
    </thead><tbody>${visibleRows.length ? visibleRows.map((row) => {
      const originalIndex = sheet.rows.findIndex((item) => item.id === row.id);
      return `<tr><td class="custom-table-index-cell">${originalIndex + 1}</td>${sheet.columns.map((column, index) => `<td${cellAttrs(index)}><input data-row-id="${esc(row.id)}" data-cell-column="${esc(column.id)}" value="${esc(row.cells[column.id] || "")}"${readOnly ? " readonly" : ""}></td>`).join("")}<td class="custom-table-row-action">${readOnly ? "" : `<button class="tool-icon-btn custom-table-delete-row" data-row-id="${esc(row.id)}" title="Excluir linha">×</button>`}</td></tr>`;
    }).join("") : `<tr><td colspan="${sheet.columns.length + 2}" class="tool-empty">Nenhuma linha para exibir.</td></tr>`}</tbody></table>`;
    wrap.querySelectorAll("[data-column-name]").forEach((input) => input.addEventListener("input", () => {
      const column = sheet.columns.find((item) => item.id === input.dataset.columnName);
      if (column) column.name = input.value;
    }));
    wrap.querySelectorAll("[data-cell-column]").forEach((input) => input.addEventListener("input", () => {
      const row = sheet.rows.find((item) => item.id === input.dataset.rowId);
      if (row) row.cells[input.dataset.cellColumn] = input.value;
    }));
    wrap.querySelectorAll("th[data-custom-table-key]").forEach((header) => header.addEventListener("click", (event) => {
      const columnId = header.dataset.customTableKey;
      const column = sheet.columns.find((item) => item.id === columnId);
      if (!column) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        openColumnFilter(header, column);
        return;
      }
      if (event.target.closest(".ct-resize")) return;
      if (event.target.closest(".ct-col-menu-btn")) { event.stopPropagation(); openColumnMenu(event.target.closest(".ct-col-menu-btn"), column); return; }
      if (!readOnly && event.target.closest("input,button")) return;
      if (view.sortKey !== columnId) { view.sortKey = columnId; view.sortDir = 1; }
      else if (view.sortDir === 1) view.sortDir = -1;
      else { view.sortKey = null; view.sortDir = 1; }
      renderGrid();
    }));
    wrap.querySelectorAll("th[data-custom-table-key]").forEach((header) => header.addEventListener("contextmenu", (event) => {
      const column = sheet.columns.find((item) => item.id === header.dataset.customTableKey);
      if (!column) return;
      event.preventDefault();
      openColumnMenu(header, column, { x: event.clientX, y: event.clientY });
    }));
    wrap.querySelectorAll(".ct-resize").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => startColumnResize(event, handle.dataset.columnId));
      handle.addEventListener("dblclick", (event) => { event.stopPropagation(); autoFitColumn(handle.dataset.columnId); });
      handle.addEventListener("click", (event) => event.stopPropagation());
    });
    wrap.querySelectorAll(".custom-table-delete-row").forEach((button) => button.addEventListener("click", () => {
      sheet.rows = sheet.rows.filter((row) => row.id !== button.dataset.rowId);
      renderGrid();
    }));
    renderSheetTabs();
  };

  document.getElementById("custom-table-cancel").addEventListener("click", closePanel);
  document.getElementById("custom-table-add-sheet")?.addEventListener("click", () => {
    const sheet = {
      id: crypto.randomUUID(),
      name: `Planilha ${draft.sheets.length + 1}`,
      columns: [{ id: crypto.randomUUID(), name: "Coluna 1" }],
      rows: []
    };
    draft.sheets.push(sheet);
    activeSheetId = sheet.id;
    resetSheetView();
    renderGrid();
  });
  document.getElementById("custom-table-add-column")?.addEventListener("click", () => {
    const sheet = activeSheet();
    const name = window.prompt("Nome da nova coluna:", `Coluna ${sheet.columns.length + 1}`)?.trim();
    if (!name) return;
    const column = { id: crypto.randomUUID(), name };
    sheet.columns.push(column);
    sheet.rows.forEach((row) => { row.cells[column.id] = ""; });
    renderGrid();
  });
  document.getElementById("custom-table-add-row")?.addEventListener("click", () => {
    const sheet = activeSheet();
    sheet.rows.push({ id: crypto.randomUUID(), cells: Object.fromEntries(sheet.columns.map((column) => [column.id, ""])) });
    renderGrid();
  });
  document.getElementById("custom-table-save")?.addEventListener("click", async () => {
    document.querySelectorAll(".custom-table-meta-input").forEach((input) => { draft[input.dataset.meta] = input.value.trim() || null; });
    draft.base_name = document.getElementById("custom-table-name").value.trim();
    draft.use_structured_name = Boolean(document.getElementById("custom-table-structured")?.checked);
    draft.name = draft.use_structured_name ? customTableStructuredName(draft) : draft.base_name;
    draft.sheets.forEach((sheet) => {
      sheet.name = sheet.name.trim();
      sheet.columns.forEach((column) => { column.name = column.name.trim(); });
    });
    if (!draft.name) { toast("Informe o nome da tabela.", true); return; }
    if (draft.sheets.some((sheet) => !sheet.name)) { toast("Todas as abas precisam ter nome.", true); return; }
    if (draft.sheets.some((sheet) => sheet.columns.some((column) => !column.name))) { toast("Todas as colunas precisam ter nome.", true); return; }
    const duplicateColumns = draft.sheets.some((sheet) => {
      const names = sheet.columns.map((column) => column.name.toLocaleLowerCase("pt-BR"));
      return new Set(names).size !== names.length;
    });
    if (duplicateColumns) { toast("Os nomes das colunas não podem se repetir dentro da mesma aba.", true); return; }
    const button = document.getElementById("custom-table-save");
    button.disabled = true;
    button.textContent = "Salvando...";
    const firstSheet = draft.sheets[0];
    const body = {
      name: draft.name, base_name: draft.base_name, use_structured_name: draft.use_structured_name,
      category: draft.category || null, system_name: draft.system_name || null, module_name: draft.module_name || null, submodule_name: draft.submodule_name || null,
      sheets: draft.sheets, columns: firstSheet.columns, rows: firstSheet.rows, updated_at: new Date().toISOString()
    };
    try {
      let saved;
      if (isLive()) saved = id ? await updateRow("customTables", id, body) : await createRow("customTables", body);
      else {
        const localRows = toolCustomTableRows();
        saved = { ...draft, ...body, id: id || crypto.randomUUID(), created_at: source?.created_at || new Date().toISOString() };
        const index = localRows.findIndex((item) => item.id === saved.id);
        if (index >= 0) localRows[index] = saved; else localRows.unshift(saved);
        saveToolRows(TOOL_TABLES_KEY, localRows);
      }
      if (isLive()) updateToolCustomTableCache(saved);
      closePanel();
      renderToolsSection();
      toast("Tabela salva.");
    } catch (err) {
      button.disabled = false;
      button.textContent = "Salvar";
      toast("Erro ao salvar tabela · " + err.message, true);
    }
  });
  renderGrid();
  updateFileName();
}

async function cloneToolCustomTable(id) {
  if (!requireCurrentUserPermission("tables", "clone", "Tabelas")) return;
  const source = toolCustomTableRows().find((item) => item.id === id);
  if (!source) return;
  const sheets = source.sheets.map((sourceSheet) => {
    const idMap = new Map(sourceSheet.columns.map((column) => [column.id, crypto.randomUUID()]));
    const columns = sourceSheet.columns.map((column) => ({ ...column, id: idMap.get(column.id) }));
    const rows = sourceSheet.rows.map((row) => ({
      id: crypto.randomUUID(),
      cells: Object.fromEntries(sourceSheet.columns.map((column) => [idMap.get(column.id), row.cells[column.id] || ""]))
    }));
    return { id: crypto.randomUUID(), name: sourceSheet.name, columns, rows, frozen: sourceSheet.frozen || 0 };
  });
  const baseName = `${source.base_name || source.name} - Cópia`;
  const meta = { category: source.category || null, system_name: source.system_name || null, module_name: source.module_name || null, submodule_name: source.submodule_name || null };
  const body = {
    ...meta, base_name: baseName, use_structured_name: Boolean(source.use_structured_name),
    name: source.use_structured_name ? customTableStructuredName({ ...meta, base_name: baseName }) : baseName,
    sheets, columns: sheets[0].columns, rows: sheets[0].rows, updated_at: new Date().toISOString()
  };
  try {
    let saved;
    if (isLive()) saved = await createRow("customTables", body);
    else {
      saved = { id: crypto.randomUUID(), ...body, created_at: new Date().toISOString() };
      saveToolRows(TOOL_TABLES_KEY, [saved, ...toolCustomTableRows()]);
    }
    if (isLive()) updateToolCustomTableCache(saved);
    renderToolsSection();
    toast("Tabela clonada.");
  } catch (err) {
    toast("Erro ao clonar tabela · " + err.message, true);
  }
}

async function deleteToolCustomTable(id) {
  if (!requireCurrentUserPermission("tables", "delete", "Tabelas")) return;
  const item = toolCustomTableRows().find((table) => table.id === id);
  if (!item || !window.confirm(`Excluir a tabela "${item.name}"?`)) return;
  try {
    if (isLive()) {
      await deleteRow("customTables", id);
      remoteToolTables = remoteToolTables.filter((table) => table.id !== id);
      remoteToolTablesLoadedAt = Date.now();
      saveToolsSessionCache("tables", remoteToolTables, remoteToolTablesLoadedAt);
    } else {
      saveToolRows(TOOL_TABLES_KEY, toolCustomTableRows().filter((table) => table.id !== id));
    }
    renderToolsSection();
    toast("Tabela excluída.");
  } catch (err) {
    toast("Erro ao excluir tabela · " + err.message, true);
  }
}

function closeToolDocumentPanel(closePanel) {
  closePanel?.();
  if (document.getElementById("tools-root")) renderToolsSection();
  else openToolsModal("documents");
}

function documentOrientation(documentItem) {
  return documentItem?.orientation === "portrait" ? "portrait" : "landscape";
}

function documentSlideFormat(documentItem) {
  return documentItem?.slide_format === "standard" ? "standard" : "widescreen";
}

function documentSlideFormatLabel(documentItem) {
  return documentSlideFormat(documentItem) === "standard" ? "Padrão 4:3" : "Widescreen 16:9";
}

function applyDocumentSlideDimensions(stage, orientation, slideFormat) {
  if (!stage) return;
  const portrait = orientation === "portrait";
  const standard = slideFormat === "standard";
  stage.style.aspectRatio = portrait
    ? (standard ? "3 / 4" : "9 / 16")
    : (standard ? "4 / 3" : "16 / 9");
  stage.style.width = portrait ? "auto" : (standard ? "min(1060px, calc(100% - 12px))" : "min(1420px, calc(100% - 12px))");
  stage.style.height = portrait ? "min(calc(100vh - 150px), 980px)" : "auto";
}

function applyDocumentReadingDimensions(stage, orientation, slideFormat) {
  if (!stage) return;
  const portrait = orientation === "portrait";
  const standard = slideFormat === "standard";
  const ratio = portrait ? (standard ? 3 / 4 : 9 / 16) : (standard ? 4 / 3 : 16 / 9);
  const maxWidth = Math.max(320, window.innerWidth - 16);
  const maxHeight = Math.max(320, window.innerHeight - 100);
  const height = Math.min(maxHeight, maxWidth / ratio);
  stage.style.aspectRatio = String(ratio);
  stage.style.height = `${Math.floor(height)}px`;
  stage.style.width = `${Math.floor(height * ratio)}px`;
}

function documentPageBreadcrumbParts(documentItem, page) {
  if (Array.isArray(page.breadcrumb_parts)) return page.breadcrumb_parts;
  if (page.breadcrumb) return String(page.breadcrumb).split(">").map((item) => item.trim()).filter(Boolean);
  return [documentItem.system_name || "ENTERPRISER CMS", documentItem.module_name, page.subject].filter(Boolean);
}

function documentPageBreadcrumb(documentItem, page) {
  return documentPageBreadcrumbParts(documentItem, page).join(" > ");
}

function documentPageBreadcrumbMarkup(documentItem, page, editable) {
  const parts = documentPageBreadcrumbParts(documentItem, page);
  const rawUrl = String(page.breadcrumb_url || "").trim();
  if (editable) {
    return `<div class="documentation-breadcrumb-editor">
      <div class="documentation-breadcrumb-parts">${parts.map((part, index) => `<button class="documentation-breadcrumb-chip" type="button" data-index="${index}" data-value="${esc(part)}" title="Remover item">${esc(part)} <span>×</span></button>`).join("")}<input id="document-breadcrumb-add" placeholder="Adicionar item"><button class="tool-icon-btn" id="document-breadcrumb-add-button" type="button" title="Adicionar ao breadcrumb">+</button></div>
      <input id="document-breadcrumb-url" value="${esc(rawUrl)}" placeholder="URL opcional">
    </div>`;
  }
  const safeUrl = safeHttpUrl(rawUrl);
  const urlMarkup = rawUrl ? (safeUrl ? ` <a href="${esc(safeUrl)}" target="_blank" rel="noopener">(${esc(rawUrl)})</a>` : ` <em>(${esc(rawUrl)})</em>`) : "";
  return `<span>${esc(parts.join(" > "))}${urlMarkup}</span>`;
}

function documentBlockMarkup(block, { editable = false, selectedBlockId = null } = {}) {
  const label = DOCUMENT_BLOCK_TYPES[block.type] || DOCUMENT_BLOCK_TYPES.text;
  const semantic = ["note", "rule", "warning", "example"].includes(block.type);
  const selected = editable && block.id === selectedBlockId;
  return `<section class="documentation-block documentation-block-${esc(block.type)}${editable ? " is-editing" : ""}${selected ? " is-selected" : ""}" data-block-id="${esc(block.id)}" style="grid-column:span ${block.span}">
    ${semantic ? `<div class="documentation-block-label">${esc(label)}</div>` : ""}
    <div class="documentation-block-content"${editable ? ' contenteditable="true" data-placeholder="Digite o conteúdo do bloco..."' : ""}>${sanitizeDocumentHtml(block.html)}</div>
  </section>`;
}

function documentPageMarkup(documentItem, page, index, total, { editable = false, selectedBlockId = null } = {}) {
  const systemName = documentItem.system_name || "ENTERPRISER CMS";
  const moduleName = documentItem.module_name || documentItem.category || "GERAL";
  const subject = page.subject || page.title || `Página ${index + 1}`;
  return `<header class="documentation-page-header"><strong class="documentation-system">${esc(systemName)}</strong><span class="documentation-module">${esc(moduleName)}</span></header>
    <div class="documentation-context-bar">${editable ? `<input id="document-page-subject" value="${esc(subject)}" placeholder="Assunto da página">` : `<strong>${esc(subject)}</strong>`}</div>
    <div class="documentation-body-grid">${page.blocks.map((block) => documentBlockMarkup(block, { editable, selectedBlockId })).join("")}</div>
    <footer class="documentation-page-footer">${documentPageBreadcrumbMarkup(documentItem, page, editable)}<b>${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</b></footer>`;
}

function openToolDocumentPresentation(documentItem, pages, startIndex = 0) {
  let activeIndex = Math.max(0, Math.min(startIndex, pages.length - 1));
  const orientation = documentOrientation(documentItem);
  const slideFormat = documentSlideFormat(documentItem);
  const content = `<div class="document-slideshow documentation-reading-mode">
    <main class="document-slideshow-stage"><article class="document-slide documentation-page ${orientation} ${slideFormat}" id="document-slideshow-slide"></article></main>
    <div class="document-slideshow-controls"><button class="btn" id="document-slideshow-prev" title="Página anterior">‹</button><span id="document-slideshow-count"></span><button class="btn" id="document-slideshow-next" title="Próxima página">›</button></div>
  </div>`;
  let keyHandler;
  let viewportHandler;
  let fullscreenHost;
  const baseClose = nestedCenterModal(`Leitura · ${documentItem.title}`, content, {
    cls: "full document-slideshow-modal",
    closeOnOverlay: false,
    onClose: () => {
      document.removeEventListener("keydown", keyHandler);
      document.removeEventListener("fullscreenchange", viewportHandler);
      window.removeEventListener("resize", viewportHandler);
      if (document.fullscreenElement === fullscreenHost) document.exitFullscreen().catch(() => {});
    }
  });
  const draw = () => {
    const page = pages[activeIndex];
    const stage = document.getElementById("document-slideshow-slide");
    if (!stage || !page) return;
    stage.style.background = page.background;
    stage.innerHTML = documentPageMarkup(documentItem, page, activeIndex, pages.length);
    applyDocumentReadingDimensions(stage, orientation, slideFormat);
    document.getElementById("document-slideshow-count").textContent = `${activeIndex + 1} / ${pages.length}`;
    document.getElementById("document-slideshow-prev").disabled = activeIndex === 0;
    document.getElementById("document-slideshow-next").disabled = activeIndex === pages.length - 1;
  };
  const move = (direction) => {
    activeIndex = Math.max(0, Math.min(pages.length - 1, activeIndex + direction));
    draw();
  };
  document.getElementById("document-slideshow-prev").addEventListener("click", () => move(-1));
  document.getElementById("document-slideshow-next").addEventListener("click", () => move(1));
  keyHandler = (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight" || event.key === " ") { event.preventDefault(); move(1); }
  };
  document.addEventListener("keydown", keyHandler);
  viewportHandler = () => applyDocumentReadingDimensions(document.getElementById("document-slideshow-slide"), orientation, slideFormat);
  document.addEventListener("fullscreenchange", viewportHandler);
  window.addEventListener("resize", viewportHandler);
  draw();
  fullscreenHost = [...document.querySelectorAll(".modal.document-slideshow-modal")].at(-1);
  fullscreenHost?.requestFullscreen?.().catch(() => {});
  return baseClose;
}

function openToolDocument(id) {
  const documentItem = toolDocumentRows().find((item) => item.id === id);
  if (!documentItem) return;
  const pages = normalizeDocumentSlides(documentItem.slides, documentItem.content, documentItem.title);
  const orientation = documentOrientation(documentItem);
  const slideFormat = documentSlideFormat(documentItem);
  const content = `<div class="document-presentation" id="document-viewer-shell">
    <aside class="document-slide-list" id="document-viewer-list"></aside>
    <main class="document-stage-wrap"><button class="document-sidebar-toggle" id="document-sidebar-toggle" type="button" title="Recolher barra lateral" aria-label="Recolher barra lateral">‹</button><article class="document-slide documentation-page ${orientation} ${slideFormat}" id="document-viewer-slide"></article></main>
  </div><div class="modal-foot"><button class="btn" id="tool-document-close">Fechar</button><button class="btn" id="tool-document-present">Modo leitura</button>${currentUserIsAdmin() ? '<button class="btn primary" id="tool-document-detail-edit">Editar</button>' : ""}</div>`;
  const closePanel = nestedCenterModal(documentItem.title, content, { cls: "full document-viewer-modal", closeOnOverlay: true });
  let activeIndex = 0;
  const collapsedGroups = new Set();
  const draw = () => {
    const page = pages[activeIndex];
    document.getElementById("document-viewer-list").innerHTML = documentSlideGroups(pages).map((group) => `<section class="document-slide-group">
      <button class="document-group-toggle" data-group="${esc(group.name)}"><span>${collapsedGroups.has(group.name) ? "▸" : "▾"}</span><b>${esc(group.name)}</b><small>${group.items.length}</small></button>
      <div class="document-group-slides"${collapsedGroups.has(group.name) ? " hidden" : ""}>${group.items.map(({ slide: item, index }) => `<button class="document-slide-thumb${index === activeIndex ? " active" : ""}" data-index="${index}"><span>${index + 1}</span><b>${esc(item.subject)}</b></button>`).join("")}</div>
    </section>`).join("");
    const stage = document.getElementById("document-viewer-slide");
    stage.style.background = page.background;
    stage.innerHTML = documentPageMarkup(documentItem, page, activeIndex, pages.length);
    applyDocumentSlideDimensions(stage, orientation, slideFormat);
    document.querySelectorAll("#document-viewer-list .document-slide-thumb").forEach((button) => button.addEventListener("click", () => { activeIndex = Number(button.dataset.index); draw(); }));
    document.querySelectorAll("#document-viewer-list .document-group-toggle").forEach((button) => button.addEventListener("click", () => {
      const group = button.dataset.group;
      if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group);
      draw();
    }));
  };
  draw();
  document.getElementById("tool-document-close").addEventListener("click", closePanel);
  document.getElementById("document-sidebar-toggle").addEventListener("click", (event) => {
    const shell = document.getElementById("document-viewer-shell");
    const collapsed = shell.classList.toggle("sidebar-collapsed");
    event.currentTarget.textContent = collapsed ? "›" : "‹";
    event.currentTarget.title = collapsed ? "Expandir barra lateral" : "Recolher barra lateral";
    event.currentTarget.setAttribute("aria-label", event.currentTarget.title);
  });
  document.getElementById("tool-document-present").addEventListener("click", () => openToolDocumentPresentation(documentItem, pages, activeIndex));
  document.getElementById("tool-document-detail-edit")?.addEventListener("click", () => { closePanel(); openToolDocumentForm(id); });
}

function openLegacyToolDocumentForm(id = null) {
  if (!requireCurrentUserPermission("documents", id ? "edit" : "create", "Documentação")) return;
  const current = toolDocumentRows().find((item) => item.id === id) || {};
  let slides = normalizeDocumentSlides(current.slides, current.content, current.title);
  let activeIndex = 0;
  let orientation = documentOrientation(current);
  let slideFormat = documentSlideFormat(current);
  const content = `<div class="document-editor">
    <div class="document-editor-info">
      <input id="tool-document-title" value="${esc(current.title || "")}" placeholder="Nome da documentação">
      <input id="tool-document-category" value="${esc(current.category || "")}" placeholder="Categoria">
      <input id="tool-document-tags" value="${esc(normalizeTextList(current.tags).join(", "))}" placeholder="Tags separadas por vírgula">
      <div class="document-choice document-slide-format" role="group" aria-label="Formato do documento"><button class="${slideFormat === "widescreen" ? "active" : ""}" data-slide-format="widescreen" type="button">Widescreen 16:9</button><button class="${slideFormat === "standard" ? "active" : ""}" data-slide-format="standard" type="button">Padrão 4:3</button></div>
      <div class="document-choice document-orientation" role="group" aria-label="Orientação do documento"><button class="${orientation === "landscape" ? "active" : ""}" data-orientation="landscape" type="button">Paisagem</button><button class="${orientation === "portrait" ? "active" : ""}" data-orientation="portrait" type="button">Retrato</button></div>
    </div>
    <div class="document-editor-toolbar" role="toolbar" aria-label="Formatação de texto">
      <button class="tool-icon-btn document-format" data-command="bold" title="Negrito"><b>B</b></button>
      <button class="tool-icon-btn document-format" data-command="italic" title="Itálico"><i>I</i></button>
      <label title="Cor do texto"><span>Texto</span><input id="document-text-color" type="color" value="#111827"></label>
      <label title="Cor do slide"><span>Fundo</span><input id="document-background-color" type="color" value="#ffffff"></label>
      <button class="tool-icon-btn document-format" data-command="justifyLeft" title="Alinhar à esquerda">≡</button>
      <button class="tool-icon-btn document-format" data-command="justifyCenter" title="Centralizar">≡</button>
      <button class="tool-icon-btn document-format" data-command="justifyRight" title="Alinhar à direita">≡</button>
      <button class="tool-icon-btn document-format" data-command="justifyFull" title="Justificar">☰</button>
    </div>
    <div class="document-editor-workspace">
      <aside class="document-slide-list"><div id="document-editor-list"></div><div class="document-slide-list-actions"><button class="btn document-add-slide" id="document-add-slide">+ Slide</button><button class="btn document-add-slide" id="document-add-group">+ Grupo</button></div></aside>
      <main class="document-stage-wrap"><div class="document-slide document-slide-edit ${orientation} ${slideFormat}" id="document-editor-slide"><input id="document-slide-title" placeholder="Título do slide"><div id="document-slide-body" class="document-slide-body" contenteditable="true" data-placeholder="Digite o conteúdo do slide..."></div></div></main>
    </div>
  </div><div class="modal-foot"><button class="btn danger" id="document-delete-slide">Excluir slide</button><button class="btn" id="tool-document-cancel">Cancelar</button><button class="btn primary" id="tool-document-save">Salvar</button></div>`;
  const closePanel = nestedCenterModal(id ? "Editar documentação" : "Nova documentação", content, { cls: "full document-editor-modal", closeOnOverlay: true });
  const collapsedGroups = new Set();
  const persistActiveSlide = () => {
    const slide = slides[activeIndex];
    if (!slide) return;
    slide.title = document.getElementById("document-slide-title").value.trim() || `Slide ${activeIndex + 1}`;
    slide.html = sanitizeDocumentHtml(document.getElementById("document-slide-body").innerHTML);
    slide.background = document.getElementById("document-background-color").value;
  };
  const drawEditor = () => {
    const slide = slides[activeIndex];
    const groups = documentSlideGroups(slides);
    document.getElementById("document-editor-list").innerHTML = groups.map((group, groupIndex) => `<section class="document-slide-group" data-group="${esc(group.name)}" draggable="true">
      <div class="document-group-head"><button class="document-group-toggle" data-group="${esc(group.name)}"><span>${collapsedGroups.has(group.name) ? "▸" : "▾"}</span><b>${esc(group.name)}</b><small>${group.items.length}</small></button><span class="document-group-actions"><button class="tool-icon-btn document-group-up" data-group="${esc(group.name)}" title="Subir grupo"${groupIndex === 0 ? " disabled" : ""}>↑</button><button class="tool-icon-btn document-group-down" data-group="${esc(group.name)}" title="Descer grupo"${groupIndex === groups.length - 1 ? " disabled" : ""}>↓</button></span></div>
      <div class="document-group-slides"${collapsedGroups.has(group.name) ? " hidden" : ""}>${group.items.map(({ slide: item, index }) => `<button class="document-slide-thumb${index === activeIndex ? " active" : ""}" data-index="${index}"><span>${index + 1}</span><b>${esc(item.title || `Slide ${index + 1}`)}</b></button>`).join("")}</div>
    </section>`).join("");
    document.getElementById("document-slide-title").value = slide.title;
    document.getElementById("document-slide-body").innerHTML = sanitizeDocumentHtml(slide.html);
    document.getElementById("document-editor-slide").style.background = slide.background;
    document.getElementById("document-background-color").value = /^#[0-9a-f]{6}$/i.test(slide.background) ? slide.background : "#ffffff";
    document.getElementById("document-delete-slide").disabled = slides.length === 1;
    document.querySelectorAll("#document-editor-list .document-slide-thumb").forEach((button) => button.addEventListener("click", () => {
      persistActiveSlide(); activeIndex = Number(button.dataset.index); drawEditor();
    }));
    document.querySelectorAll("#document-editor-list .document-group-toggle").forEach((button) => button.addEventListener("click", () => {
      persistActiveSlide();
      const group = button.dataset.group;
      if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group);
      drawEditor();
    }));
    const moveGroup = (name, direction) => {
      persistActiveSlide();
      const activeId = slides[activeIndex].id;
      const ordered = documentSlideGroups(slides);
      const from = ordered.findIndex((group) => group.name === name);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= ordered.length) return;
      [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
      slides = ordered.flatMap((group) => group.items.map((item) => item.slide));
      activeIndex = slides.findIndex((item) => item.id === activeId);
      drawEditor();
    };
    document.querySelectorAll("#document-editor-list .document-group-up").forEach((button) => button.addEventListener("click", () => moveGroup(button.dataset.group, -1)));
    document.querySelectorAll("#document-editor-list .document-group-down").forEach((button) => button.addEventListener("click", () => moveGroup(button.dataset.group, 1)));
    document.querySelectorAll("#document-editor-list .document-slide-group").forEach((groupElement) => {
      groupElement.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", groupElement.dataset.group));
      groupElement.addEventListener("dragover", (event) => event.preventDefault());
      groupElement.addEventListener("drop", (event) => {
        event.preventDefault();
        const source = event.dataTransfer.getData("text/plain");
        const target = groupElement.dataset.group;
        if (!source || source === target) return;
        persistActiveSlide();
        const activeId = slides[activeIndex].id;
        const ordered = documentSlideGroups(slides);
        const from = ordered.findIndex((group) => group.name === source);
        const to = ordered.findIndex((group) => group.name === target);
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        slides = ordered.flatMap((group) => group.items.map((item) => item.slide));
        activeIndex = slides.findIndex((item) => item.id === activeId);
        drawEditor();
      });
    });
  };
  drawEditor();
  applyDocumentSlideDimensions(document.getElementById("document-editor-slide"), orientation, slideFormat);
  document.querySelectorAll(".document-orientation button").forEach((button) => button.addEventListener("click", () => {
    orientation = button.dataset.orientation;
    document.querySelectorAll(".document-orientation button").forEach((item) => item.classList.toggle("active", item === button));
    const stage = document.getElementById("document-editor-slide");
    stage.classList.toggle("landscape", orientation === "landscape");
    stage.classList.toggle("portrait", orientation === "portrait");
    applyDocumentSlideDimensions(stage, orientation, slideFormat);
  }));
  document.querySelectorAll(".document-slide-format button").forEach((button) => button.addEventListener("click", () => {
    slideFormat = button.dataset.slideFormat;
    document.querySelectorAll(".document-slide-format button").forEach((item) => item.classList.toggle("active", item === button));
    const stage = document.getElementById("document-editor-slide");
    stage.classList.toggle("widescreen", slideFormat === "widescreen");
    stage.classList.toggle("standard", slideFormat === "standard");
    applyDocumentSlideDimensions(stage, orientation, slideFormat);
  }));
  document.getElementById("document-slide-title").addEventListener("input", (event) => {
    slides[activeIndex].title = event.target.value;
    document.querySelector(`#document-editor-list .document-slide-thumb[data-index="${activeIndex}"] b`).textContent = event.target.value || `Slide ${activeIndex + 1}`;
  });
  document.getElementById("document-background-color").addEventListener("input", (event) => {
    slides[activeIndex].background = event.target.value;
    document.getElementById("document-editor-slide").style.background = event.target.value;
  });
  document.getElementById("document-text-color").addEventListener("input", (event) => {
    document.getElementById("document-slide-body").focus();
    document.execCommand("foreColor", false, event.target.value);
  });
  document.querySelectorAll(".document-format").forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    document.getElementById("document-slide-body").focus();
    document.execCommand(button.dataset.command, false);
  }));
  document.getElementById("document-add-slide").addEventListener("click", () => {
    persistActiveSlide();
    const group = slides[activeIndex]?.group || "Geral";
    slides.push({ id: crypto.randomUUID(), title: `Slide ${slides.length + 1}`, html: "", background: "#ffffff", group });
    activeIndex = slides.length - 1;
    drawEditor();
  });
  document.getElementById("document-add-group").addEventListener("click", () => {
    persistActiveSlide();
    const name = window.prompt("Nome do novo grupo:")?.trim();
    if (!name) return;
    if (slides.some((slide) => slide.group.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      toast("Já existe um grupo com esse nome.", true); return;
    }
    slides.push({ id: crypto.randomUUID(), title: `Slide ${slides.length + 1}`, html: "", background: "#ffffff", group: name });
    activeIndex = slides.length - 1;
    drawEditor();
  });
  document.getElementById("document-delete-slide").addEventListener("click", () => {
    if (slides.length === 1 || !window.confirm("Excluir este slide?")) return;
    slides.splice(activeIndex, 1);
    activeIndex = Math.max(0, activeIndex - 1);
    drawEditor();
  });
  document.getElementById("tool-document-cancel").addEventListener("click", closePanel);
  document.getElementById("tool-document-save").addEventListener("click", async () => {
    persistActiveSlide();
    const title = document.getElementById("tool-document-title").value.trim();
    const contentValue = documentSlideText(slides).trim();
    if (!title || !contentValue) { toast("Informe o nome e o conteúdo da documentação.", true); return; }
    const button = document.getElementById("tool-document-save");
    button.disabled = true; button.textContent = "Salvando...";
    const body = {
      title,
      category: document.getElementById("tool-document-category").value.trim() || null,
      tags: normalizeTextList(document.getElementById("tool-document-tags").value),
      content: contentValue,
      slides,
      orientation,
      slide_format: slideFormat,
      updated_at: new Date().toISOString()
    };
    try {
      const saved = id ? await updateRow("documents", id, body) : await createRow("documents", body);
      if (isLive()) {
        const index = remoteToolDocuments.findIndex((item) => item.id === saved.id);
        if (index >= 0) remoteToolDocuments[index] = saved; else remoteToolDocuments.unshift(saved);
        remoteToolDocumentsLoaded = true;
        remoteToolDocumentsLoadedAt = Date.now();
        saveToolsSessionCache("documents", remoteToolDocuments, remoteToolDocumentsLoadedAt);
      }
      toast("Documentação salva.");
      closePanel();
      if (document.getElementById("tools-root")) renderToolsSection();
    } catch (err) {
      button.disabled = false; button.textContent = "Salvar";
      toast("Erro ao salvar documentação · " + err.message, true);
    }
  });
}

function openToolDocumentForm(id = null) {
  if (!requireCurrentUserPermission("documents", id ? "edit" : "create", "Documentação")) return;
  const current = toolDocumentRows().find((item) => item.id === id) || {};
  documentationEditorState = {
    id,
    current,
    pages: normalizeDocumentSlides(current.slides, current.content, current.title),
    activeIndex: 0,
    orientation: documentOrientation(current),
    slideFormat: documentSlideFormat(current),
    collapsedGroups: new Set(),
    activeEditable: null,
    selectedBlockId: null,
    closePanel: null
  };
  const state = documentationEditorState;
  const typeOptions = Object.entries(DOCUMENT_TYPE_LABELS).map(([value, label]) => `<option value="${value}"${(current.document_type || "documentation") === value ? " selected" : ""}>${label}</option>`).join("");
  const blockOptions = Object.entries(DOCUMENT_BLOCK_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  const content = `<div class="document-editor documentation-editor">
    <div class="document-editor-info">
      <select id="tool-document-type" title="Tipo de documentação">${typeOptions}</select>
      <input id="tool-document-category" value="${esc(current.category || "")}" placeholder="Categoria">
      <input id="tool-document-system" value="${esc(current.system_name || "ENTERPRISER CMS")}" placeholder="Canal" title="Canal">
      <input id="tool-document-module" value="${esc(current.module_name || "")}" placeholder="Módulo" title="Módulo">
      <input id="tool-document-submodule" value="${esc(current.submodule_name || "")}" placeholder="Submódulo" title="Submódulo">
      <input id="tool-document-tags" value="${esc(normalizeTextList(current.tags).join(", "))}" placeholder="Tags">
    </div>
    <div class="document-editor-toolbar" role="toolbar" aria-label="Formatação e blocos">
      <button class="tool-icon-btn document-format" data-command="bold" title="Negrito"><b>B</b></button>
      <button class="tool-icon-btn document-format" data-command="italic" title="Itálico"><i>I</i></button>
      <button class="tool-icon-btn document-format" data-command="insertUnorderedList" title="Lista">•</button>
      <button class="tool-icon-btn document-format" data-command="insertOrderedList" title="Lista numerada">1.</button>
      <label><span>Texto</span><input id="document-text-color" type="color" value="#111827"></label>
      <label><span>Fundo texto</span><input id="document-highlight-color" type="color" value="#fff59d"></label>
      <label><span>Fundo</span><input id="document-background-color" type="color" value="#ffffff"></label>
      <button class="tool-icon-btn document-format" data-command="justifyLeft" title="Alinhar à esquerda">≡</button>
      <button class="tool-icon-btn document-format" data-command="justifyCenter" title="Centralizar">≡</button>
      <button class="tool-icon-btn document-format" data-command="justifyRight" title="Alinhar à direita">≡</button>
      <div class="document-choice document-slide-format"><button class="${state.slideFormat === "widescreen" ? "active" : ""}" data-slide-format="widescreen" type="button">16:9</button><button class="${state.slideFormat === "standard" ? "active" : ""}" data-slide-format="standard" type="button">4:3</button></div>
      <div class="document-choice document-orientation"><button class="${state.orientation === "landscape" ? "active" : ""}" data-orientation="landscape" type="button">Paisagem</button><button class="${state.orientation === "portrait" ? "active" : ""}" data-orientation="portrait" type="button">Retrato</button></div>
      <span class="documentation-toolbar-spacer"></span>
      <select id="document-new-block-type" title="Tipo do novo bloco">${blockOptions}</select>
      <select id="document-new-block-span" title="Largura do novo bloco">${[1, 2, 3, 4, 5, 6].map((span) => `<option value="${span}"${span === 6 ? " selected" : ""}>${span}/6</option>`).join("")}</select>
      <button class="tool-icon-btn" id="document-block-up" type="button" title="Mover bloco para cima">↑</button>
      <button class="tool-icon-btn" id="document-block-down" type="button" title="Mover bloco para baixo">↓</button>
      <button class="tool-icon-btn" id="document-block-delete" type="button" title="Excluir bloco">×</button>
      <button class="btn primary" id="document-add-block" type="button">+ Bloco</button>
    </div>
    <div class="document-editor-workspace">
      <aside class="document-slide-list"><div id="document-editor-list"></div><div class="document-slide-list-actions"><button class="btn document-add-slide" id="document-add-page">+ Página</button><button class="btn document-add-slide" id="document-clone-page" title="Clonar página atual">⧉ Clonar</button><button class="btn document-add-slide" id="document-add-group">+ Grupo</button></div></aside>
      <main class="document-stage-wrap"><article class="document-slide documentation-page documentation-page-edit ${state.orientation} ${state.slideFormat}" id="document-editor-page"></article></main>
    </div>
  </div><div class="modal-foot"><button class="btn danger" id="document-delete-page">Excluir página</button><button class="btn" id="tool-document-cancel">Cancelar</button><button class="btn primary" id="tool-document-save">Salvar</button></div>`;
  state.closePanel = nestedCenterModal(id ? "Editar documentação" : "Nova documentação", content, { cls: "full document-editor-modal", closeOnOverlay: true });
  renderDocumentationEditor();
  wireDocumentationEditorShell();
}

let documentationEditorState = null;

function selectedDocumentationBlock() {
  const state = documentationEditorState;
  const page = state?.pages[state.activeIndex];
  if (!page) return { page: null, block: null, index: -1 };
  const index = page.blocks.findIndex((item) => item.id === state.selectedBlockId);
  return { page, block: page.blocks[index] || null, index };
}

function syncDocumentationBlockToolbar() {
  const { page, block, index } = selectedDocumentationBlock();
  const typeSelect = document.getElementById("document-new-block-type");
  const spanSelect = document.getElementById("document-new-block-span");
  if (block) {
    typeSelect.value = block.type;
    spanSelect.value = String(block.span);
  }
  document.getElementById("document-block-up").disabled = !block || index === 0;
  document.getElementById("document-block-down").disabled = !block || index === page.blocks.length - 1;
  document.getElementById("document-block-delete").disabled = !block || page.blocks.length === 1;
}

function wireDocumentationEditorShell() {
  const state = documentationEditorState;
  document.getElementById("tool-document-cancel").addEventListener("click", state.closePanel);
  document.getElementById("tool-document-save").addEventListener("click", saveDocumentationEditor);
  ["tool-document-system", "tool-document-module"].forEach((id) => document.getElementById(id).addEventListener("input", () => {
    const draft = documentationEditorDocument();
    const stage = document.getElementById("document-editor-page");
    const system = stage.querySelector(".documentation-system");
    const module = stage.querySelector(".documentation-module");
    if (system) system.textContent = draft.system_name;
    if (module) module.textContent = draft.module_name;
  }));
  document.querySelectorAll(".documentation-editor .document-orientation button").forEach((button) => button.addEventListener("click", () => {
    state.orientation = button.dataset.orientation;
    document.querySelectorAll(".documentation-editor .document-orientation button").forEach((item) => item.classList.toggle("active", item === button));
    const stage = document.getElementById("document-editor-page");
    stage.classList.toggle("landscape", state.orientation === "landscape");
    stage.classList.toggle("portrait", state.orientation === "portrait");
    applyDocumentSlideDimensions(stage, state.orientation, state.slideFormat);
  }));
  document.querySelectorAll(".documentation-editor .document-slide-format button").forEach((button) => button.addEventListener("click", () => {
    state.slideFormat = button.dataset.slideFormat;
    document.querySelectorAll(".documentation-editor .document-slide-format button").forEach((item) => item.classList.toggle("active", item === button));
    const stage = document.getElementById("document-editor-page");
    stage.classList.toggle("widescreen", state.slideFormat === "widescreen");
    stage.classList.toggle("standard", state.slideFormat === "standard");
    applyDocumentSlideDimensions(stage, state.orientation, state.slideFormat);
  }));
  document.querySelectorAll(".documentation-editor .document-format").forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const editable = state.activeEditable || document.querySelector("#document-editor-page .documentation-block-content");
    editable?.focus();
    document.execCommand(button.dataset.command, false);
  }));
  document.getElementById("document-text-color").addEventListener("input", (event) => {
    const editable = state.activeEditable || document.querySelector("#document-editor-page .documentation-block-content");
    editable?.focus();
    document.execCommand("foreColor", false, event.target.value);
  });
  document.getElementById("document-highlight-color").addEventListener("input", (event) => {
    const editable = state.activeEditable || document.querySelector("#document-editor-page .documentation-block-content");
    editable?.focus();
    if (!document.execCommand("hiliteColor", false, event.target.value)) {
      document.execCommand("backColor", false, event.target.value);
    }
  });
  document.getElementById("document-background-color").addEventListener("input", (event) => {
    state.pages[state.activeIndex].background = event.target.value;
    document.getElementById("document-editor-page").style.background = event.target.value;
  });
  document.getElementById("document-new-block-type").addEventListener("change", (event) => {
    const { block } = selectedDocumentationBlock();
    if (!block) return;
    persistDocumentationEditorPage();
    block.type = event.target.value;
    renderDocumentationEditor();
  });
  document.getElementById("document-new-block-span").addEventListener("change", (event) => {
    const { block } = selectedDocumentationBlock();
    if (!block) return;
    persistDocumentationEditorPage();
    block.span = Number(event.target.value);
    renderDocumentationEditor();
  });
  const moveSelectedBlock = (direction) => {
    persistDocumentationEditorPage();
    const { page, index } = selectedDocumentationBlock();
    const target = index + direction;
    if (!page || index < 0 || target < 0 || target >= page.blocks.length) return;
    [page.blocks[index], page.blocks[target]] = [page.blocks[target], page.blocks[index]];
    renderDocumentationEditor();
  };
  document.getElementById("document-block-up").addEventListener("click", () => moveSelectedBlock(-1));
  document.getElementById("document-block-down").addEventListener("click", () => moveSelectedBlock(1));
  document.getElementById("document-block-delete").addEventListener("click", () => {
    persistDocumentationEditorPage();
    const { page, index } = selectedDocumentationBlock();
    if (!page || index < 0 || page.blocks.length === 1) return;
    page.blocks.splice(index, 1);
    state.selectedBlockId = page.blocks[Math.min(index, page.blocks.length - 1)]?.id || null;
    renderDocumentationEditor();
  });
  document.getElementById("document-add-block").addEventListener("click", () => {
    persistDocumentationEditorPage();
    const type = document.getElementById("document-new-block-type").value;
    const span = Number(document.getElementById("document-new-block-span").value);
    const block = normalizeDocumentBlock({ type, span, html: documentBlockStarterHtml(type) });
    state.pages[state.activeIndex].blocks.push(block);
    state.selectedBlockId = block.id;
    renderDocumentationEditor();
  });
  document.getElementById("document-add-page").addEventListener("click", () => {
    persistDocumentationEditorPage();
    const group = state.pages[state.activeIndex]?.group || "Geral";
    state.pages.push(normalizeDocumentSlides([{ title: `Página ${state.pages.length + 1}`, group, blocks: [{ type: "text", span: 6, html: "" }] }])[0]);
    state.activeIndex = state.pages.length - 1;
    state.selectedBlockId = null;
    renderDocumentationEditor();
  });
  document.getElementById("document-clone-page").addEventListener("click", () => {
    persistDocumentationEditorPage();
    const source = state.pages[state.activeIndex];
    const subject = `${source.subject || source.title || `Página ${state.activeIndex + 1}`} - Cópia`;
    const clone = normalizeDocumentSlides([{
      ...source,
      id: crypto.randomUUID(),
      title: subject,
      subject,
      breadcrumb_parts: Array.isArray(source.breadcrumb_parts) ? [...source.breadcrumb_parts] : source.breadcrumb_parts,
      blocks: source.blocks.map((block) => ({ ...block, id: crypto.randomUUID() }))
    }])[0];
    state.pages.splice(state.activeIndex + 1, 0, clone);
    state.activeIndex += 1;
    state.selectedBlockId = clone.blocks[0]?.id || null;
    renderDocumentationEditor();
  });
  document.getElementById("document-add-group").addEventListener("click", () => {
    persistDocumentationEditorPage();
    const name = window.prompt("Nome do novo grupo:")?.trim();
    if (!name) return;
    if (state.pages.some((page) => page.group.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      toast("Já existe um grupo com esse nome.", true); return;
    }
    state.pages.push(normalizeDocumentSlides([{ title: `Página ${state.pages.length + 1}`, group: name, blocks: [{ type: "text", span: 6, html: "" }] }])[0]);
    state.activeIndex = state.pages.length - 1;
    state.selectedBlockId = null;
    renderDocumentationEditor();
  });
  document.getElementById("document-delete-page").addEventListener("click", () => {
    if (state.pages.length === 1 || !window.confirm("Excluir esta página?")) return;
    state.pages.splice(state.activeIndex, 1);
    state.activeIndex = Math.max(0, state.activeIndex - 1);
    state.selectedBlockId = null;
    renderDocumentationEditor();
  });
}

async function saveDocumentationEditor() {
  const state = documentationEditorState;
  persistDocumentationEditorPage();
  const contentValue = documentSlideText(state.pages).trim();
  const metadata = {
    document_type: document.getElementById("tool-document-type").value,
    category: document.getElementById("tool-document-category").value.trim(),
    system_name: document.getElementById("tool-document-system").value.trim(),
    module_name: document.getElementById("tool-document-module").value.trim(),
    submodule_name: document.getElementById("tool-document-submodule").value.trim()
  };
  if (!metadata.category || !metadata.system_name || !metadata.module_name || !contentValue) {
    toast("Preencha tipo, categoria, canal, módulo e conteúdo.", true);
    return;
  }
  const button = document.getElementById("tool-document-save");
  button.disabled = true;
  button.textContent = "Salvando...";
  const body = {
    title: documentGeneratedTitle(metadata),
    system_name: metadata.system_name,
    module_name: metadata.module_name,
    submodule_name: metadata.submodule_name || null,
    document_type: metadata.document_type,
    category: metadata.category,
    tags: normalizeTextList(document.getElementById("tool-document-tags").value),
    content: contentValue,
    slides: state.pages,
    orientation: state.orientation,
    slide_format: state.slideFormat,
    updated_at: new Date().toISOString()
  };
  try {
    const saved = state.id ? await updateRow("documents", state.id, body) : await createRow("documents", body);
    if (isLive()) {
      const index = remoteToolDocuments.findIndex((item) => item.id === saved.id);
      if (index >= 0) remoteToolDocuments[index] = saved; else remoteToolDocuments.unshift(saved);
      remoteToolDocumentsLoaded = true;
      remoteToolDocumentsLoadedAt = Date.now();
      saveToolsSessionCache("documents", remoteToolDocuments, remoteToolDocumentsLoadedAt);
    }
    toast("Documentação salva.");
    state.closePanel();
    if (document.getElementById("tools-root")) renderToolsSection();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Salvar";
    toast("Erro ao salvar documentação · " + err.message, true);
  }
}

function documentationEditorDocument() {
  const state = documentationEditorState;
  return {
    ...state.current,
    system_name: document.getElementById("tool-document-system")?.value.trim() || "ENTERPRISER CMS",
    module_name: document.getElementById("tool-document-module")?.value.trim() || "GERAL",
    category: document.getElementById("tool-document-category")?.value.trim() || ""
  };
}

function persistDocumentationEditorPage() {
  const state = documentationEditorState;
  const page = state?.pages[state.activeIndex];
  if (!page) return;
  page.subject = document.getElementById("document-page-subject")?.value.trim() || `Página ${state.activeIndex + 1}`;
  page.title = page.subject;
  const breadcrumbEditor = document.querySelector("#document-editor-page .documentation-breadcrumb-editor");
  if (breadcrumbEditor) {
    page.breadcrumb_parts = [...breadcrumbEditor.querySelectorAll(".documentation-breadcrumb-chip")].map((item) => item.dataset.value).filter(Boolean);
    page.breadcrumb = page.breadcrumb_parts.join(" > ");
    page.breadcrumb_url = document.getElementById("document-breadcrumb-url")?.value.trim() || "";
  }
  document.querySelectorAll("#document-editor-page [data-block-id]").forEach((element) => {
    const block = page.blocks.find((item) => item.id === element.dataset.blockId);
    if (!block) return;
    block.html = sanitizeDocumentHtml(element.querySelector(".documentation-block-content")?.innerHTML || "");
  });
  page.html = page.blocks.map((block) => block.html).join("<br>");
}

function documentationEditorMoveGroup(name, direction) {
  persistDocumentationEditorPage();
  const state = documentationEditorState;
  const activeId = state.pages[state.activeIndex].id;
  const groups = documentSlideGroups(state.pages);
  const from = groups.findIndex((group) => group.name === name);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= groups.length) return;
  [groups[from], groups[to]] = [groups[to], groups[from]];
  state.pages = groups.flatMap((group) => group.items.map((item) => item.slide));
  state.activeIndex = state.pages.findIndex((page) => page.id === activeId);
  renderDocumentationEditor();
}

function renderDocumentationEditor() {
  const state = documentationEditorState;
  const page = state.pages[state.activeIndex];
  const groups = documentSlideGroups(state.pages);
  const list = document.getElementById("document-editor-list");
  list.innerHTML = groups.map((group, groupIndex) => `<section class="document-slide-group" data-group="${esc(group.name)}" draggable="true">
    <div class="document-group-head"><button class="document-group-toggle" data-group="${esc(group.name)}"><span>${state.collapsedGroups.has(group.name) ? "▸" : "▾"}</span><b>${esc(group.name)}</b><small>${group.items.length}</small></button><span class="document-group-actions"><button class="tool-icon-btn document-group-up" data-group="${esc(group.name)}"${groupIndex === 0 ? " disabled" : ""}>↑</button><button class="tool-icon-btn document-group-down" data-group="${esc(group.name)}"${groupIndex === groups.length - 1 ? " disabled" : ""}>↓</button></span></div>
    <div class="document-group-slides"${state.collapsedGroups.has(group.name) ? " hidden" : ""}>${group.items.map(({ slide, index }) => `<button class="document-slide-thumb${index === state.activeIndex ? " active" : ""}" data-index="${index}" data-slide-id="${esc(slide.id)}" draggable="true" title="Arraste para mover a página para outro grupo"><span>${index + 1}</span><b>${esc(slide.subject)}</b></button>`).join("")}</div>
  </section>`).join("");
  const stage = document.getElementById("document-editor-page");
  if (!page.blocks.some((block) => block.id === state.selectedBlockId)) state.selectedBlockId = page.blocks[0]?.id || null;
  stage.style.background = page.background;
  stage.innerHTML = documentPageMarkup(documentationEditorDocument(), page, state.activeIndex, state.pages.length, { editable: true, selectedBlockId: state.selectedBlockId });
  const backgroundInput = document.getElementById("document-background-color");
  if (backgroundInput) backgroundInput.value = /^#[0-9a-f]{6}$/i.test(page.background) ? page.background : "#ffffff";
  applyDocumentSlideDimensions(stage, state.orientation, state.slideFormat);
  document.getElementById("document-delete-page").disabled = state.pages.length === 1;
  syncDocumentationBlockToolbar();
  wireDocumentationEditorPage();
}

function wireDocumentationEditorPage() {
  const state = documentationEditorState;
  const page = state.pages[state.activeIndex];
  document.querySelectorAll("#document-editor-list .document-slide-thumb").forEach((button) => button.addEventListener("click", () => {
    persistDocumentationEditorPage();
    state.activeIndex = Number(button.dataset.index);
    state.selectedBlockId = null;
    renderDocumentationEditor();
  }));
  document.querySelectorAll("#document-editor-list .document-group-toggle").forEach((button) => {
    let clickTimer = null;
    button.addEventListener("click", () => {
      if (clickTimer) window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        persistDocumentationEditorPage();
        const group = button.dataset.group;
        if (state.collapsedGroups.has(group)) state.collapsedGroups.delete(group); else state.collapsedGroups.add(group);
        renderDocumentationEditor();
      }, 220);
    });
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (clickTimer) window.clearTimeout(clickTimer);
      persistDocumentationEditorPage();
      const currentName = button.dataset.group;
      const nextName = window.prompt("Renomear grupo:", currentName)?.trim();
      if (!nextName || nextName === currentName) return;
      if (state.pages.some((item) => item.group !== currentName && item.group.toLocaleLowerCase("pt-BR") === nextName.toLocaleLowerCase("pt-BR"))) {
        toast("Já existe um grupo com esse nome.", true); return;
      }
      state.pages.forEach((item) => { if (item.group === currentName) item.group = nextName; });
      if (state.collapsedGroups.delete(currentName)) state.collapsedGroups.add(nextName);
      renderDocumentationEditor();
    });
  });
  document.querySelectorAll("#document-editor-list .document-group-up").forEach((button) => button.addEventListener("click", () => documentationEditorMoveGroup(button.dataset.group, -1)));
  document.querySelectorAll("#document-editor-list .document-group-down").forEach((button) => button.addEventListener("click", () => documentationEditorMoveGroup(button.dataset.group, 1)));
  document.querySelectorAll("#document-editor-list .document-slide-thumb").forEach((button) => {
    button.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-document-slide-id", button.dataset.slideId);
    });
  });
  document.querySelectorAll("#document-editor-list .document-slide-group").forEach((groupElement) => {
    groupElement.addEventListener("dragstart", (event) => {
      if (event.target.closest(".document-slide-thumb")) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-document-group", groupElement.dataset.group);
    });
    groupElement.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      groupElement.classList.add("is-drag-target");
    });
    groupElement.addEventListener("dragleave", (event) => {
      if (!groupElement.contains(event.relatedTarget)) groupElement.classList.remove("is-drag-target");
    });
    groupElement.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      groupElement.classList.remove("is-drag-target");
      persistDocumentationEditorPage();
      const target = groupElement.dataset.group;
      const slideId = event.dataTransfer.getData("application/x-document-slide-id");
      if (slideId) {
        const activeId = state.pages[state.activeIndex].id;
        const sourceIndex = state.pages.findIndex((item) => item.id === slideId);
        if (sourceIndex < 0 || state.pages[sourceIndex].group === target) return;
        const [movedSlide] = state.pages.splice(sourceIndex, 1);
        movedSlide.group = target;
        const targetIndex = state.pages.reduce((last, item, index) => item.group === target ? index : last, -1);
        state.pages.splice(targetIndex + 1, 0, movedSlide);
        state.activeIndex = state.pages.findIndex((item) => item.id === activeId);
        state.collapsedGroups.delete(target);
        renderDocumentationEditor();
        return;
      }
      const source = event.dataTransfer.getData("application/x-document-group");
      if (!source || source === target) return;
      const groups = documentSlideGroups(state.pages);
      const from = groups.findIndex((group) => group.name === source);
      const to = groups.findIndex((group) => group.name === target);
      const [moved] = groups.splice(from, 1);
      groups.splice(to, 0, moved);
      const activeId = state.pages[state.activeIndex].id;
      state.pages = groups.flatMap((group) => group.items.map((item) => item.slide));
      state.activeIndex = state.pages.findIndex((item) => item.id === activeId);
      renderDocumentationEditor();
    });
  });
  const addBreadcrumbPart = () => {
    const input = document.getElementById("document-breadcrumb-add");
    const value = input?.value.trim();
    if (!value) return;
    persistDocumentationEditorPage();
    if (!Array.isArray(page.breadcrumb_parts)) page.breadcrumb_parts = [];
    page.breadcrumb_parts.push(value);
    page.breadcrumb = page.breadcrumb_parts.join(" > ");
    renderDocumentationEditor();
  };
  document.getElementById("document-breadcrumb-add-button")?.addEventListener("click", addBreadcrumbPart);
  document.getElementById("document-breadcrumb-add")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addBreadcrumbPart();
  });
  document.querySelectorAll("#document-editor-page .documentation-breadcrumb-chip").forEach((button) => button.addEventListener("click", () => {
    persistDocumentationEditorPage();
    page.breadcrumb_parts.splice(Number(button.dataset.index), 1);
    page.breadcrumb = page.breadcrumb_parts.join(" > ");
    renderDocumentationEditor();
  }));
  document.querySelectorAll("#document-editor-page .documentation-block-content").forEach((content) => {
    content.addEventListener("focus", () => {
      state.activeEditable = content;
      state.selectedBlockId = content.closest("[data-block-id]")?.dataset.blockId || null;
      document.querySelectorAll("#document-editor-page [data-block-id]").forEach((element) => {
        element.classList.toggle("is-selected", element.dataset.blockId === state.selectedBlockId);
      });
      syncDocumentationBlockToolbar();
    });
  });
}

async function cloneToolDocument(id) {
  if (!requireCurrentUserPermission("documents", "clone", "Documentação")) return;
  const source = toolDocumentRows().find((item) => item.id === id);
  if (!source) return;
  const slides = normalizeDocumentSlides(source.slides, source.content, source.title).map((page) => ({
    ...page,
    id: crypto.randomUUID(),
    blocks: page.blocks.map((block) => ({ ...block, id: crypto.randomUUID() }))
  }));
  const body = {
    title: documentGeneratedTitle(source),
    system_name: source.system_name || "ENTERPRISER CMS",
    module_name: source.module_name || null,
    submodule_name: source.submodule_name || null,
    document_type: source.document_type || "documentation",
    category: source.category || null,
    tags: normalizeTextList(source.tags),
    content: documentSlideText(slides).trim(),
    slides,
    orientation: documentOrientation(source),
    slide_format: documentSlideFormat(source),
    updated_at: new Date().toISOString()
  };
  try {
    const saved = await createRow("documents", body);
    if (isLive()) {
      remoteToolDocuments.unshift(saved);
      remoteToolDocumentsLoaded = true;
      remoteToolDocumentsLoadedAt = Date.now();
      saveToolsSessionCache("documents", remoteToolDocuments, remoteToolDocumentsLoadedAt);
    }
    toast("Documentação clonada.");
    renderToolsSection();
  } catch (err) {
    toast("Erro ao clonar documentação · " + err.message, true);
  }
}

async function deleteToolDocument(id) {
  if (!requireCurrentUserPermission("documents", "delete", "Documentação")) return;
  const documentItem = toolDocumentRows().find((item) => item.id === id);
  if (!documentItem || !window.confirm(`Excluir a documentação "${documentItem.title}"?`)) return;
  try {
    await deleteRow("documents", id);
    if (isLive()) {
      remoteToolDocuments = remoteToolDocuments.filter((item) => item.id !== id);
      remoteToolDocumentsLoadedAt = Date.now();
      saveToolsSessionCache("documents", remoteToolDocuments, remoteToolDocumentsLoadedAt);
    }
    toast("Documentação excluída.");
    renderToolsSection();
  } catch (err) {
    toast("Erro ao excluir documentação · " + err.message, true);
  }
}

function closeToolProcessPanel(closePanel) {
  closePanel?.();
  if (document.getElementById("tools-root")) renderToolsSection();
  else openToolsModal("processes");
}

function openToolProcess(id) {
  const process = toolProcessRows().find((item) => item.id === id);
  if (!process) return;
  const steps = normalizeProcessSteps(process.steps);
  const content = `<div class="process-detail">
    <div class="process-detail-meta"><span>${esc(process.category || "Sem categoria")}</span><span>${steps.length} etapa(s)</span><span>v${esc(process.version || 1)}</span></div>
    ${normalizeTextList(process.tags).length ? `<section><h4>Tags</h4><div class="tool-tags">${normalizeTextList(process.tags).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("")}</div></section>` : ""}
    <section><h4>Etapas</h4><div class="process-detail-steps">${steps.map((step, index) => {
      const reference = safeHttpUrl(step.url);
      const hierarchy = [step.module, step.submodule, step.group].filter(Boolean).join(" › ");
      return `<article class="process-detail-step">
        <div class="process-detail-step-head"><span>${index + 1}</span><strong>${esc(hierarchy || "Etapa sem classificação")}</strong></div>
        <div class="process-detail-step-meta"><b>${esc(step.system || "Sem sistema")}</b>${step.type ? `<em>${esc(step.type)}</em>` : ""}</div>
        <p>${esc(step.details || "Sem detalhes.")}</p>
        ${reference ? `<a href="${esc(reference)}" target="_blank" rel="noopener">Abrir URL ↗</a>` : ""}
      </article>`;
    }).join("") || '<p class="muted">Nenhuma etapa cadastrada.</p>'}</div></section>
  </div><div class="modal-foot"><button class="btn" id="tool-process-close">Fechar</button><button class="btn" id="tool-process-detail-flow">⇢ Fluxo visual</button>${currentUserIsAdmin() ? '<button class="btn primary" id="tool-process-detail-edit">Editar</button>' : ""}</div>`;
  const closePanel = document.getElementById("tools-root")
    ? nestedSidePanel(process.title, content, { closeOnOverlay: true })
    : sidePanel(process.title, content, { closeOnOverlay: true, onClose: () => openToolsModal("processes") });
  document.getElementById("tool-process-close").addEventListener("click", () => closeToolProcessPanel(closePanel));
  document.getElementById("tool-process-detail-flow").addEventListener("click", () => openToolProcessFlow(id));
  document.getElementById("tool-process-detail-edit")?.addEventListener("click", () => { closePanel(); openToolProcessForm(id); });
}

const PROCESS_ELEMENTS = { task: "Tarefa", decision: "Decisão", end: "Fim" };
const PROCESS_LANE_OPTIONS = [["responsible", "Responsável"], ["system", "Sistema"], ["module", "Módulo"]];
const BPMN = { laneHead: 150, levelW: 130, levelH: 40, colW: 250, rowH: 140, laneW: 236, rankH: 150, taskW: 196, taskH: 92, diamond: 96, event: 46, pad: 24 };
const BPMN_COMPACT = { rowH: 140, rankH: 150, taskH: 92 };
const BPMN_DETAILED = { rowH: 236, rankH: 244, taskH: 188 };
let processFlowShowDetails = (() => { try { return localStorage.getItem("processFlowShowDetails") === "1"; } catch { return false; } })();
Object.assign(BPMN, processFlowShowDetails ? BPMN_DETAILED : BPMN_COMPACT);
let processFlowLaneBy = (() => { try { return localStorage.getItem("processFlowLaneBy") || "responsible"; } catch { return "responsible"; } })();
let processFlowOrientation = (() => { try { return localStorage.getItem("processFlowOrientation") || "vertical"; } catch { return "vertical"; } })();
let processFlowZoom = 1;
let processFlowHandMode = false;

function processStepTitle(step, index) {
  if (step.label) return step.label;
  if (step.element === "end") return "Fim";
  return [step.system, step.module, step.submodule].filter(Boolean).join(" · ") || `Etapa ${index + 1}`;
}

function processFlowGraph(steps) {
  const nodes = [{ id: "__start", kind: "start" }];
  steps.forEach((step, index) => nodes.push({ id: step.id, kind: step.element || "task", step, index }));
  const known = new Set(steps.map((step) => step.id));
  const edges = [];
  let needsEnd = false;
  const nextOf = (index) => {
    if (index + 1 < steps.length) return steps[index + 1].id;
    needsEnd = true;
    return "__end";
  };
  if (steps.length) edges.push({ from: "__start", to: steps[0].id });
  else { needsEnd = true; edges.push({ from: "__start", to: "__end" }); }
  steps.forEach((step, index) => {
    if (step.element === "end") return;
    if (step.element === "decision" && step.outcomes?.length) {
      step.outcomes.forEach((outcome, outcomeIndex) => edges.push({ from: step.id, to: known.has(outcome.target) ? outcome.target : nextOf(index), label: outcome.label, exit: outcomeIndex }));
      return;
    }
    edges.push({ from: step.id, to: known.has(step.next) ? step.next : nextOf(index) });
  });
  if (needsEnd) nodes.push({ id: "__end", kind: "end", implicit: true, index: steps.length });
  return { nodes, edges };
}

function processFlowLaneOf(step, laneBy) {
  if (laneBy === "module") {
    const module = String(step?.module || "").trim();
    const submodule = String(step?.submodule || "").trim();
    if (!module && !submodule) return null;
    return { key: `${module || "Sem módulo"}\u0001${submodule || "Sem submódulo"}`, group: module || "Sem módulo", name: submodule || "Sem submódulo" };
  }
  const value = String((laneBy === "system" ? step?.system : step?.responsible) || "").trim();
  return value ? { key: value, group: null, name: value } : null;
}

function processFlowLayout(steps, laneBy, orientation = processFlowOrientation) {
  const graph = processFlowGraph(steps);
  const vertical = orientation === "vertical";
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const emptyLane = laneBy === "system" ? "Sem sistema" : laneBy === "module" ? null : "Sem responsável";
  const fallbackLane = laneBy === "module"
    ? { key: "Sem módulo\u0001Sem submódulo", group: "Sem módulo", name: "Sem submódulo" }
    : { key: emptyLane, group: null, name: emptyLane };
  const laneOf = new Map();
  let previousLane = null;
  graph.nodes.forEach((node) => {
    let source = node.step;
    if (node.kind === "start") source = steps[0];
    if (node.implicit) source = steps[steps.length - 1];
    let lane = processFlowLaneOf(source, laneBy);
    if (!lane) lane = node.kind !== "task" && previousLane ? previousLane : fallbackLane;
    laneOf.set(node.id, lane);
    if (node.kind !== "start") previousLane = lane;
  });
  const lanes = [];
  [...laneOf.values()].forEach((lane) => { if (!lanes.some((item) => item.key === lane.key)) lanes.push(lane); });
  if (laneBy === "module") {
    const groupOrder = [];
    lanes.forEach((lane) => { if (!groupOrder.includes(lane.group)) groupOrder.push(lane.group); });
    lanes.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
  }
  const rank = new Map();
  graph.nodes.forEach((node, index) => {
    if (node.kind === "start") { rank.set(node.id, 0); return; }
    const incoming = graph.edges.filter((edge) => edge.to === node.id && order.get(edge.from) < index && rank.has(edge.from));
    rank.set(node.id, incoming.length ? Math.max(...incoming.map((edge) => rank.get(edge.from) + 1)) : (rank.get(graph.nodes[index - 1].id) || 0) + 1);
  });
  const slots = new Map();
  const slotOf = new Map();
  graph.nodes.forEach((node) => {
    const key = `${laneOf.get(node.id).key}|${rank.get(node.id)}`;
    const slot = slots.get(key) || 0;
    slots.set(key, slot + 1);
    slotOf.set(node.id, slot);
  });
  const levels = laneBy === "module" ? 2 : 1;
  const laneUnit = vertical ? BPMN.laneW : BPMN.rowH;
  const head = vertical ? levels * BPMN.levelH : (levels === 2 ? 2 * BPMN.levelW : BPMN.laneHead);
  const laneSpan = new Map(lanes.map((lane) => [lane.key, Math.max(1, ...[...slots.entries()].filter(([key]) => key.startsWith(`${lane.key}|`)).map(([, count]) => count)) * laneUnit]));
  const laneStart = new Map();
  let offset = vertical ? 0 : 0;
  lanes.forEach((lane) => { laneStart.set(lane.key, offset); offset += laneSpan.get(lane.key); });
  const maxRank = Math.max(...rank.values());
  const size = (node) => node.kind === "task" ? [BPMN.taskW, BPMN.taskH] : node.kind === "decision" ? [BPMN.diamond, BPMN.diamond] : [BPMN.event, BPMN.event];
  const boxes = new Map(graph.nodes.map((node) => {
    const [w, h] = size(node);
    const lane = laneOf.get(node.id);
    const along = laneStart.get(lane.key) + slotOf.get(node.id) * laneUnit;
    const x = vertical ? along + (BPMN.laneW - w) / 2 : head + rank.get(node.id) * BPMN.colW + (BPMN.colW - w) / 2;
    const y = vertical ? head + rank.get(node.id) * BPMN.rankH + (BPMN.rankH - h) / 2 : along + (BPMN.rowH - h) / 2;
    return [node.id, { x, y, w, h, kind: node.kind }];
  }));
  const width = vertical ? offset : head + (maxRank + 1) * BPMN.colW + BPMN.pad;
  const height = vertical ? head + (maxRank + 1) * BPMN.rankH + BPMN.pad : offset;
  return { graph, lanes, laneStart, laneSpan, boxes, column: rank, width, height, head, levels, vertical };
}

function processFlowEntryPoint(box, side) {
  if (box.kind === "decision") {
    if (side === "right") return [box.x + box.w * 0.78, box.y + box.h * 0.28];
    return [box.x + box.w * 0.72, box.y + box.h * 0.78];
  }
  if (side === "right") return [box.x + box.w, box.y + box.h * 0.3];
  return [box.x + box.w * 0.72, box.y + box.h];
}

function processFlowEdgePath(edge, layout) {
  const from = layout.boxes.get(edge.from);
  const to = layout.boxes.get(edge.to);
  if (!from || !to) return null;
  const forward = layout.column.get(edge.to) > layout.column.get(edge.from);
  const exit = edge.exit || 0;
  if (layout.vertical) {
    let x1 = from.x + from.w / 2;
    let y1 = from.y + from.h;
    if (exit === 1) { x1 = from.x + from.w; y1 = from.y + from.h / 2; }
    if (exit === 2) { x1 = from.x; y1 = from.y + from.h / 2; }
    if (forward) {
      const x2 = to.x + to.w / 2;
      const y2 = to.y;
      if (exit === 1 || exit === 2) return { d: `M${x1},${y1} H${x2} V${y2 - 4}`, labelAt: [exit === 1 ? x1 + 6 : x1 - 30, y1 - 6] };
      const mid = y1 + Math.min(40, (y2 - y1) / 2);
      return { d: Math.abs(x1 - x2) < 1 ? `M${x1},${y1} V${y2 - 4}` : `M${x1},${y1} V${mid} H${x2} V${y2 - 4}`, labelAt: [x1 + 6, y1 + 14] };
    }
    const sx = exit === 2 ? from.x : from.x + from.w;
    const sy = from.y + from.h / 2;
    const [tx, ty] = processFlowEntryPoint(to, "right");
    const side = exit === 2 ? Math.min(from.x, to.x) - 18 - exit * 8 : Math.max(from.x + from.w, to.x + to.w) + 18 + exit * 8;
    return { d: `M${sx},${sy} H${side} V${ty} H${tx + 4}`, labelAt: [sx + (exit === 2 ? -30 : 6), sy - 6] };
  }
  let x1 = from.x + from.w;
  let y1 = from.y + from.h / 2;
  if (exit === 1) { x1 = from.x + from.w / 2; y1 = from.y + from.h; }
  if (exit === 2) { x1 = from.x + from.w / 2; y1 = from.y; }
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  if (forward) {
    if (exit === 1 || exit === 2) return { d: `M${x1},${y1} V${y2} H${x2 - 4}`, labelAt: [x1 + 6, exit === 1 ? y1 + 14 : y1 - 6] };
    const mid = x1 + Math.min(40, (x2 - x1) / 2);
    return { d: Math.abs(y1 - y2) < 1 ? `M${x1},${y1} H${x2 - 4}` : `M${x1},${y1} H${mid} V${y2} H${x2 - 4}`, labelAt: [x1 + 6, y1 - 6] };
  }
  const sx = exit === 2 ? x1 : from.x + from.w / 2;
  const sy = exit === 2 ? y1 : from.y + from.h;
  const [tx, ty] = processFlowEntryPoint(to, "bottom");
  const d = exit === 2
    ? `M${sx},${sy} V${Math.min(from.y, to.y) - 18} H${tx} V${to.y - 4}`
    : `M${sx},${sy} V${Math.max(from.y + from.h, to.y + to.h) + 18 + exit * 8} H${tx} V${ty + 4}`;
  return { d, labelAt: [sx + 6, exit === 2 ? sy - 6 : sy + 14] };
}

function processFlowHeadsHtml(layout) {
  const { vertical, lanes, laneStart, laneSpan, head, levels } = layout;
  const cell = (start, span, level, text, cls) => {
    const style = vertical
      ? `left:${start}px;width:${span}px;top:${level * BPMN.levelH}px;height:${BPMN.levelH}px`
      : `top:${start}px;height:${span}px;left:${level * BPMN.levelW}px;width:${levels === 2 ? BPMN.levelW : BPMN.laneHead}px`;
    return `<div class="bpmn-lane-head${cls ? ` ${cls}` : ""}" style="${style}"><span>${esc(text)}</span></div>`;
  };
  let cells = "";
  if (levels === 2) {
    const groups = [];
    lanes.forEach((lane) => {
      const last = groups[groups.length - 1];
      if (last && last.group === lane.group) last.span += laneSpan.get(lane.key);
      else groups.push({ group: lane.group, start: laneStart.get(lane.key), span: laneSpan.get(lane.key) });
    });
    cells += groups.map((group) => cell(group.start, group.span, 0, group.group, "is-group")).join("");
    cells += lanes.map((lane) => cell(laneStart.get(lane.key), laneSpan.get(lane.key), 1, lane.name)).join("");
  } else cells = lanes.map((lane) => cell(laneStart.get(lane.key), laneSpan.get(lane.key), 0, lane.name)).join("");
  const style = vertical ? `width:${layout.width}px;height:${head}px` : `width:${head}px;height:${layout.height}px`;
  return `<div class="bpmn-heads${vertical ? " is-vertical" : ""}" style="${style}">${cells}</div>`;
}

function processFlowCanvasHtml(process, steps) {
  const layout = processFlowLayout(steps, processFlowLaneBy, processFlowOrientation);
  const bands = layout.lanes.map((lane) => {
    const start = layout.laneStart.get(lane.key);
    const span = layout.laneSpan.get(lane.key);
    const style = layout.vertical ? `left:${start}px;width:${span}px;top:0;bottom:0` : `top:${start}px;height:${span}px;left:0;right:0`;
    return `<div class="bpmn-lane${layout.vertical ? " is-vertical" : ""}" style="${style}"></div>`;
  }).join("");
  const edges = layout.graph.edges.map((edge) => {
    const path = processFlowEdgePath(edge, layout);
    if (!path) return "";
    return `<path class="bpmn-edge" d="${path.d}" marker-end="url(#bpmn-arrow)"></path>${edge.label ? `<text class="bpmn-edge-label" x="${path.labelAt[0]}" y="${path.labelAt[1]}">${esc(edge.label)}</text>` : ""}`;
  }).join("");
  const nodes = layout.graph.nodes.map((node) => {
    const box = layout.boxes.get(node.id);
    const style = `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;
    const labelStyle = layout.vertical
      ? `left:${box.x + box.w + 8}px;top:${box.y + box.h / 2 - 7}px;text-align:left`
      : `left:${box.x - 27}px;top:${box.y + box.h + 4}px`;
    if (node.kind === "start") return `<div class="bpmn-node bpmn-event bpmn-start" style="${style}" title="Início"></div><span class="bpmn-event-label" style="${labelStyle}">Início</span>`;
    const step = node.step;
    if (node.kind === "end") {
      const label = node.implicit ? "Fim" : processStepTitle(step, node.index);
      return `<button class="bpmn-node bpmn-event bpmn-end" type="button" style="${style}" ${node.implicit ? "disabled" : `data-step="${esc(step.id)}"`} title="${esc(label)}"></button><span class="bpmn-event-label" style="${labelStyle}">${esc(label)}</span>`;
    }
    if (node.kind === "decision") return `<button class="bpmn-node bpmn-decision" type="button" style="${style}" data-step="${esc(step.id)}" title="${esc(step.label)}"><span class="bpmn-diamond" aria-hidden="true"></span><span class="bpmn-decision-text">${esc(step.label || "Decisão")}</span><span class="bpmn-number">${node.index + 1}</span></button>`;
    const meta = [step.system, step.module].filter(Boolean).join(" · ");
    if (processFlowShowDetails) {
      const rows = [["Resp.", step.responsible], ["Sistema", step.system], ["Módulo", [step.module, step.submodule].filter(Boolean).join(" › ")], ["Grupo", step.group], ["Tipo", step.type]].filter(([, value]) => value);
      return `<button class="bpmn-node bpmn-task is-detailed" type="button" style="${style}" data-step="${esc(step.id)}"><span class="bpmn-number">${node.index + 1}</span><strong>${esc(processStepTitle(step, node.index))}</strong>${rows.length ? `<span class="bpmn-task-meta">${rows.map(([label, value]) => `<span><b>${label}</b> ${esc(value)}</span>`).join("")}</span>` : ""}${step.details ? `<span class="bpmn-task-notes">${esc(step.details)}</span>` : ""}${safeHttpUrl(step.url) ? '<span class="bpmn-task-link">🔗 Link de referência</span>' : ""}</button>`;
    }
    return `<button class="bpmn-node bpmn-task" type="button" style="${style}" data-step="${esc(step.id)}"><span class="bpmn-number">${node.index + 1}</span><strong>${esc(processStepTitle(step, node.index))}</strong>${step.label && meta ? `<small>${esc(meta)}</small>` : ""}${step.responsible && processFlowLaneBy !== "responsible" ? `<em>${esc(step.responsible)}</em>` : ""}</button>`;
  }).join("");
  return `<div class="bpmn-canvas${layout.vertical ? " is-vertical" : ""}" style="width:${layout.width}px;height:${layout.height}px;zoom:${processFlowZoom}">${processFlowHeadsHtml(layout)}${bands}<svg class="bpmn-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="bpmn-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>${edges}</svg>${nodes}</div>`;
}

function processFlowDetailHtml(process, step, index) {
  if (!step) return "";
  const reference = safeHttpUrl(step.url);
  const rows = [
    ["Elemento", PROCESS_ELEMENTS[step.element] || "Tarefa"], ["Responsável", step.responsible], ["Sistema", step.system],
    ["Módulo", step.module], ["Submódulo", step.submodule], ["Grupo", step.group], ["Tipo", step.type]
  ].filter(([, value]) => value);
  const steps = normalizeProcessSteps(process.steps);
  const outcomes = (step.outcomes || []).map((outcome) => {
    const targetIndex = steps.findIndex((item) => item.id === outcome.target);
    return `<li><b>${esc(outcome.label || "—")}</b> → ${targetIndex >= 0 ? `${targetIndex + 1}. ${esc(processStepTitle(steps[targetIndex], targetIndex))}` : "seguinte da lista"}</li>`;
  }).join("");
  return `<header><span class="bpmn-number">${index + 1}</span><strong>${esc(processStepTitle(step, index))}</strong><button class="modal-close-x bpmn-detail-close" type="button" title="Fechar">✕</button></header>
    <dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    ${outcomes ? `<div class="bpmn-detail-block"><span>Saídas</span><ul>${outcomes}</ul></div>` : ""}
    ${step.details ? `<div class="bpmn-detail-block"><span>Detalhes</span><p>${esc(step.details)}</p></div>` : ""}
    ${reference ? `<div class="bpmn-detail-block"><span>URL</span><a href="${esc(reference)}" target="_blank" rel="noopener">${esc(step.url)} ↗</a></div>` : ""}
    ${currentUserCan("processes", "edit") ? '<button class="btn primary bpmn-detail-edit" type="button">Editar processo</button>' : ""}`;
}

function wrapFlowText(text, maxChars, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; }
    else line = next;
  });
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`;
    return kept;
  }
  return lines;
}

// Monta o fluxo como SVG independente (tema claro) para salvar em PNG/PDF.
function processFlowSvgMarkup(process, steps) {
  const layout = processFlowLayout(steps, processFlowLaneBy, processFlowOrientation);
  const color = { bg: "#ffffff", laneA: "#f7f9fc", laneB: "#eef2f7", head: "#e3e9f2", group: "#d6e2f5", border: "#cfd8e5", text: "#17243b", muted: "#5d6b82", blue: "#2f6bd8", cyan: "#1593b8", orange: "#d79422", red: "#d64545", green: "#2fb36d" };
  const pad = 24;
  const titleH = 46;
  const width = layout.width + pad * 2;
  const height = layout.height + pad * 2 + titleH;
  const t = (x, y, value, size, weight = 600, fill = color.text, anchor = "start") => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
  const lines = (x, y, values, size, weight, fill, anchor = "start", lineHeight = size * 1.3) => values.map((value, index) => t(x, y + index * lineHeight, value, size, weight, fill, anchor)).join("");
  const parts = [];
  parts.push(`<rect width="${width}" height="${height}" fill="${color.bg}"/>`);
  parts.push(t(pad, 30, `Fluxo BPMN · ${process.title || "Processo"}`, 16, 800));
  parts.push(t(width - pad, 30, [process.category, process.system_name].filter(Boolean).join(" · "), 11, 600, color.muted, "end"));
  parts.push(`<g transform="translate(${pad},${pad + titleH - 10})">`);
  layout.lanes.forEach((lane, index) => {
    const start = layout.laneStart.get(lane.key);
    const span = layout.laneSpan.get(lane.key);
    parts.push(layout.vertical
      ? `<rect x="${start}" y="0" width="${span}" height="${layout.height}" fill="${index % 2 ? color.laneB : color.laneA}" stroke="${color.border}"/>`
      : `<rect x="0" y="${start}" width="${layout.width}" height="${span}" fill="${index % 2 ? color.laneB : color.laneA}" stroke="${color.border}"/>`);
  });
  const headCell = (start, span, level, text, fill) => {
    if (layout.vertical) {
      const x = start; const y = level * BPMN.levelH; const w = span; const h = BPMN.levelH;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${color.border}"/>${lines(x + w / 2, y + h / 2 + 4, wrapFlowText(String(text).toLocaleUpperCase("pt-BR"), Math.max(8, Math.floor(w / 7)), 1), 10, 800, color.text, "middle")}`;
    }
    const w = layout.levels === 2 ? BPMN.levelW : BPMN.laneHead; const x = level * BPMN.levelW; const y = start; const h = span;
    const wrapped = wrapFlowText(String(text).toLocaleUpperCase("pt-BR"), Math.floor(w / 7), 4);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${color.border}"/>${lines(x + w / 2, y + h / 2 - (wrapped.length - 1) * 6.5 + 4, wrapped, 10, 800, color.text, "middle", 13)}`;
  };
  if (layout.levels === 2) {
    const groups = [];
    layout.lanes.forEach((lane) => {
      const last = groups[groups.length - 1];
      if (last && last.group === lane.group) last.span += layout.laneSpan.get(lane.key);
      else groups.push({ group: lane.group, start: layout.laneStart.get(lane.key), span: layout.laneSpan.get(lane.key) });
    });
    groups.forEach((group) => parts.push(headCell(group.start, group.span, 0, group.group, color.group)));
    layout.lanes.forEach((lane) => parts.push(headCell(layout.laneStart.get(lane.key), layout.laneSpan.get(lane.key), 1, lane.name, color.head)));
  } else layout.lanes.forEach((lane) => parts.push(headCell(layout.laneStart.get(lane.key), layout.laneSpan.get(lane.key), 0, lane.name, color.head)));
  parts.push(`<defs><marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${color.cyan}"/></marker></defs>`);
  layout.graph.edges.forEach((edge) => {
    const path = processFlowEdgePath(edge, layout);
    if (!path) return;
    parts.push(`<path d="${path.d}" fill="none" stroke="${color.cyan}" stroke-width="1.5" marker-end="url(#flow-arrow)"/>`);
    if (edge.label) parts.push(`<text x="${path.labelAt[0]}" y="${path.labelAt[1]}" font-size="10" font-weight="700" fill="${color.text}" stroke="${color.bg}" stroke-width="3" paint-order="stroke">${esc(edge.label)}</text>`);
  });
  layout.graph.nodes.forEach((node) => {
    const box = layout.boxes.get(node.id);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const labelX = layout.vertical ? box.x + box.w + 8 : cx;
    const labelY = layout.vertical ? cy + 4 : box.y + box.h + 14;
    const anchor = layout.vertical ? "start" : "middle";
    if (node.kind === "start") {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${box.w / 2 - 1}" fill="${color.bg}" stroke="${color.green}" stroke-width="2"/>`, t(labelX, labelY, "Início", 10, 700, color.muted, anchor));
      return;
    }
    if (node.kind === "end") {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${box.w / 2 - 3}" fill="${color.bg}" stroke="${color.red}" stroke-width="5"/>`, t(labelX, labelY, node.implicit ? "Fim" : processStepTitle(node.step, node.index), 10, 700, color.muted, anchor));
      return;
    }
    if (node.kind === "decision") {
      const r = box.w / 2 - 2;
      parts.push(`<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" fill="${color.bg}" stroke="${color.orange}" stroke-width="2"/>`);
      const wrapped = wrapFlowText(node.step.label || "Decisão", 13, 3);
      parts.push(lines(cx, cy - (wrapped.length - 1) * 6 + 3, wrapped, 9.5, 700, color.text, "middle", 12));
      parts.push(`<circle cx="${cx}" cy="${box.y + 4}" r="10" fill="${color.orange}"/>`, t(cx, box.y + 7.5, String(node.index + 1), 9, 800, "#ffffff", "middle"));
      return;
    }
    const step = node.step;
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="${color.bg}" stroke="${color.border}"/>`);
    parts.push(`<rect x="${box.x}" y="${box.y}" width="3" height="${box.h}" rx="1.5" fill="${color.blue}"/>`);
    parts.push(`<circle cx="${box.x + 18}" cy="${box.y + 18}" r="10" fill="${color.blue}"/>`, t(box.x + 18, box.y + 21.5, String(node.index + 1), 9, 800, "#ffffff", "middle"));
    const title = wrapFlowText(processStepTitle(step, node.index), 24, 3);
    parts.push(lines(box.x + 36, box.y + 22, title, 10.5, 700, color.text, "start", 13.5));
    const meta = [step.label ? [step.system, step.module].filter(Boolean).join(" · ") : "", step.responsible && processFlowLaneBy !== "responsible" ? step.responsible : ""].filter(Boolean).join(" — ");
    if (meta) parts.push(t(box.x + 36, box.y + 22 + title.length * 13.5 + 2, meta.length > 34 ? `${meta.slice(0, 33)}…` : meta, 9, 500, color.muted));
  });
  parts.push("</g>");
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Urbanist, Arial, Helvetica, sans-serif">${parts.join("")}</svg>`, width, height };
}

async function processFlowPngBlob(process, steps, scale = 2) {
  const { svg, width, height } = processFlowSvgMarkup(process, steps);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Não foi possível gerar a imagem do fluxo."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { blob, dataUrl: canvas.toDataURL("image/png"), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    script.onload = () => window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error("PDF indisponível."));
    script.onerror = () => reject(new Error("Não foi possível carregar o gerador de PDF."));
    document.head.appendChild(script);
  });
}

async function exportProcessFlow(process, steps, format) {
  if (!steps.length) { toast("Cadastre etapas para exportar o fluxo.", true); return; }
  const baseName = `fluxo_${String(process.title || "processo").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase() || "processo"}`;
  try {
    const image = await processFlowPngBlob(process, steps, format === "pdf" ? 2 : 2);
    if (format === "png") {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(image.blob);
      link.download = `${baseName}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast("PNG do fluxo salvo.");
      return;
    }
    const JsPdf = await loadJsPdf();
    const orientation = image.width >= image.height ? "landscape" : "portrait";
    const pdf = new JsPdf({ orientation, unit: "pt", format: [image.width, image.height] });
    pdf.addImage(image.dataUrl, "PNG", 0, 0, image.width, image.height);
    pdf.save(`${baseName}.pdf`);
    toast("PDF do fluxo salvo.");
  } catch (err) {
    toast("Erro ao exportar o fluxo · " + err.message, true);
  }
}

function openToolProcessFlow(id) {
  const process = toolProcessRows().find((item) => item.id === id);
  if (!process) return;
  const steps = normalizeProcessSteps(process.steps);
  const laneLabel = () => (PROCESS_LANE_OPTIONS.find(([value]) => value === processFlowLaneBy) || PROCESS_LANE_OPTIONS[0])[1];
  const content = `<div class="bpmn-view">
    <div class="bpmn-toolbar">
      <div class="bpmn-summary"><span>Categoria <b>${esc(process.category || "—")}</b></span><span>Canal <b>${esc(process.system_name || "—")}</b></span><span>Etapas <b>${steps.length}</b></span></div>
    </div>
    <div class="bpmn-body"><div class="registration-mind-controls bpmn-floating" role="group" aria-label="Controles do fluxo"><button class="view bpmn-orientation${processFlowOrientation === "horizontal" ? " active" : ""}" type="button" data-orientation="horizontal" title="Fluxo na horizontal" aria-label="Fluxo na horizontal">⇆</button><button class="view bpmn-orientation${processFlowOrientation === "vertical" ? " active" : ""}" type="button" data-orientation="vertical" title="Fluxo na vertical" aria-label="Fluxo na vertical">⇅</button><span class="bpmn-floating-sep" aria-hidden="true"></span><button class="view bpmn-zoom-out" type="button" title="Diminuir zoom" aria-label="Diminuir zoom">−</button><button class="view registration-mind-zoom bpmn-zoom-reset" type="button" title="Zoom: Ctrl + rolar a bolinha ou pinça. Clique para voltar a 100%">${Math.round(processFlowZoom * 100)}%</button><button class="view bpmn-zoom-in" type="button" title="Aumentar zoom" aria-label="Aumentar zoom">+</button><span class="bpmn-floating-sep" aria-hidden="true"></span><button class="view bpmn-hand${processFlowHandMode ? " active" : ""}" type="button" title="Mãozinha: arraste para navegar, inclusive sobre as etapas" aria-label="Mãozinha" aria-pressed="${processFlowHandMode}">✋</button><button class="view bpmn-fullscreen" type="button" title="Tela cheia" aria-label="Tela cheia">⛶</button><span class="bpmn-floating-sep" aria-hidden="true"></span><span class="bpmn-lane-group"><button class="view bpmn-details-toggle${processFlowShowDetails ? " active" : ""}" type="button" title="Mostrar detalhes nas etapas" aria-label="Mostrar detalhes nas etapas" aria-pressed="${processFlowShowDetails}">ⓘ</button><button class="view bpmn-lane-btn bpmn-lane-menu-btn" type="button" title="Raias do fluxo">${laneLabel()} ▾</button></span><span class="bpmn-export"><span class="bpmn-floating-sep" aria-hidden="true"></span><button class="view bpmn-lane-btn bpmn-export-pdf" type="button" title="Salvar o fluxo em PDF">PDF</button><button class="view bpmn-lane-btn bpmn-export-png" type="button" title="Salvar o fluxo em PNG">PNG</button></span></div><div class="bpmn-scroll">${steps.length ? processFlowCanvasHtml(process, steps) : '<div class="tool-empty">Nenhuma etapa cadastrada.</div>'}</div><aside class="bpmn-detail" hidden></aside></div>
  </div><div class="modal-foot"><button class="btn" id="tool-process-flow-close">Fechar</button></div>`;
  let flowCleanup = null;
  const closeFlow = nestedCenterModal(`Fluxo BPMN · ${process.title}`, content, {
    cls: "full process-flow-modal",
    closeOnOverlay: true,
    onClose: () => { flowCleanup?.(); if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {}); }
  });
  document.getElementById("tool-process-flow-close").addEventListener("click", closeFlow);
  const view = document.querySelector(".process-flow-modal .bpmn-view");
  if (!view) return;
  const scroller = view.querySelector(".bpmn-scroll");
  const detail = view.querySelector(".bpmn-detail");
  const zoomLabel = view.querySelector(".bpmn-zoom-reset");
  let suppressNodeClick = false;
  const wireNodes = () => scroller.querySelectorAll(".bpmn-node[data-step]").forEach((node) => node.addEventListener("click", () => {
    if (suppressNodeClick) { suppressNodeClick = false; return; }
    const index = steps.findIndex((step) => step.id === node.dataset.step);
    scroller.querySelectorAll(".bpmn-node.is-selected").forEach((item) => item.classList.remove("is-selected"));
    node.classList.add("is-selected");
    detail.innerHTML = processFlowDetailHtml(process, steps[index], index);
    detail.hidden = false;
    detail.querySelector(".bpmn-detail-close")?.addEventListener("click", () => { detail.hidden = true; node.classList.remove("is-selected"); });
    detail.querySelector(".bpmn-detail-edit")?.addEventListener("click", () => openToolProcessForm(process.id, {
      focusStep: node.dataset.step,
      onSaved: () => {
        const position = { left: scroller.scrollLeft, top: scroller.scrollTop };
        closeFlow();
        openToolProcessFlow(process.id);
        const next = document.querySelector(".process-flow-modal .bpmn-scroll");
        if (next) { next.scrollLeft = position.left; next.scrollTop = position.top; }
      }
    }));
  }));
  const redraw = () => {
    if (!steps.length) return;
    scroller.innerHTML = processFlowCanvasHtml(process, steps);
    wireNodes();
  };
  wireNodes();
  view.querySelectorAll(".bpmn-orientation").forEach((button) => button.addEventListener("click", () => {
    processFlowOrientation = button.dataset.orientation;
    try { localStorage.setItem("processFlowOrientation", processFlowOrientation); } catch {}
    view.querySelectorAll(".bpmn-orientation").forEach((item) => item.classList.toggle("active", item === button));
    detail.hidden = true;
    redraw();
  }));
  const laneMenuButton = view.querySelector(".bpmn-lane-menu-btn");
  laneMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const existing = view.querySelector(".bpmn-lane-menu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.className = "bpmn-lane-menu";
    menu.innerHTML = `<div class="bpmn-lane-menu-head">Raias por</div>${PROCESS_LANE_OPTIONS.map(([value, label]) => `<button type="button" data-lane-by="${value}" class="${processFlowLaneBy === value ? "active" : ""}">${processFlowLaneBy === value ? "✓ " : ""}${label}</button>`).join("")}`;
    laneMenuButton.parentElement.appendChild(menu);
    const close = (clickEvent) => { if (!menu.contains(clickEvent.target)) { menu.remove(); document.removeEventListener("mousedown", close, true); } };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
    menu.querySelectorAll("[data-lane-by]").forEach((button) => button.addEventListener("click", () => {
      processFlowLaneBy = button.dataset.laneBy;
      try { localStorage.setItem("processFlowLaneBy", processFlowLaneBy); } catch {}
      laneMenuButton.textContent = `${laneLabel()} ▾`;
      menu.remove();
      document.removeEventListener("mousedown", close, true);
      detail.hidden = true;
      redraw();
    }));
  });
  view.querySelector(".bpmn-details-toggle").addEventListener("click", (event) => {
    processFlowShowDetails = !processFlowShowDetails;
    try { localStorage.setItem("processFlowShowDetails", processFlowShowDetails ? "1" : "0"); } catch {}
    Object.assign(BPMN, processFlowShowDetails ? BPMN_DETAILED : BPMN_COMPACT);
    event.currentTarget.classList.toggle("active", processFlowShowDetails);
    event.currentTarget.setAttribute("aria-pressed", String(processFlowShowDetails));
    redraw();
  });
  const setZoom = (next, clientX, clientY) => {
    const canvas = scroller.querySelector(".bpmn-canvas");
    if (!canvas) return;
    const zoom = Math.min(2, Math.max(0.3, Math.round(next * 100) / 100));
    const previous = processFlowZoom;
    if (zoom === previous) return;
    const rect = scroller.getBoundingClientRect();
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const contentX = (scroller.scrollLeft + x) / previous;
    const contentY = (scroller.scrollTop + y) / previous;
    processFlowZoom = zoom;
    canvas.style.zoom = zoom;
    scroller.scrollLeft = contentX * zoom - x;
    scroller.scrollTop = contentY * zoom - y;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };
  view.querySelector(".bpmn-zoom-in").addEventListener("click", () => setZoom(processFlowZoom * 1.15));
  view.querySelector(".bpmn-zoom-out").addEventListener("click", () => setZoom(processFlowZoom / 1.15));
  zoomLabel.addEventListener("click", () => setZoom(1));
  scroller.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(processFlowZoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
  }, { passive: false });
  let drag = null;
  scroller.addEventListener("pointerdown", (event) => {
    suppressNodeClick = false;
    if (event.button !== 0 || event.pointerType === "touch") return;
    if (!processFlowHandMode && event.target.closest(".bpmn-node[data-step]")) return;
    drag = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, id: event.pointerId, moved: false };
  });
  scroller.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { drag.moved = true; scroller.setPointerCapture?.(drag.id); scroller.classList.add("is-panning"); }
    scroller.scrollLeft = drag.left - dx;
    scroller.scrollTop = drag.top - dy;
  });
  const endDrag = () => { if (drag?.moved) suppressNodeClick = true; drag = null; scroller.classList.remove("is-panning"); };
  const modal = view.closest(".process-flow-modal");
  view.querySelector(".bpmn-hand").addEventListener("click", (event) => {
    processFlowHandMode = !processFlowHandMode;
    event.currentTarget.classList.toggle("active", processFlowHandMode);
    event.currentTarget.setAttribute("aria-pressed", String(processFlowHandMode));
    view.classList.toggle("is-hand", processFlowHandMode);
  });
  view.classList.toggle("is-hand", processFlowHandMode);
  const setFullscreen = (on, touchBrowser = true) => {
    modal?.classList.toggle("is-fullscreen", on);
    const button = view.querySelector(".bpmn-fullscreen");
    button.textContent = on ? "✕" : "⛶";
    button.title = on ? "Sair da tela cheia (Esc)" : "Tela cheia";
    button.classList.toggle("active", on);
    if (!touchBrowser) return;
    try {
      if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.()?.catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
    } catch {}
  };
  view.querySelector(".bpmn-fullscreen").addEventListener("click", () => setFullscreen(!modal?.classList.contains("is-fullscreen")));
  const onFullscreenChange = () => { if (!document.fullscreenElement && modal?.classList.contains("is-fullscreen")) setFullscreen(false, false); };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  flowCleanup = () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  view.querySelector(".bpmn-export-png").addEventListener("click", () => exportProcessFlow(process, steps, "png"));
  view.querySelector(".bpmn-export-pdf").addEventListener("click", () => exportProcessFlow(process, steps, "pdf"));
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointercancel", endDrag);
  let pinch = null;
  const distance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  scroller.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2) return;
    pinch = { distance: distance(event.touches) || 1, zoom: processFlowZoom };
    event.preventDefault();
  }, { passive: false });
  scroller.addEventListener("touchmove", (event) => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const [a, b] = event.touches;
    setZoom(pinch.zoom * (distance(event.touches) / pinch.distance), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  }, { passive: false });
  scroller.addEventListener("touchend", (event) => { if (event.touches.length < 2) pinch = null; });
}

function processStepTargetOptions(steps, index, selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel)}</option>${steps.map((target, targetIndex) => targetIndex === index ? "" :
    `<option value="${esc(target.id)}"${target.id === selected ? " selected" : ""}>${targetIndex + 1}. ${esc(processStepTitle(target, targetIndex))}</option>`).join("")}`;
}

function processStepEditorHtml(steps) {
  const responsibleOptions = [...assigneeJobTitleOptions().map((option) => option.value), "Cliente", "Sistema"];
  const datalist = `<datalist id="process-responsible-options">${responsibleOptions.map((value) => `<option value="${esc(value)}"></option>`).join("")}</datalist>`;
  return datalist + steps.map((step, index) => {
    const element = step.element || "task";
    const elementOptions = Object.entries(PROCESS_ELEMENTS).map(([value, label]) => `<option value="${value}"${value === element ? " selected" : ""}>${label}</option>`).join("");
    const head = `<div class="process-step-grid process-step-bpmn">
        <label>Elemento<select class="process-step-input" data-field="element">${elementOptions}</select></label>
        <label>${element === "decision" ? "Pergunta *" : element === "end" ? "Resultado" : "Nome da etapa"}<input class="process-step-input" data-field="label" value="${esc(step.label)}" placeholder="${element === "decision" ? "Ex.: Pedido aprovado?" : element === "end" ? "Ex.: Pedido faturado" : "Opcional — usa Sistema · Módulo"}"></label>
        <label>Responsável<input class="process-step-input" data-field="responsible" list="process-responsible-options" value="${esc(step.responsible)}" placeholder="Cargo, Cliente ou Sistema"></label>
        ${element === "task" ? `<label>Próxima etapa<select class="process-step-input" data-field="next">${processStepTargetOptions(steps, index, step.next, "Seguinte da lista")}</select></label>` : ""}
      </div>`;
    const outcomes = element === "decision" ? `<div class="process-step-outcomes"><div class="process-step-outcomes-head"><span>Saídas</span><button class="btn process-outcome-add" type="button">+ Saída</button></div>
        ${(step.outcomes || []).map((outcome, outcomeIndex) => `<div class="process-outcome-row" data-outcome="${outcomeIndex}">
          <input class="process-outcome-input" data-field="label" value="${esc(outcome.label)}" placeholder="Ex.: Sim">
          <select class="process-outcome-input" data-field="target">${processStepTargetOptions(steps, index, outcome.target, "Seguinte da lista")}</select>
          <button class="tool-icon-btn process-outcome-remove" type="button" title="Remover saída">×</button>
        </div>`).join("") || '<span class="muted process-outcome-empty">Sem saídas: segue para a próxima etapa da lista.</span>'}
      </div>` : "";
    const taskFields = element === "task" ? `<div class="process-step-grid">
        <label>Sistema *<input class="process-step-input" data-field="system" value="${esc(step.system)}" placeholder="Ex.: Bling"></label>
        <label>Módulo *<input class="process-step-input" data-field="module" value="${esc(step.module)}" placeholder="Ex.: Vendas"></label>
        <label>Submódulo<input class="process-step-input" data-field="submodule" value="${esc(step.submodule)}" placeholder="Ex.: Pedidos de venda"></label>
        <label>Grupo<input class="process-step-input" data-field="group" value="${esc(step.group)}" placeholder="Ex.: Cadastro"></label>
        <label>Tipo<input class="process-step-input" data-field="type" value="${esc(step.type)}" placeholder="Ex.: Procedimento"></label>
        <label>URL<input class="process-step-input" data-field="url" type="url" value="${esc(step.url)}" placeholder="https://..."></label>
      </div>
      <label class="process-step-details">Detalhes<textarea class="process-step-input" data-field="details" rows="4" placeholder="Explique como executar esta etapa">${esc(step.details)}</textarea></label>` : "";
    return `<div class="process-step-editor process-step-${element}" data-index="${index}">
    <div class="process-step-number">${index + 1}</div><div class="process-step-fields">${head}${outcomes}${taskFields}</div>
    <div class="process-step-actions"><button class="tool-icon-btn process-step-up" type="button" title="Subir">↑</button><button class="tool-icon-btn process-step-down" type="button" title="Descer">↓</button><button class="tool-icon-btn process-step-remove" type="button" title="Excluir">×</button></div>
  </div>`;
  }).join("");
}

function emptyProcessStep() {
  return { id: crypto.randomUUID(), system: "", module: "", submodule: "", group: "", type: "", url: "", details: "", element: "task", label: "", responsible: "", next: "", outcomes: [] };
}

function openToolProcessForm(id = null, options = {}) {
  if (!requireCurrentUserPermission("processes", id ? "edit" : "create", "Processos")) return;
  const current = toolProcessRows().find((item) => item.id === id) || {};
  let draftSteps = normalizeProcessSteps(current.steps);
  if (!draftSteps.length) draftSteps = [emptyProcessStep()];
  const content = `<div class="form process-form">
    <div class="field full"><label>Nome do processo *</label><input id="tool-process-title" value="${esc(current.title || "")}" placeholder="Ex.: Criar pedido de venda no Bling"></div>
    <div class="field"><label>Categoria</label><input id="tool-process-category" value="${esc(current.category || "")}" placeholder="Ex.: ERP"></div>
    <div class="field"><label>Canal</label><input id="tool-process-channel" value="${esc(current.system_name || "")}" placeholder="Ex.: Bling"></div>
    <div class="field"><label>Módulo</label><input id="tool-process-module" value="${esc(current.module_name || "")}" placeholder="Ex.: Vendas"></div>
    <div class="field"><label>Submódulo</label><input id="tool-process-submodule" value="${esc(current.submodule_name || "")}" placeholder="Ex.: Pedidos"></div>
    <div class="field full"><label>Tags</label><input id="tool-process-tags" value="${esc(normalizeTextList(current.tags).join(", "))}" placeholder="Bling, Nota fiscal, Financeiro"></div>
    <div class="field full"><div class="process-steps-head"><label>Etapas *</label><button class="btn" id="tool-process-step-add" type="button">+ Etapa</button></div><div id="tool-process-steps" class="process-steps-editor"></div></div>
  </div><div class="modal-foot"><button class="btn" id="tool-process-cancel">Cancelar</button><button class="btn primary" id="tool-process-save">Salvar</button></div>`;
  const closePanel = document.getElementById("tools-root")
    ? nestedSidePanel(id ? "Editar processo" : "Novo processo", content, { closeOnOverlay: true })
    : sidePanel(id ? "Editar processo" : "Novo processo", content, { closeOnOverlay: true, onClose: () => openToolsModal("processes") });
  const stepsRoot = document.getElementById("tool-process-steps");
  const drawSteps = () => {
    stepsRoot.innerHTML = processStepEditorHtml(draftSteps);
    stepsRoot.querySelectorAll(".process-step-input").forEach((input) => input.addEventListener(input.tagName === "SELECT" ? "change" : "input", () => {
      const index = Number(input.closest(".process-step-editor").dataset.index);
      draftSteps[index][input.dataset.field] = input.value;
      if (input.dataset.field === "element") drawSteps();
    }));
    stepsRoot.querySelectorAll(".process-outcome-input").forEach((input) => input.addEventListener(input.tagName === "SELECT" ? "change" : "input", () => {
      const step = draftSteps[Number(input.closest(".process-step-editor").dataset.index)];
      const outcome = step.outcomes[Number(input.closest(".process-outcome-row").dataset.outcome)];
      if (outcome) outcome[input.dataset.field] = input.value;
    }));
    stepsRoot.querySelectorAll(".process-outcome-add").forEach((button) => button.addEventListener("click", () => {
      const step = draftSteps[Number(button.closest(".process-step-editor").dataset.index)];
      step.outcomes = [...(step.outcomes || []), { id: crypto.randomUUID(), label: "", target: "" }];
      drawSteps();
    }));
    stepsRoot.querySelectorAll(".process-outcome-remove").forEach((button) => button.addEventListener("click", () => {
      const step = draftSteps[Number(button.closest(".process-step-editor").dataset.index)];
      step.outcomes.splice(Number(button.closest(".process-outcome-row").dataset.outcome), 1);
      drawSteps();
    }));
    stepsRoot.querySelectorAll(".process-step-remove").forEach((button) => button.addEventListener("click", () => { draftSteps.splice(Number(button.closest(".process-step-editor").dataset.index), 1); drawSteps(); }));
    stepsRoot.querySelectorAll(".process-step-up").forEach((button) => button.addEventListener("click", () => { const index = Number(button.closest(".process-step-editor").dataset.index); if (index > 0) { [draftSteps[index - 1], draftSteps[index]] = [draftSteps[index], draftSteps[index - 1]]; drawSteps(); } }));
    stepsRoot.querySelectorAll(".process-step-down").forEach((button) => button.addEventListener("click", () => { const index = Number(button.closest(".process-step-editor").dataset.index); if (index < draftSteps.length - 1) { [draftSteps[index + 1], draftSteps[index]] = [draftSteps[index], draftSteps[index + 1]]; drawSteps(); } }));
  };
  drawSteps();
  if (options.focusStep) {
    const focusIndex = draftSteps.findIndex((step) => step.id === options.focusStep);
    const focusEditor = stepsRoot.querySelector(`.process-step-editor[data-index="${focusIndex}"]`);
    if (focusEditor) requestAnimationFrame(() => { focusEditor.scrollIntoView({ block: "center" }); focusEditor.classList.add("is-focused"); });
  }
  document.getElementById("tool-process-step-add").addEventListener("click", () => { draftSteps.push(emptyProcessStep()); drawSteps(); stepsRoot.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  document.getElementById("tool-process-cancel").addEventListener("click", () => closeToolProcessPanel(closePanel));
  document.getElementById("tool-process-save").addEventListener("click", async () => {
    const title = document.getElementById("tool-process-title").value.trim();
    const fields = ["system", "module", "submodule", "group", "type", "url", "details", "label", "responsible", "next"];
    const steps = draftSteps.map((step) => ({
      id: step.id || crypto.randomUUID(),
      ...Object.fromEntries(fields.map((field) => [field, String(step[field] || "").trim()])),
      element: PROCESS_ELEMENTS[step.element] ? step.element : "task",
      outcomes: step.element === "decision" ? (step.outcomes || []).map((outcome) => ({ id: outcome.id || crypto.randomUUID(), label: String(outcome.label || "").trim(), target: String(outcome.target || "").trim() })).filter((outcome) => outcome.label || outcome.target) : []
    })).filter((step) => step.element !== "task" || fields.some((field) => step[field]));
    if (!title) { toast("Informe o nome do processo.", true); return; }
    if (!steps.length) { toast("Cadastre ao menos uma etapa.", true); return; }
    if (steps.some((step) => step.element === "task" && (!step.system || !step.module))) { toast("Informe Sistema e Módulo em todas as tarefas.", true); return; }
    if (steps.some((step) => step.element === "decision" && !step.label)) { toast("Informe a pergunta de cada decisão.", true); return; }
    if (steps.some((step) => step.url && !safeHttpUrl(step.url))) { toast("Revise as URLs das etapas. Use links começando com http:// ou https://.", true); return; }
    const button = document.getElementById("tool-process-save");
    button.disabled = true; button.textContent = "Salvando...";
    const body = {
      title,
      category: document.getElementById("tool-process-category").value.trim() || null,
      system_name: document.getElementById("tool-process-channel").value.trim() || null,
      module_name: document.getElementById("tool-process-module").value.trim() || null,
      submodule_name: document.getElementById("tool-process-submodule").value.trim() || null,
      tags: normalizeTextList(document.getElementById("tool-process-tags").value),
      steps,
      version: id ? Number(current.version || 1) + 1 : 1,
      updated_at: new Date().toISOString()
    };
    try {
      const saved = id ? await updateRow("processes", id, body) : await createRow("processes", body);
      if (isLive()) {
        const index = remoteToolProcesses.findIndex((item) => item.id === saved.id);
        if (index >= 0) remoteToolProcesses[index] = saved; else remoteToolProcesses.unshift(saved);
        remoteToolProcessesLoaded = true;
        remoteToolProcessesLoadedAt = Date.now();
        saveToolsSessionCache("processes", remoteToolProcesses, remoteToolProcessesLoadedAt);
      }
      toast("Processo salvo.");
      closeToolProcessPanel(closePanel);
      options.onSaved?.(saved);
    } catch (err) {
      button.disabled = false; button.textContent = "Salvar";
      toast("Erro ao salvar processo · " + err.message, true);
    }
  });
}

async function deleteToolProcess(id) {
  if (!requireCurrentUserPermission("processes", "delete", "Processos")) return;
  const process = toolProcessRows().find((item) => item.id === id);
  if (!process || !window.confirm(`Excluir o processo "${process.title}"?`)) return;
  try {
    await deleteRow("processes", id);
    if (isLive()) {
      remoteToolProcesses = remoteToolProcesses.filter((item) => item.id !== id);
      remoteToolProcessesLoadedAt = Date.now();
      saveToolsSessionCache("processes", remoteToolProcesses, remoteToolProcessesLoadedAt);
    }
    renderToolsSection();
    toast("Processo excluído.");
  } catch (err) { toast("Erro ao excluir processo · " + err.message, true); }
}

function toolEmailRows() {
  return APP_VARIANT === "web" && isLive() ? remoteToolEmails : readToolRows(TOOL_EMAILS_KEY);
}

async function loadRemoteToolEmails({ force = false } = {}) {
  if (APP_VARIANT !== "web" || !isLive() || remoteToolEmailsLoading) return;
  if (!force && !toolsCacheIsStale(remoteToolEmailsLoaded, remoteToolEmailsLoadedAt)) return;
  remoteToolEmailsLoading = true;
  remoteToolEmailsError = "";
  try {
    const result = await emailAccountsRequest();
    remoteToolEmails = Array.isArray(result.accounts) ? result.accounts : [];
    remoteToolEmailsLoaded = true;
    remoteToolEmailsLoadedAt = Date.now();
  } catch (err) {
    remoteToolEmailsError = err.message;
  } finally {
    remoteToolEmailsLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "emails") renderToolEmails(root);
  }
}

function renderToolEmails(root) {
  const usesServer = APP_VARIANT === "web" && isLive();
  if (usesServer && !remoteToolEmailsLoading && !remoteToolEmailsError && toolsCacheIsStale(remoteToolEmailsLoaded, remoteToolEmailsLoadedAt)) loadRemoteToolEmails();
  const allAccounts = toolEmailRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("emails");
  const accounts = allAccounts.filter((account) => {
    const matchesSearch = !query || [account.cnpj, account.client, account.email, ...(account.tags || [])]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolEmailValue(account, key))
    );
  });
  if (tableState.sortKey) {
    accounts.sort((a, b) => toolEmailValue(a, tableState.sortKey).localeCompare(
      toolEmailValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const page = paginateToolRows(accounts, "emails");
  const columns = visibleToolColumns("emails");
  const rows = page.rows.length ? page.rows.map((account) => `<tr>
    ${columns.map((col) => {
      if (col.k === "client") return `<td><strong>${esc(account.client || "—")}</strong></td>`;
      if (col.k === "password") return account.password
        ? `<td><span class="tool-secret"><span class="tool-secret-value" data-secret-id="${esc(account.id)}">••••••••</span><button class="tool-icon-btn tool-email-reveal" data-id="${esc(account.id)}" title="Mostrar senha">◉</button><button class="tool-icon-btn tool-email-copy" data-id="${esc(account.id)}" title="Copiar senha">⧉</button></span></td>`
        : '<td><span class="muted">Não disponível</span></td>';
      if (col.k === "tags") return `<td><span class="tool-tags">${(account.tags || []).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("") || '<span class="muted">—</span>'}</span></td>`;
      return `<td>${esc(account[col.k] || "—")}</td>`;
    }).join("")}
    <td class="table-actions-cell">${tableActionButtons({
      edit: { className: "tool-email-edit", attrs: { "data-id": account.id }, title: "Editar senha local e tags", enabled: currentUserCan("emails", "edit") },
      delete: !usesServer ? { className: "tool-email-delete", attrs: { "data-id": account.id }, title: "Excluir e-mail", enabled: currentUserCan("emails", "delete") } : null
    })}</td>
  </tr>`).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhum e-mail cadastrado.</td></tr>`;
  const filterStrip = toolFilterStrip("emails", tableState, { loading: usesServer && remoteToolEmailsLoading, error: usesServer ? remoteToolEmailsError : "" });
  root.innerHTML = `${toolsToolbarHtml(accounts.length, "Criar e-mail pelo CNPJ", "tool-email-add", currentUserCan("emails", "create"))}${filterStrip}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((col) => `<th data-tool-key="${esc(col.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(col.h)}${tableState.sortKey === col.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}${tableActionsHead()}</tr></thead><tbody>${rows}</tbody></table></div>${toolsPaginationHtml(accounts.length, "emails")}`;
  wireToolsToolbar(root);
  wireToolsPagination(root, "emails");
  wireToolsLoadRetry(root, "emails");
  wireSecondaryTableSelection(root.querySelector("table"), "tools:emails");
  document.getElementById("tool-email-add").addEventListener("click", () => openToolEmailForm());
  root.querySelectorAll(".tool-email-reveal").forEach((button) => button.addEventListener("click", () => toggleToolEmailSecret(button.dataset.id)));
  root.querySelectorAll(".tool-email-copy").forEach((button) => button.addEventListener("click", () => copyToolEmailSecret(button.dataset.id)));
  root.querySelectorAll(".tool-email-edit").forEach((button) => button.addEventListener("click", () => openToolEmailForm(button.dataset.id)));
  root.querySelectorAll(".tool-email-delete").forEach((button) => button.addEventListener("click", () => deleteToolEmail(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allAccounts, toolEmailValue, "emails"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete tableState.filters[badge.dataset.key];
    renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => {
    tableState.filters = {};
    renderToolsSection();
  });
}

function openToolColumnFilter(header, key, rows, valueFn, section = toolsState.section) {
  document.getElementById("tool-filter-dd")?.remove();
  const values = [...new Set(rows.map((row) => valueFn(row, key)))].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" })
  );
  const tableState = toolTableState(section);
  const rect = header.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "tool-filter-dd";
  panel.className = "filter-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.maxHeight = `${Math.max(220, window.innerHeight - rect.bottom - 20)}px`;
  document.body.appendChild(panel);
  mountColumnFilterPanel(panel, {
    title: `Filtrar · ${TOOL_COLUMN_DEFS[section].find((col) => col.k === key)?.h || key}`, values, key, current: tableState.filters[key],
    onApply: (rule) => {
      if (rule) tableState.filters[key] = rule; else delete tableState.filters[key];
      panel.remove(); renderToolsSection();
    }
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !header.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 50);
}

function openToolEmailForm(id = null) {
  if (!requireCurrentUserPermission("emails", id ? "edit" : "create", "Emails")) return;
  const usesServer = APP_VARIANT === "web" && isLive();
  const current = toolEmailRows().find((item) => item.id === id) || {};
  const editingServer = usesServer && Boolean(id);
  const editorHtml = editingServer ? `<div class="form">
    <div class="field full"><label>E-mail</label><input value="${esc(current.email || "")}" disabled></div>
    <div class="field full"><label>Senha registrada no CMS</label><input id="tool-email-password" type="password" value="" autocomplete="new-password" placeholder="Deixe em branco para manter a atual"></div>
    <div class="field full"><label>Tags</label><input id="tool-email-tags" value="${esc((current.tags || []).join(", "))}" placeholder="Excluir, Alterar senha"></div>
    <div class="field full"><div class="panel-list"><strong>Atenção</strong><span>Alterar a senha aqui atualiza apenas o registro do CMS. A senha da conta no painel da HostGator não será modificada.</span></div></div>
  </div><div class="modal-foot"><button class="btn" id="tool-email-cancel">Cancelar</button><button class="btn primary" id="tool-email-save">Salvar no CMS</button></div>` : `<div class="form">
    <div class="field full"><label>CNPJ</label><input id="tool-email-cnpj" value="${esc(current.cnpj || "")}"></div>
    <div class="field full"><label>Cliente</label><input id="tool-email-client" value="${esc(current.client || "")}"></div>
    ${usesServer ? '<div class="field full"><span class="muted">O endereço usará a raiz do CNPJ e a senha será gerada automaticamente.</span></div>' : `<div class="field full"><label>Email</label><input id="tool-email-address" type="email" value="${esc(current.email || "")}"></div><div class="field full"><label>Senha</label><input id="tool-email-password" type="password" value="${esc(current.password || "")}" autocomplete="new-password"></div>`}
  </div><div class="modal-foot"><button class="btn" id="tool-email-cancel">Cancelar</button><button class="btn primary" id="tool-email-save">${usesServer ? "Criar na HostGator" : "Salvar"}</button></div>`;
  const toolsModalOpen = Boolean(document.getElementById("tools-root"));
  const closeEditor = toolsModalOpen
    ? nestedSidePanel(id ? "Editar e-mail" : "Novo e-mail", editorHtml, { closeOnOverlay: true })
    : sidePanel(id ? "Editar e-mail" : "Novo e-mail", editorHtml, { closeOnOverlay: true, onClose: () => openToolsModal("emails") });
  const returnToEmails = () => {
    closeEditor();
    if (document.getElementById("tools-root")) renderToolsSection();
    else openToolsModal("emails");
  };
  document.getElementById("tool-email-cancel").addEventListener("click", returnToEmails);
  if (editingServer) {
    document.getElementById("tool-email-save").addEventListener("click", async () => {
      const button = document.getElementById("tool-email-save");
      button.disabled = true;
      button.textContent = "Salvando...";
      try {
        const password = document.getElementById("tool-email-password").value;
        const tags = document.getElementById("tool-email-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
        const result = await emailAccountsRequest("PATCH", { email: current.email, ...(password ? { password } : {}), tags });
        const index = remoteToolEmails.findIndex((account) => account.email === result.account.email);
        if (index >= 0) remoteToolEmails[index] = result.account;
        else remoteToolEmails.unshift(result.account);
        remoteToolEmailsLoaded = true;
        remoteToolEmailsLoadedAt = Date.now();
        toast("Dados salvos no CMS. A senha da HostGator não foi alterada.");
        returnToEmails();
      } catch (err) {
        button.disabled = false;
        button.textContent = "Salvar no CMS";
        toast("Erro ao atualizar e-mail · " + err.message, true);
      }
    });
    return;
  }
  const cnpjInput = document.getElementById("tool-email-cnpj");
  cnpjInput.addEventListener("blur", () => {
    const digits = cnpjInput.value.replace(/\D/g, "");
    const company = cache?.companies?.find((item) => String(item.tax_id || "").replace(/\D/g, "") === digits);
    if (company && !document.getElementById("tool-email-client").value.trim()) {
      document.getElementById("tool-email-client").value = company.trade_name || company.legal_name || "";
    }
  });
  document.getElementById("tool-email-save").addEventListener("click", async () => {
    const client = document.getElementById("tool-email-client").value.trim();
    const cnpj = document.getElementById("tool-email-cnpj").value.trim();
    if (usesServer) {
      const digits = cnpj.replace(/\D/g, "");
      const company = cache?.companies?.find((item) => String(item.tax_id || "").replace(/\D/g, "") === digits);
      if (!company) { toast("Informe o CNPJ de uma empresa cadastrada.", true); return; }
      const button = document.getElementById("tool-email-save");
      button.disabled = true;
      button.textContent = "Criando...";
      try {
        const result = await emailAccountsRequest("POST", { companyId: company.tax_id });
        const index = remoteToolEmails.findIndex((account) => account.id === result.account.id);
        if (index >= 0) remoteToolEmails[index] = result.account;
        else remoteToolEmails.unshift(result.account);
        remoteToolEmailsLoaded = true;
        remoteToolEmailsLoadedAt = Date.now();
        toast(result.status === "created"
          ? `E-mail ${result.account.email} criado.`
          : result.status === "existing_unmanaged"
            ? `E-mail ${result.account.email} já existe. A senha anterior não pode ser recuperada.`
            : `E-mail ${result.account.email} já estava criado.`);
        returnToEmails();
      } catch (err) {
        button.disabled = false;
        button.textContent = "Criar na HostGator";
        toast("Erro ao criar e-mail · " + err.message, true);
      }
      return;
    }
    const email = document.getElementById("tool-email-address").value.trim();
    const password = document.getElementById("tool-email-password").value;
    if (!client || !email || !password) { toast("Preencha cliente, email e senha.", true); return; }
    const rows = readToolRows(TOOL_EMAILS_KEY);
    const item = {
      id: current.id || crypto.randomUUID(),
      cnpj: document.getElementById("tool-email-cnpj").value.trim(),
      client,
      email,
      password,
      updated_at: new Date().toISOString()
    };
    const index = rows.findIndex((row) => row.id === item.id);
    if (index >= 0) rows[index] = item;
    else rows.unshift(item);
    saveToolRows(TOOL_EMAILS_KEY, rows);
    toast("E-mail salvo.");
    returnToEmails();
  });
}

function toggleToolEmailSecret(id) {
  const account = toolEmailRows().find((item) => item.id === id);
  const value = document.querySelector(`[data-secret-id="${CSS.escape(id)}"]`);
  if (!account?.password || !value) return;
  const revealed = value.dataset.revealed === "true";
  value.textContent = revealed ? "••••••••" : account.password;
  value.dataset.revealed = String(!revealed);
}

async function copyToolEmailSecret(id) {
  const account = toolEmailRows().find((item) => item.id === id);
  if (!account?.password) { toast("A senha dessa conta não está registrada no CMS.", true); return; }
  try {
    await navigator.clipboard.writeText(account.password);
    toast("Senha copiada.");
  } catch (e) {
    toast("Não foi possível copiar a senha.", true);
  }
}

function deleteToolEmail(id) {
  if (!requireCurrentUserPermission("emails", "delete", "Emails")) return;
  const rows = readToolRows(TOOL_EMAILS_KEY);
  const account = rows.find((item) => item.id === id);
  if (!account || !window.confirm(`Excluir o e-mail "${account.email}"?`)) return;
  saveToolRows(TOOL_EMAILS_KEY, rows.filter((item) => item.id !== id));
  renderToolsSection();
  toast("E-mail excluído.");
}

function openUpdatesModal() {
  sidePanel("Atualizações", `<div class="panel-list">
    <div><strong>Versão web 0.1.0</strong></div>
    <div class="muted">Dependências entre metas, objetivos e tarefas; ajustes de modais; integração por usuário; e navegação de Cadastros revisada.</div>
  </div>`, { closeOnOverlay: true });
}

let adminLogState = { tab: "session", onlyErrors: false, search: "", errors: [], loading: false };
function adminLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function adminLogStatus(status, failed) {
  return `<span class="log-status ${failed ? "err" : "ok"}">${status ? esc(status) : "REDE"}</span>`;
}
function renderAdminLog() {
  const body = document.getElementById("admin-log-body");
  if (!body) return;
  const query = adminLogState.search.trim().toLocaleLowerCase("pt-BR");
  const matches = (text) => !query || text.toLocaleLowerCase("pt-BR").includes(query);
  document.querySelectorAll(".admin-log-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === adminLogState.tab));
  const onlyErrors = document.getElementById("admin-log-only-errors");
  if (onlyErrors) onlyErrors.closest("label").hidden = adminLogState.tab !== "session";
  if (adminLogState.tab === "session") {
    const rows = API_REQUEST_LOG.filter((item) => (!adminLogState.onlyErrors || item.error)
      && matches(`${item.method} ${item.resource} ${item.query} ${item.status} ${item.error}`));
    const errorCount = API_REQUEST_LOG.filter((item) => item.error).length;
    document.getElementById("admin-log-count").textContent = `${rows.length} chamada(s) · ${errorCount} erro(s) nesta sessão`;
    body.innerHTML = `<table><thead><tr><th>Data/hora</th><th>Método</th><th>Recurso</th><th>Status</th><th>Tempo</th><th>Detalhe</th></tr></thead><tbody>${rows.map((item) => `<tr class="${item.error ? "log-row-error" : ""}">
      <td>${esc(adminLogTime(item.at))}</td><td><strong>${esc(item.method)}</strong></td><td>${esc(item.resource)}</td>
      <td>${adminLogStatus(item.status, Boolean(item.error))}</td><td>${esc(item.ms)} ms</td>
      <td class="log-detail">${esc(item.error || item.query || "—")}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">Nenhuma chamada registrada.</td></tr>'}</tbody></table>`;
    return;
  }
  if (adminLogState.loading) { body.innerHTML = '<div class="empty">Carregando erros...</div>'; return; }
  const rows = adminLogState.errors.filter((item) => matches(`${userDisplayName(item.profile_id)} ${item.method} ${item.path} ${item.status} ${item.message}`));
  document.getElementById("admin-log-count").textContent = `${rows.length} erro(s) registrados`;
  body.innerHTML = `<table><thead><tr><th>Data/hora</th><th>Usuário</th><th>Método</th><th>Recurso</th><th>Status</th><th>Mensagem</th></tr></thead><tbody>${rows.map((item) => `<tr class="log-row-error">
    <td>${esc(adminLogTime(item.created_at))}</td><td>${esc(item.profile_id ? userDisplayName(item.profile_id) : "—")}</td><td><strong>${esc(item.method || "—")}</strong></td>
    <td class="log-detail">${esc(item.path || "—")}</td><td>${adminLogStatus(item.status, true)}</td><td class="log-detail">${esc(item.message || "—")}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">Nenhum erro registrado.</td></tr>'}</tbody></table>`;
}
async function loadAdminLogErrors() {
  adminLogState.loading = true;
  renderAdminLog();
  try {
    adminLogState.errors = isLive() ? (await api("app_request_errors?select=*&order=created_at.desc&limit=500")) || [] : [];
  } catch (error) {
    adminLogState.errors = [];
    toast(`Não foi possível carregar os erros · ${error.message}`, true);
  }
  adminLogState.loading = false;
  renderAdminLog();
}
function openAdminLog() {
  if (!currentUserIsAdmin()) { toast("LOG disponível apenas para administradores.", true); return; }
  adminLogState = { tab: "session", onlyErrors: false, search: "", errors: [], loading: false };
  shell("Log · Chamadas ao banco", `<div class="modal-toolbar registration-toolbar admin-log-toolbar">
      <div class="registration-toolbar-left"><button class="view admin-log-tab active" type="button" data-tab="session">Esta sessão</button><button class="view admin-log-tab" type="button" data-tab="errors">Erros de todos</button><span class="muted" id="admin-log-count"></span></div>
      <div class="registration-toolbar-center"><input class="search registration-toolbar-search" id="admin-log-search" placeholder="Buscar por recurso, status ou erro..."></div>
      <div class="registration-toolbar-right"><label class="admin-log-check"><input type="checkbox" id="admin-log-only-errors"> Só erros</label><button class="btn" id="admin-log-refresh" type="button" title="Atualizar">↻</button></div>
    </div><div class="full-body admin-log-body table-wrap" id="admin-log-body"></div>`, { cls: "full" });
  document.querySelectorAll(".admin-log-tab").forEach((button) => button.addEventListener("click", () => {
    adminLogState.tab = button.dataset.tab;
    if (adminLogState.tab === "errors") loadAdminLogErrors();
    else renderAdminLog();
  }));
  document.getElementById("admin-log-search").addEventListener("input", (event) => { adminLogState.search = event.target.value; renderAdminLog(); });
  document.getElementById("admin-log-only-errors").addEventListener("change", (event) => { adminLogState.onlyErrors = event.target.checked; renderAdminLog(); });
  document.getElementById("admin-log-refresh").addEventListener("click", () => adminLogState.tab === "errors" ? loadAdminLogErrors() : renderAdminLog());
  renderAdminLog();
}

// ---------- Atividades dos usuários ----------
let userActivitiesState = { rows: [], userId: "", search: "", loading: false };
function userActivityText(row) {
  const entity = row.entity_type ? ` ${String(row.entity_type).toLocaleLowerCase("pt-BR")}` : "";
  return `${row.action || "—"}${entity}${row.entity_label ? ` · ${row.entity_label}` : ""}`;
}
function renderUserActivities() {
  const body = document.getElementById("user-activities-body");
  if (!body) return;
  if (userActivitiesState.loading) { body.innerHTML = '<div class="empty">Carregando atividades...</div>'; return; }
  const query = userActivitiesState.search.trim().toLocaleLowerCase("pt-BR");
  const rows = userActivitiesState.rows.filter((row) => !query
    || `${userDisplayName(row.profile_id)} ${userActivityText(row)}`.toLocaleLowerCase("pt-BR").includes(query));
  document.getElementById("user-activities-count").textContent = `${rows.length} atividade(s)`;
  body.innerHTML = `<table><thead><tr><th>Nome</th><th>Atividade</th><th>Data/hora</th></tr></thead><tbody>${rows.map((row) => `<tr>
    <td><strong>${esc(userDisplayName(row.profile_id))}</strong></td><td>${esc(userActivityText(row))}</td><td>${esc(adminLogTime(row.created_at))}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">Nenhuma atividade registrada.</td></tr>'}</tbody></table>`;
}
async function loadUserActivities() {
  userActivitiesState.loading = true;
  renderUserActivities();
  const filters = [];
  const profileId = currentUserIsAdmin() ? userActivitiesState.userId : currentProfile?.id;
  if (profileId) filters.push(`profile_id=eq.${encodeURIComponent(profileId)}`);
  try {
    userActivitiesState.rows = isLive()
      ? (await api(`user_activities?select=*&order=created_at.desc&limit=1000${filters.length ? `&${filters.join("&")}` : ""}`)) || []
      : [];
  } catch (error) {
    userActivitiesState.rows = [];
    toast(`Não foi possível carregar as atividades · ${error.message}`, true);
  }
  userActivitiesState.loading = false;
  renderUserActivities();
}
function openUserActivities() {
  const admin = currentUserIsAdmin();
  userActivitiesState = { rows: [], userId: "", search: "", loading: true };
  const users = [...(cache?.users || [])].sort((a, b) => userDisplayName(a.id).localeCompare(userDisplayName(b.id), "pt-BR", { sensitivity: "base" }));
  const userFilter = admin
    ? `<select id="user-activities-user" class="user-activities-user" aria-label="Filtrar por usuário"><option value="">Todos os usuários</option>${users.map((user) => `<option value="${esc(user.id)}">${esc(userDisplayName(user.id))}</option>`).join("")}</select>`
    : "";
  shell(admin ? "Atividades · Todos os usuários" : "Minhas atividades", `<div class="modal-toolbar registration-toolbar">
      <div class="registration-toolbar-left"><span class="muted" id="user-activities-count">Carregando...</span></div>
      <div class="registration-toolbar-center"><input class="search registration-toolbar-search" id="user-activities-search" placeholder="Buscar por nome ou atividade..."></div>
      <div class="registration-toolbar-right">${userFilter}<button class="btn" id="user-activities-refresh" type="button" title="Atualizar">↻</button></div>
    </div><div class="full-body table-wrap" id="user-activities-body"></div>`, { cls: "full" });
  document.getElementById("user-activities-search").addEventListener("input", (event) => { userActivitiesState.search = event.target.value; renderUserActivities(); });
  document.getElementById("user-activities-user")?.addEventListener("change", (event) => { userActivitiesState.userId = event.target.value; loadUserActivities(); });
  document.getElementById("user-activities-refresh").addEventListener("click", loadUserActivities);
  loadUserActivities();
}

function activeProfileId() {
  return currentProfile?.id || cache?.users?.[0]?.id || null;
}

function commentAuthorName(comment) {
  return userDisplayName(comment.author_id, cache, "Usuário");
}

function taskCommentsListHtml(task) {
  const legacy = String(task.notes || "").trim();
  const comments = taskComments(task.id);
  const items = [
    ...(legacy ? [{ id: "legacy", author_id: null, body: legacy, created_at: task.created_at, legacy: true }] : []),
    ...comments
  ];
  return items.length ? items.map((comment) => `<article class="task-comment-item">
    <div><strong>${esc(comment.legacy ? "Nota anterior" : commentAuthorName(comment))}</strong><time>${esc(comment.created_at ? new Date(comment.created_at).toLocaleString("pt-BR") : "")}</time></div>
    <p>${esc(comment.body)}</p>
  </article>`).join("") : '<div class="empty">Nenhum comentário nesta tarefa.</div>';
}

async function addTaskComment(activityId, body) {
  const authorId = activeProfileId();
  if (!authorId) throw new Error("Usuário ativo não encontrado.");
  const comment = { id: crypto.randomUUID(), activity_id: activityId, author_id: authorId, body, created_at: new Date().toISOString() };
  if (!isLive()) return comment;
  const result = await api("activity_comments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ activity_id: activityId, author_id: authorId, body })
  });
  return Array.isArray(result) ? result[0] : result;
}

function openTaskComments(activityId) {
  const task = (cache.activityRecords || []).find((item) => item.id === activityId);
  if (!task) return;
  const inner = `<div class="task-comments-panel">
    <div class="task-comments-list" id="task-comments-list">${taskCommentsListHtml(task)}</div>
    <form class="task-comment-form" id="task-comment-form">
      <textarea id="task-comment-body" maxlength="4000" placeholder="Escreva um comentário..." required></textarea>
      <button class="btn primary" type="submit">Enviar</button>
    </form>
  </div>`;
  liveState.commentsActivityId = activityId;
  const insideProject = Boolean(document.getElementById("project-board-root"));
  if (insideProject) nestedSidePanel(`Comentários · ${activityDisplayName(task)}`, inner);
  else sidePanel(`Comentários · ${activityDisplayName(task)}`, inner, { closeOnOverlay: true });
  const form = document.getElementById("task-comment-form");
  const input = document.getElementById("task-comment-body");
  input?.focus();
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const saved = await addTaskComment(activityId, body);
      cache.activityComments.push(saved);
      input.value = "";
      document.getElementById("task-comments-list").innerHTML = taskCommentsListHtml(task);
      document.getElementById("task-comments-list").scrollTop = document.getElementById("task-comments-list").scrollHeight;
      refreshActivityCache();
      if (insideProject) renderProjectBoard(projectBoardState.projectId);
      else render();
    } catch (error) {
      toast("Erro ao adicionar comentário · " + error.message, true);
    } finally {
      button.disabled = false;
      input.focus();
    }
  });
}

let internalChatTimer = null;
let internalChatRecipientId = null;
let internalChatMessages = [];
let internalChatQuery = "";

const INTERNAL_CHAT_STATUS = {
  available: { label: "Disponível", className: "available" },
  away: { label: "Ausente", className: "away" },
  off_hours: { label: "Fora do expediente", className: "off-hours" },
  inactive: { label: "Inativo", className: "inactive" },
};

function isInternalChatOffHours(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
  return hour >= 18 || hour < 8;
}

function internalChatEffectiveStatus(user, date = new Date()) {
  if (user?.status !== "active") return "inactive";
  if (isInternalChatOffHours(date)) return "off_hours";
  return INTERNAL_CHAT_STATUS[user?.chat_status] ? user.chat_status : "available";
}

function internalChatPresence(user) {
  return INTERNAL_CHAT_STATUS[internalChatEffectiveStatus(user)] || INTERNAL_CHAT_STATUS.available;
}

function internalChatStatusOptions(selected) {
  return [
    ["available", "Disponível"],
    ["away", "Ausente"],
    ["off_hours", "Fora do expediente"],
  ].map(([value, label]) => `<option value="${value}"${selected === value ? " selected" : ""}>${label}</option>`).join("");
}

async function saveInternalChatStatus(status) {
  if (!INTERNAL_CHAT_STATUS[status] || status === "inactive") return;
  const select = byId("internal-chat-status");
  if (select) select.disabled = true;
  try {
    const rows = await api("rpc/set_my_chat_status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_status: status }),
    });
    const updated = Array.isArray(rows) ? rows[0] : rows;
    if (updated) {
      currentProfile = { ...currentProfile, ...updated };
      const index = cache.users.findIndex((user) => user.id === updated.id);
      if (index >= 0) cache.users[index] = { ...cache.users[index], ...updated };
    }
    renderInternalChatList();
  } catch (error) {
    toast(`Erro ao atualizar status · ${error.message || error}`, true);
    if (select) select.disabled = false;
  }
}

async function refreshInternalChatPresence() {
  try {
    const profiles = await api("profiles?select=id,status,chat_status,chat_status_updated_at");
    const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
    cache.users = cache.users.map((user) => ({ ...user, ...(profileMap.get(user.id) || {}) }));
    const own = profileMap.get(currentProfile?.id);
    if (own) currentProfile = { ...currentProfile, ...own };
  } catch {
    // A lista continua utilizável com o último estado carregado.
  }
}

function renderInternalChatRecipientPresence() {
  if (!internalChatRecipientId) return;
  const user = (cache.users || []).find((item) => item.id === internalChatRecipientId);
  const badge = document.querySelector(".internal-chat-thread-head .user-presence");
  if (!user || !badge) return;
  const presence = internalChatPresence(user);
  badge.className = `user-presence ${presence.className}`;
  badge.textContent = presence.label;
}

function stopInternalChatPolling() {
  if (internalChatTimer) clearInterval(internalChatTimer);
  internalChatTimer = null;
}

function internalChatUsers() {
  return (cache.users || []).filter((user) => user.id !== activeProfileId()
    && ["admin", "collaborator"].includes(normalizedProfileRole(user.role))).sort((a, b) => {
    const statusOrder = Number(b.status === "active") - Number(a.status === "active");
    return statusOrder || userDisplayName(a.id, cache, "Usuário").localeCompare(userDisplayName(b.id, cache, "Usuário"), "pt-BR", { sensitivity: "base" });
  });
}

async function fetchAllDirectMessages() {
  if (!isLive()) return [...(cache.directMessages || [])];
  return api("direct_messages?select=*&order=created_at.desc&limit=1000");
}

function directConversationMessages(userId) {
  const me = activeProfileId();
  return internalChatMessages.filter((message) =>
    (message.sender_id === me && message.recipient_id === userId)
    || (message.sender_id === userId && message.recipient_id === me)
  ).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

function internalChatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function internalChatInitials(user) {
  return userDisplayName(user.id, cache, "U").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function internalChatConversationState(latest, unreadCount) {
  if (!latest) return "Nova conversa";
  if (latest.sender_id !== activeProfileId()) return unreadCount ? "Nova resposta" : "Respondida";
  return latest.read_at ? "Lida · aguardando resposta" : "Enviada · aguardando resposta";
}

function internalChatRowsHtml() {
  const query = internalChatQuery.trim().toLocaleLowerCase("pt-BR");
  const users = internalChatUsers().map((user) => {
    const messages = directConversationMessages(user.id);
    const latest = messages.at(-1) || null;
    const unreadCount = messages.filter((message) => message.sender_id === user.id && message.recipient_id === activeProfileId() && !message.read_at).length;
    return { user, latest, unreadCount, state: internalChatConversationState(latest, unreadCount) };
  }).filter(({ user, latest }) => !query || [userDisplayName(user.id, cache, "Usuário"), user.email, user.job_title, latest?.body]
    .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query)))
    .sort((a, b) => {
      if (a.latest && b.latest) return String(b.latest.created_at || "").localeCompare(String(a.latest.created_at || ""));
      if (a.latest) return -1;
      if (b.latest) return 1;
      const statusOrder = Number(b.user.status === "active") - Number(a.user.status === "active");
      return statusOrder || userDisplayName(a.user.id, cache, "Usuário").localeCompare(userDisplayName(b.user.id, cache, "Usuário"), "pt-BR", { sensitivity: "base" });
    });
  return users.length ? users.map(({ user, latest, unreadCount, state }) => {
    const mine = latest?.sender_id === activeProfileId();
    const presence = internalChatPresence(user);
    return `<button class="internal-chat-contact${unreadCount ? " unread" : ""}" type="button" data-chat-user="${esc(user.id)}">
      <span class="internal-chat-avatar">${esc(internalChatInitials(user))}</span>
      <span class="internal-chat-contact-main"><span class="internal-chat-contact-head"><strong>${esc(userDisplayName(user.id, cache, "Usuário"))}</strong><time>${esc(internalChatTime(latest?.created_at))}</time></span>
        <span class="internal-chat-preview">${latest ? `${mine ? "Você: " : ""}${esc(latest.body)}` : "Clique para iniciar uma conversa"}</span>
        <span class="internal-chat-contact-meta"><span class="user-presence ${presence.className}">${presence.label}</span><span class="conversation-state">${esc(state)}</span></span>
      </span>${unreadCount ? `<b class="internal-chat-unread">${unreadCount}</b>` : ""}
    </button>`;
  }).join("") : '<div class="empty">Nenhum usuário encontrado.</div>';
}

function wireInternalChatRows() {
  document.querySelectorAll("[data-chat-user]").forEach((button) => button.addEventListener("click", () => openInternalChatThread(button.dataset.chatUser)));
}

function renderInternalChatList() {
  internalChatRecipientId = null;
  const panel = document.getElementById("internal-chat-panel");
  if (!panel) return;
  const ownStatus = INTERNAL_CHAT_STATUS[currentProfile?.chat_status] ? currentProfile.chat_status : "available";
  const automaticStatus = isInternalChatOffHours();
  panel.innerHTML = `<div class="internal-chat-search"><input id="internal-chat-search" type="search" placeholder="Pesquisar pessoas ou mensagens..." value="${esc(internalChatQuery)}"></div>
    <label class="internal-chat-user"><span>Meu status</span><select id="internal-chat-status" aria-label="Meu status no chat">${internalChatStatusOptions(ownStatus)}</select><small>${automaticStatus ? "Fora do expediente automático até 08:00. Sua escolha será retomada depois." : "Fora do expediente automático das 18:00 às 08:00."}</small></label>
    <div class="internal-chat-contacts" id="internal-chat-contacts">${internalChatRowsHtml()}</div>`;
  document.getElementById("internal-chat-status").addEventListener("change", (event) => saveInternalChatStatus(event.target.value));
  document.getElementById("internal-chat-search").addEventListener("input", (event) => {
    internalChatQuery = event.target.value;
    document.getElementById("internal-chat-contacts").innerHTML = internalChatRowsHtml();
    wireInternalChatRows();
  });
  wireInternalChatRows();
}

function renderInternalChatMessages({ scroll = false } = {}) {
  const log = document.getElementById("internal-chat-log");
  if (!log || !internalChatRecipientId) return;
  const messages = directConversationMessages(internalChatRecipientId);
  log.innerHTML = messages.length ? messages.map((message) => `<div class="internal-chat-message ${message.sender_id === activeProfileId() ? "mine" : "theirs"}">
      <strong>${esc(userDisplayName(message.sender_id, cache, "Usuário"))}</strong>
      <p>${esc(message.body)}</p><span class="internal-chat-message-meta"><time>${esc(new Date(message.created_at).toLocaleString("pt-BR"))}</time>${message.sender_id === activeProfileId() ? `<span>${message.read_at ? "Lida" : "Enviada"}</span>` : ""}</span>
    </div>`).join("") : '<div class="empty">Comece a conversa.</div>';
  if (scroll) log.scrollTop = log.scrollHeight;
}

async function markDirectMessagesRead(senderId) {
  const recipientId = activeProfileId();
  if (!recipientId) return;
  const unread = internalChatMessages.filter((message) => message.sender_id === senderId && message.recipient_id === recipientId && !message.read_at);
  if (!unread.length) return;
  const readAt = new Date().toISOString();
  if (isLive()) {
    await api(`direct_messages?sender_id=eq.${encodeURIComponent(senderId)}&recipient_id=eq.${encodeURIComponent(recipientId)}&read_at=is.null`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read_at: readAt })
    });
  }
  unread.forEach((message) => { message.read_at = readAt; });
}

async function refreshInternalChat({ scroll = false } = {}) {
  if (!document.getElementById("internal-chat-panel")) return;
  try {
    await refreshInternalChatPresence();
    internalChatMessages = await fetchAllDirectMessages();
    if (internalChatRecipientId) {
      await markDirectMessagesRead(internalChatRecipientId);
      renderInternalChatMessages({ scroll });
      renderInternalChatRecipientPresence();
    } else {
      const contacts = document.getElementById("internal-chat-contacts");
      if (contacts) { contacts.innerHTML = internalChatRowsHtml(); wireInternalChatRows(); }
    }
  } catch (error) {
    const target = document.getElementById("internal-chat-log") || document.getElementById("internal-chat-contacts");
    if (target) target.innerHTML = `<div class="empty">Não foi possível carregar o chat.<br>${esc(error.message)}</div>`;
  }
}

async function sendDirectMessage(recipientId, body) {
  const senderId = activeProfileId();
  if (!senderId) throw new Error("Usuário ativo não encontrado.");
  const message = { id: crypto.randomUUID(), sender_id: senderId, recipient_id: recipientId, body, read_at: null, created_at: new Date().toISOString() };
  if (!isLive()) {
    cache.directMessages.push(message);
    return message;
  }
  const result = await api("direct_messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ sender_id: senderId, recipient_id: recipientId, body })
  });
  return Array.isArray(result) ? result[0] : result;
}

function openInternalChatThread(recipientId) {
  const user = (cache.users || []).find((item) => item.id === recipientId);
  if (!user) return;
  internalChatRecipientId = recipientId;
  const isActive = user.status === "active";
  const presence = internalChatPresence(user);
  const panel = document.getElementById("internal-chat-panel");
  panel.innerHTML = `<div class="internal-chat-thread-head"><button class="btn internal-chat-back" id="internal-chat-back" type="button" title="Voltar">‹</button><span class="internal-chat-avatar">${esc(internalChatInitials(user))}</span><span><strong>${esc(userDisplayName(user.id, cache, "Usuário"))}</strong><small class="user-presence ${presence.className}">${presence.label}</small></span></div>
    <div class="internal-chat-log" id="internal-chat-log"></div>
    ${isActive ? '<form class="internal-chat-form" id="internal-chat-form"><textarea id="internal-chat-body" maxlength="4000" placeholder="Digite uma mensagem..." required></textarea><button class="btn primary" type="submit">Enviar</button></form>' : '<div class="internal-chat-disabled">Este usuário está inativo. O histórico permanece disponível para consulta.</div>'}`;
  document.getElementById("internal-chat-back").addEventListener("click", () => { renderInternalChatList(); refreshInternalChat(); });
  document.getElementById("internal-chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("internal-chat-body");
    const body = input.value.trim();
    if (!body) return;
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const saved = await sendDirectMessage(recipientId, body);
      if (isLive()) internalChatMessages.push(saved);
      input.value = "";
      await refreshInternalChat({ scroll: true });
    } catch (error) {
      toast("Erro ao enviar mensagem · " + error.message, true);
    } finally {
      button.disabled = false;
      input.focus();
    }
  });
  renderInternalChatMessages({ scroll: true });
  refreshInternalChat({ scroll: true });
}

function openInternalChat() {
  if (!currentUserCanUseChat()) {
    toast("O chat interno está disponível apenas para colaboradores e administradores.", true);
    return;
  }
  stopInternalChatPolling();
  internalChatRecipientId = null;
  internalChatQuery = "";
  internalChatMessages = [];
  const closeChat = () => {
    stopInternalChatPolling();
    modalCloseOverride = null;
    closeModal();
  };
  sidePanel("Chat", '<div class="internal-chat-panel" id="internal-chat-panel"></div>', { onClose: closeChat });
  renderInternalChatList();
  refreshInternalChat();
  internalChatTimer = setInterval(() => refreshInternalChat(), 5000);
}

function handleAction(action) {
  if (action === "theme") { setTheme(!document.body.classList.contains("light")); return; }
  if (action === "settings") { openSettings(); return; }
  if (action === "help") { openHelpModal(); return; }
  if (action === "log") { openAdminLog(); return; }
  if (action === "tools" || action === "files") { openToolsModal(); return; }
  if (action === "social") { openSocialModal(); return; }
  if (action === "updates") { openUpdatesModal(); return; }
  if (action === "pipeline") { openPipelinesModal(); return; }
  if (action === "registrations") { openRegistrationsModal(); return; }
  if (action === "users") { openUsersModal(); return; }
  if (action === "notifications") {
    sidePanel("Notificações", `<div class="panel-list">Nenhuma notificação por enquanto.</div>`, { closeOnOverlay: true });
    return;
  }
  if (action === "chat") { openInternalChat(); return; }
  if (action === "activities") { openUserActivities(); return; }
  if (action === "integrations") {
    sidePanel("Integrações", integrationsHtml(), { closeOnOverlay: true });
    wireIntegrations();
    return;
  }
  if (action === "logout") {
    if (window.confirm("Deseja sair do ENTERPRISER CMS?")) signOut();
    return;
  }
}

// ---------- Tempo real ----------
// Modelo misto: comentários chegam direto no painel aberto; as demais
// mudanças feitas por outros usuários acumulam no botão Atualizar (ao lado do
// sino e no cabeçalho dos módulos em tela cheia), para a tela não mudar
// enquanto a pessoa trabalha. Usa o Supabase Realtime (RLS continua valendo).

function noteOwnWrite(resource, query, method) {
  if (["GET", "HEAD"].includes(method)) return;
  const now = Date.now();
  liveState.ownWrites.set(`${resource}:*`, now);
  for (const match of String(query || "").matchAll(/(?:^|&)(?:id|tax_id)=(?:eq\.|in\.\()([^&)]+)/g)) {
    decodeURIComponent(match[1]).split(",").forEach((id) => liveState.ownWrites.set(`${resource}:${id.replace(/"/g, "")}`, now));
  }
  if (liveState.ownWrites.size > 2000) {
    for (const [key, at] of liveState.ownWrites) if (now - at > 60000) liveState.ownWrites.delete(key);
  }
}

const liveRefreshButtonHtml = () => '<button class="ico live-refresh" data-live-refresh type="button" title="Atualizar dados"><svg viewBox="0 0 20 20"><path d="M16 10a6 6 0 1 1-1.76-4.24"/><path d="M16.2 3.8v3.4h-3.4"/></svg><span class="live-refresh-badge" hidden></span></button>';

function updateLiveRefreshButtons() {
  const count = liveState.pending;
  document.querySelectorAll(".live-refresh").forEach((button) => {
    button.classList.toggle("has-changes", count > 0);
    button.title = count ? `${count} alteração(ões) feita(s) por outros usuários · clique para atualizar` : "Atualizar dados";
    const badge = button.querySelector(".live-refresh-badge");
    if (badge) { badge.hidden = !count; badge.textContent = count > 99 ? "99+" : String(count); }
  });
}

function handleLiveChange(data) {
  if (!cache || !LIVE_TABLES.includes(data?.table)) return;
  const record = data.type === "DELETE" ? data.old_record : data.record;
  const key = record?.id ?? record?.tax_id;
  const now = Date.now();
  const ownAt = liveState.ownWrites.get(`${data.table}:${key}`);
  if (ownAt && now - ownAt < 15000) return;
  if (data.type === "INSERT" && now - (liveState.ownWrites.get(`${data.table}:*`) || 0) < 3000) return;
  if (data.table === "activity_comments" && data.type === "INSERT" && record?.id) {
    if (record.author_id && record.author_id === currentProfile?.id) return;
    if (!cache.activityComments.some((comment) => comment.id === record.id)) cache.activityComments.push(record);
    const list = document.getElementById("task-comments-list");
    const task = (cache.activityRecords || []).find((item) => item.id === record.activity_id);
    if (list && task && liveState.commentsActivityId === record.activity_id) {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      list.innerHTML = taskCommentsListHtml(task);
      if (atBottom) list.scrollTop = list.scrollHeight;
    }
  }
  liveState.pending += 1;
  updateLiveRefreshButtons();
}

function liveSend(event, payload, topic = LIVE_TOPIC) {
  const socket = liveState.socket;
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ topic, event, payload, ref: String(++liveState.ref), join_ref: topic === LIVE_TOPIC ? "1" : null }));
}

function clearLiveTimers() {
  clearInterval(liveState.heartbeat);
  clearInterval(liveState.tokenTimer);
  liveState.heartbeat = null;
  liveState.tokenTimer = null;
}

async function startLiveUpdates() {
  if (!isLive() || liveState.socket || typeof WebSocket === "undefined") return;
  liveState.stopped = false;
  const c = getCfg();
  const token = await getAccessToken();
  if (!token || !c.url || !c.anonKey) return;
  let socket;
  try {
    socket = new WebSocket(`${c.url.replace(/^http/i, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(c.anonKey)}&vsn=1.0.0`);
  } catch (error) {
    scheduleLiveReconnect();
    return;
  }
  liveState.socket = socket;
  socket.onopen = () => {
    if (liveState.connectedOnce && liveState.retry > 0) { liveState.pending += 1; updateLiveRefreshButtons(); }
    liveState.retry = 0;
    liveState.connectedOnce = true;
    liveSend("phx_join", {
      config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: LIVE_TABLES.map((table) => ({ event: "*", schema: "public", table })) },
      access_token: token
    });
    liveState.heartbeat = setInterval(() => liveSend("heartbeat", {}, "phoenix"), 25000);
    liveState.tokenTimer = setInterval(async () => {
      const fresh = await getAccessToken();
      if (fresh) liveSend("access_token", { access_token: fresh });
    }, 5 * 60000);
  };
  socket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (error) { return; }
    if (message.event === "postgres_changes" && message.payload?.data) handleLiveChange(message.payload.data);
    else if (message.event === "phx_reply" && message.payload?.status === "error") console.warn("[CMS] Tempo real recusado", message.payload.response);
  };
  socket.onclose = () => {
    clearLiveTimers();
    if (liveState.socket === socket) liveState.socket = null;
    if (!liveState.stopped) scheduleLiveReconnect();
  };
  socket.onerror = () => { try { socket.close(); } catch (error) {} };
}

function scheduleLiveReconnect() {
  clearTimeout(liveState.reconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** liveState.retry);
  liveState.retry += 1;
  liveState.reconnectTimer = setTimeout(() => { if (!liveState.stopped) startLiveUpdates(); }, delay);
}

function stopLiveUpdates() {
  liveState.stopped = true;
  clearTimeout(liveState.reconnectTimer);
  clearLiveTimers();
  const socket = liveState.socket;
  liveState.socket = null;
  try { socket?.close(); } catch (error) {}
  liveState.pending = 0;
  updateLiveRefreshButtons();
}

async function refreshLiveData() {
  const buttons = [...document.querySelectorAll(".live-refresh")];
  if (buttons.some((button) => button.classList.contains("loading"))) return;
  buttons.forEach((button) => button.classList.add("loading"));
  try {
    await loadAll();
    refreshActivityCache();
    liveState.pending = 0;
    render();
    if (document.getElementById("project-board-root") && projectBoardState.projectId) {
      if (cache.projectById?.[projectBoardState.projectId]) renderProjectBoard(projectBoardState.projectId);
      else { closeModal(); toast("Esta entrega foi removida por outro usuário.", true); }
    }
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    const list = document.getElementById("task-comments-list");
    const task = (cache.activityRecords || []).find((item) => item.id === liveState.commentsActivityId);
    if (list && task) list.innerHTML = taskCommentsListHtml(task);
    toast("Dados atualizados.");
  } catch (error) {
    toast("Erro ao atualizar · " + error.message, true);
  } finally {
    document.querySelectorAll(".live-refresh").forEach((button) => button.classList.remove("loading"));
    updateLiveRefreshButtons();
  }
}

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-live-refresh]")) refreshLiveData();
});

// ---------- Eventos globais ----------
document.getElementById("login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("login-submit");
  const error = document.getElementById("login-error");
  button.disabled = true; button.textContent = "Entrando..."; error.textContent = "";
  try {
    const email = document.getElementById("login-email").value.trim().toLowerCase();
    const password = document.getElementById("login-password").value;
    storeAuthSession(await authRequest("token?grant_type=password", { email, password }));
    await init();
    logUserActivity("Entrou no sistema");
  } catch (err) {
    storeAuthSession(null);
    error.textContent = err.message === "Invalid login credentials" ? "E-mail ou senha inválidos." : err.message;
  } finally {
    button.disabled = false; button.textContent = "Entrar";
  }
});
document.getElementById("brand-home")?.addEventListener("click", () => {
  closeFloaters();
  state.tab = "home"; state.sortK = null; state.sortDir = 1; state.q = ""; state.view = "table";
  state.selectedConversations.clear();
  document.getElementById("search").value = "";
  render();
});
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (!requireCurrentUserPermission(t.dataset.tab, "view", ENTITY_LABEL[t.dataset.tab])) return;
    closeFloaters();
    state.tab = t.dataset.tab; state.sortK = null; state.sortDir = 1; state.q = "";
    state.view = "table";
    if (state.tab !== "conversations") state.selectedConversations.clear();
    document.getElementById("search").value = ""; render();
  }));
document.querySelectorAll(".view").forEach((v) =>
  v.addEventListener("click", () => {
    if (v.disabled) return;
    closeFloaters();
    state.view = v.dataset.view; render();
  }));
document.getElementById("search").addEventListener("input", (e) => {
  state.q = e.target.value.trim();
  if (state.pages[state.tab]) state.pages[state.tab] = 1;
  closeFloaters();
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const floater = document.getElementById("filter-dd") || document.getElementById("cols-dd") || document.getElementById("csv-dd") || document.getElementById("data-dd") || document.getElementById("view-dd");
  if (floater) closeFloaters();
});
document.getElementById("new").addEventListener("click", () => {
  if (!requireCurrentUserPermission(state.tab, "create", ENTITY_LABEL[state.tab])) return;
  if (state.tab === "conversations") document.getElementById("import-file").click();
  else if (state.tab === "activities") openTaskDeliveryPicker();
  else openForm(state.tab, null);
});
document.getElementById("cols-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("filter-dd")?.remove();
  document.getElementById("csv-dd")?.remove();
  openColumnManager();
});
document.getElementById("group-client-btn").addEventListener("click", () => {
  if (state.tab !== "activities" || state.view !== "table") return;
  state.groupActivitiesByClient = !state.groupActivitiesByClient;
  state.pages.activities = 1;
  render();
});
document.getElementById("view-menu-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  if (document.getElementById("view-dd")) closeFloaters();
  else openViewMenu();
});
document.getElementById("data-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("filter-dd")?.remove();
  document.getElementById("cols-dd")?.remove();
  openDataMenu();
});
document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await importWhatsAppFile(file);
});
document.getElementById("associate-contact").addEventListener("click", () => openAssociateContactModal());
document.getElementById("create-deal-from-selection").addEventListener("click", () => createDealFromSelectedConversations());
document.querySelectorAll(".ico, .foot-btn").forEach((b) =>
  b.addEventListener("click", () => handleAction(b.dataset.action)));

// ---------- Bootstrap ----------
function setConn() {
  const el = document.getElementById("conn");
  if (!el) return;
  const live = isLive();
  el.classList.toggle("live", live);
  document.getElementById("conn-label").textContent = live ? "Conectado ao Supabase" : "Dados de exemplo";
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.erc_reddit_events_queue || changes.erc_reddit_profiles || changes.erc_reddit_room_urls) syncRedditQueue();
    if (changes.erc_whatsapp_events_queue || changes.erc_whatsapp_contacts) syncWhatsAppQueue();
  });
}

async function init() {
  setConn();
  try {
    await loadAll();
    if (isLive()) {
      const session = readAuthSession();
      currentProfile = cache.users.find((user) => user.auth_user_id === session?.user?.id)
        || cache.users.find((user) => String(user.email || "").toLowerCase() === String(session?.user?.email || "").toLowerCase());
      if (!currentProfile || currentProfile.status !== "active") {
        storeAuthSession(null);
        showLogin("Este usuário não possui um perfil ativo no CMS.");
        return;
      }
      if (currentUserIsAdmin()) {
        await migrateLocalOperationalData();
        await syncProductObjectives();
        await syncProductGoals();
        await syncProductActivities();
        refreshActivityCache();
      }
    }
    syncRedditQueue();
    syncWhatsAppQueue();
    hideLogin();
    render();
    document.getElementById("boot-gate")?.setAttribute("hidden", "");
    startLiveUpdates();
    if (isLive()) setTimeout(runCompanyRegistryQueue, 3000);
  } catch (err) {
    document.getElementById("main").innerHTML =
      `<div class="empty">Falha ao carregar do Supabase.<br><span class="muted">${esc(err.message)}</span><br><br>` +
      `Confira URL / anon key em Configurações e as políticas de RLS.</div>`;
    const conn = document.getElementById("conn");
    if (conn) {
      conn.classList.remove("live");
      document.getElementById("conn-label").textContent = "Erro de conexão";
    }
    hideLogin();
    document.getElementById("boot-gate")?.setAttribute("hidden", "");
  }
}

async function startApp() {
  await ensurePrivacyConsent();
  if (!isLive()) { hideLogin(); await init(); return; }
  const token = await getAccessToken();
  if (!token) { showLogin(); return; }
  await init();
}

setTheme(localStorage.getItem("crm_theme") === "light");
startApp();

// Toque longo no cabeçalho da coluna equivale ao Ctrl+clique (abre o filtro) em tablets e celulares.
(function wireHeaderLongPress() {
  let timer = null;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener("pointerdown", (event) => {
    fired = false;
    if (event.pointerType === "mouse") return;
    const header = event.target.closest("thead th");
    if (!header || header.classList.contains("noclick") || event.target.closest("button, input, select, textarea")) return;
    start = { x: event.clientX, y: event.clientY, header };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      navigator.vibrate?.(12);
      header.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true, clientX: start.x, clientY: start.y }));
    }, 550);
  }, true);
  document.addEventListener("pointermove", (event) => {
    if (timer && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
  }, true);
  document.addEventListener("pointerup", cancel, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("touchend", (event) => {
    if (!fired) return;
    event.preventDefault();
    fired = false;
  }, { capture: true, passive: false });
  document.addEventListener("click", (event) => {
    if (!fired || !event.isTrusted || !start?.header.contains(event.target)) return;
    fired = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest?.("thead th")) event.preventDefault();
  }, true);
})();
