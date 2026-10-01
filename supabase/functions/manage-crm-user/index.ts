import { createClient, type User } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const permissionModules = [
  "contacts", "companies", "conversations", "deals", "projects", "activities",
  "products", "pipelines", "users", "activityTemplates", "goalTemplates", "objectiveTemplates",
  "files", "emails", "processes", "documents", "tables",
  "facebook", "instagram", "linkedin", "reddit", "tiktokshop", "youtube",
] as const;
const permissionActions = ["view", "create", "edit", "clone", "delete", "operate"] as const;

function sanitizePermissions(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(permissionModules.map((moduleId) => {
    const moduleValue = source[moduleId] && typeof source[moduleId] === "object" && !Array.isArray(source[moduleId])
      ? source[moduleId] as Record<string, unknown>
      : {};
    return [moduleId, Object.fromEntries(permissionActions.map((action) => [action, moduleValue[action] === true]))];
  }));
}

function clientPermissions() {
  const permissions = sanitizePermissions({});
  for (const moduleId of ["contacts", "companies", "projects", "activities", "files"]) {
    permissions[moduleId].view = true;
  }
  return permissions;
}

function randomIndex(max: number) {
  const limit = 256 - (256 % max);
  let value = 256;
  while (value >= limit) value = crypto.getRandomValues(new Uint8Array(1))[0];
  return value % max;
}

function securePassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*_-" ];
  const chars = groups.map((group) => group[randomIndex(group.length)]);
  const alphabet = groups.join("");
  while (chars.length < 20) chars.push(alphabet[randomIndex(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "bootstrap") {
      const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (listError) throw listError;
      if ((listed?.users || []).length) return json({ error: "O administrador inicial já foi criado." }, 409);

      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const profileId = String(body.profile_id || "");
      if (!email || password.length < 10 || !profileId) return json({ error: "Dados de inicialização inválidos." }, 400);

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: body.full_name || "Administrador" },
      });
      if (createError || !created.user) throw createError || new Error("Usuário não criado.");

      const { data: profile, error: profileError } = await admin.from("profiles").update({
        auth_user_id: created.user.id,
        email,
        role: "admin",
        status: "active",
        updated_at: new Date().toISOString(),
      }).eq("id", profileId).select("*").single();
      if (profileError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw profileError;
      }
      return json({ profile });
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sessão obrigatória." }, 401);
    const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Sessão inválida." }, 401);

    let { data: actor } = await admin.from("profiles").select("*").eq("auth_user_id", authData.user.id).maybeSingle();
    if (!actor && authData.user.email) {
      const fallback = await admin.from("profiles").select("*").eq("email", authData.user.email).maybeSingle();
      actor = fallback.data;
      if (actor && !actor.auth_user_id) {
        await admin.from("profiles").update({ auth_user_id: authData.user.id }).eq("id", actor.id);
      }
    }
    if (!actor || actor.status !== "active") return json({ error: "Perfil ativo não encontrado." }, 403);

    if (action === "provision-delivery-client") {
      if (!["admin", "collaborator"].includes(actor.role)) return json({ error: "Apenas colaboradores e administradores podem criar o acesso do cliente." }, 403);
      const deliveryId = String(body.delivery_id || "").trim();
      if (!deliveryId) return json({ error: "Entrega não informada." }, 400);

      const deliveryResult = await admin.from("deliveries").select("id,company_id,client_name").eq("id", deliveryId).maybeSingle();
      if (deliveryResult.error) throw deliveryResult.error;
      const delivery = deliveryResult.data;
      if (!delivery?.company_id) return json({ error: "A entrega precisa estar vinculada a uma empresa." }, 400);

      const companyResult = await admin.from("companies").select("tax_id,legal_name,trade_name").eq("tax_id", delivery.company_id).maybeSingle();
      if (companyResult.error) throw companyResult.error;
      const company = companyResult.data;
      if (!company) return json({ error: "Empresa da entrega não encontrada." }, 404);
      const digits = String(company.tax_id || "").replace(/\D/g, "");
      if (digits.length !== 14) return json({ error: "O CNPJ da empresa está inválido para gerar o acesso." }, 400);

      const email = `${digits.slice(0, 8)}@ecommerce365.com.br`;
      const displayName = company.trade_name || company.legal_name || delivery.client_name || "Cliente";
      let authUser: User | null = null;
      for (let page = 1; !authUser; page += 1) {
        const listed = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (listed.error) throw listed.error;
        authUser = (listed.data.users || []).find((user) => String(user.email || "").toLowerCase() === email) || null;
        if ((listed.data.users || []).length < 200) break;
      }

      let createdAuth = false;
      let password = "";
      if (!authUser) {
        password = securePassword();
        const created = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: displayName, nickname: displayName },
        });
        if (created.error || !created.data.user) throw created.error || new Error(`Acesso não criado para ${email}.`);
        authUser = created.data.user;
        createdAuth = true;
      }

      const existingProfile = await admin.from("profiles").select("id,role,company_ids").eq("email", email).maybeSingle();
      if (existingProfile.error) throw existingProfile.error;
      if (existingProfile.data && existingProfile.data.role !== "client") {
        if (createdAuth) await admin.auth.admin.deleteUser(authUser.id);
        return json({ error: `O e-mail ${email} já pertence a outro perfil.` }, 409);
      }
      const companyIds = [...new Set([...(Array.isArray(existingProfile.data?.company_ids) ? existingProfile.data.company_ids : []), company.tax_id])];
      const profileBody = {
        full_name: displayName,
        nickname: displayName,
        email,
        role: "client",
        company_ids: companyIds,
        status: "active",
        function_name: "Cliente",
        job_title: null,
        auth_user_id: authUser.id,
        permissions: clientPermissions(),
        updated_at: new Date().toISOString(),
      };
      const saved = existingProfile.data
        ? await admin.from("profiles").update(profileBody).eq("id", existingProfile.data.id).select("*").single()
        : await admin.from("profiles").insert(profileBody).select("*").single();
      if (saved.error) {
        if (createdAuth) await admin.auth.admin.deleteUser(authUser.id);
        throw saved.error;
      }
      return json({
        profile: saved.data,
        created: createdAuth,
        email,
        company_ids: companyIds,
        credential: createdAuth ? { company: displayName, email, password } : null,
      });
    }

    if (actor.role !== "admin") return json({ error: "Apenas administradores podem gerenciar acessos." }, 403);

    if (action === "save-user") {
      const profileId = body.profile_id ? String(body.profile_id) : null;
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = ["admin", "developer", "collaborator", "client", "supplier"].includes(body.role) ? body.role : "collaborator";
      const status = body.status === "inactive" ? "inactive" : "active";
      if (!email) return json({ error: "Informe o e-mail." }, 400);
      if (password && password.length < 10) return json({ error: "A senha deve ter pelo menos 10 caracteres." }, 400);

      let existing = null;
      if (profileId) {
        const result = await admin.from("profiles").select("*").eq("id", profileId).maybeSingle();
        if (result.error) throw result.error;
        existing = result.data;
      }

      let authUserId = existing?.auth_user_id || null;
      if (authUserId) {
        const attrs: Record<string, unknown> = {
          email,
          email_confirm: true,
          user_metadata: { full_name: body.full_name || existing.full_name || "", nickname: body.nickname || existing.nickname || "" },
        };
        if (password) attrs.password = password;
        const { error } = await admin.auth.admin.updateUserById(authUserId, attrs);
        if (error) throw error;
      } else {
        if (!password) return json({ error: "Gere uma senha para ativar este acesso." }, 400);
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: body.full_name || "", nickname: body.nickname || "" },
        });
        if (error || !created.user) throw error || new Error("Acesso não criado.");
        authUserId = created.user.id;
      }

      const profileBody = {
        full_name: String(body.full_name || "").trim(),
        nickname: String(body.nickname || "").trim() || null,
        email,
        phone: String(body.phone || "").trim() || null,
        role,
        company_ids: Array.isArray(body.company_ids) ? [...new Set(body.company_ids.map((value: unknown) => String(value || "").trim()).filter(Boolean))] : [],
        status,
        function_name: String(body.function_name || "").trim() || null,
        job_title: String(body.job_title || "").trim() || null,
        auth_user_id: authUserId,
        permissions: role === "admin" ? {} : sanitizePermissions(body.permissions),
        updated_at: new Date().toISOString(),
      };
      const query = profileId
        ? admin.from("profiles").update(profileBody).eq("id", profileId)
        : admin.from("profiles").insert(profileBody);
      const { data: profile, error: profileError } = await query.select("*").single();
      if (profileError) throw profileError;
      return json({ profile });
    }

    if (action === "delete-user") {
      const profileId = String(body.profile_id || "");
      const { data: profile, error } = await admin.from("profiles").select("*").eq("id", profileId).single();
      if (error) throw error;
      if (profile.auth_user_id === authData.user.id) return json({ error: "Você não pode excluir seu próprio acesso." }, 400);
      if (profile.auth_user_id) {
        const deleted = await admin.auth.admin.deleteUser(profile.auth_user_id);
        if (deleted.error) throw deleted.error;
      }
      const removed = await admin.from("profiles").delete().eq("id", profileId);
      if (removed.error) throw removed.error;
      return json({ success: true });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erro interno." }, 400);
  }
});
