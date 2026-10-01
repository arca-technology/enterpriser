import { createClient } from "npm:@supabase/supabase-js@2.95.0";

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
    if (!actor || actor.role !== "admin" || actor.status !== "active") return json({ error: "Apenas administradores podem gerenciar acessos." }, 403);

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
