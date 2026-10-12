-- Identity assets belong to the current workspace; this is not tenant isolation.
alter table public.profiles add column avatar_path text;
alter table public.profiles add constraint profiles_avatar_namespace check (
  avatar_path is null or (auth_user_id is not null and
    avatar_path ~ ('^users/' || auth_user_id::text || '/[0-9a-f-]{36}\.webp$'))
);

revoke update on public.profiles from authenticated;
grant update (full_name, nickname, phone, avatar_path) on public.profiles to authenticated;
create policy profiles_update_own_identity on public.profiles for update to authenticated
  using (auth_user_id = (select auth.uid()) and status = 'active')
  with check (auth_user_id = (select auth.uid()) and status = 'active');

create table public.crm_workspace_settings (
  id boolean primary key default true check (id),
  company_name text not null default 'ECOMMERCE365' check (length(trim(company_name)) between 1 and 160),
  logo_path text check (logo_path is null or logo_path ~ '^workspace/[0-9a-f-]{36}\.webp$')
);
insert into public.crm_workspace_settings (id) values (true);
alter table public.crm_workspace_settings enable row level security;
revoke all on public.crm_workspace_settings from anon, authenticated;
grant select on public.crm_workspace_settings to authenticated;
grant update (company_name, logo_path) on public.crm_workspace_settings to authenticated;
grant all on public.crm_workspace_settings to service_role;
create policy workspace_identity_read on public.crm_workspace_settings for select to authenticated
  using ((select private.crm_has_active_access()));
create policy workspace_identity_admin_update on public.crm_workspace_settings for update to authenticated
  using ((select private.crm_current_role()) = 'admin')
  with check ((select private.crm_current_role()) = 'admin');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('crm-identity-assets', 'crm-identity-assets', false, 1048576, array['image/webp']);
create policy identity_assets_read on storage.objects for select to authenticated
  using (bucket_id = 'crm-identity-assets' and (select private.crm_has_active_access()));
create policy identity_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'crm-identity-assets' and (select private.crm_has_active_access()) and (
    name ~ ('^users/' || (select auth.uid())::text || '/[0-9a-f-]{36}\.webp$') or
    ((select private.crm_current_role()) = 'admin' and name ~ '^workspace/[0-9a-f-]{36}\.webp$')
  ));
create policy identity_assets_delete on storage.objects for delete to authenticated
  using (bucket_id = 'crm-identity-assets' and (select private.crm_has_active_access()) and (
    name ~ ('^users/' || (select auth.uid())::text || '/[0-9a-f-]{36}\.webp$') or
    ((select private.crm_current_role()) = 'admin' and name ~ '^workspace/[0-9a-f-]{36}\.webp$')
  ));
