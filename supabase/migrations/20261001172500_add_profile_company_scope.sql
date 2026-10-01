alter table public.profiles
  add column if not exists company_ids text[] not null default '{}';

comment on column public.profiles.company_ids is
  'CNPJs das empresas visiveis para perfis client e supplier.';

create or replace function private.crm_current_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.profiles
  where auth_user_id = (select auth.uid())
    and status = 'active'
  limit 1;
$$;

create or replace function private.crm_can_write()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select private.crm_current_role()) in ('admin', 'collaborator'), false);
$$;

create or replace function private.crm_can_access_company(p_company_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when role in ('admin', 'collaborator', 'developer') then true
      when role in ('client', 'supplier') then p_company_id = any(company_ids)
      else false
    end
    from public.profiles
    where auth_user_id = (select auth.uid())
      and status = 'active'
    limit 1
  ), false);
$$;

create or replace function private.crm_can_access_contact(p_contact_id uuid, p_company_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.crm_can_access_company(p_company_id))
    or exists (
      select 1
      from public.contact_companies cc
      where cc.contact_id = p_contact_id
        and (select private.crm_can_access_company(cc.company_id))
    );
$$;

create or replace function private.crm_can_access_delivery(p_delivery_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.deliveries d
    where d.id = p_delivery_id
      and (select private.crm_can_access_company(d.company_id))
  );
$$;

revoke all on function private.crm_current_role() from public;
revoke all on function private.crm_can_write() from public;
revoke all on function private.crm_can_access_company(text) from public;
revoke all on function private.crm_can_access_contact(uuid, text) from public;
revoke all on function private.crm_can_access_delivery(uuid) from public;
grant execute on function private.crm_current_role() to authenticated;
grant execute on function private.crm_can_write() to authenticated;
grant execute on function private.crm_can_access_company(text) to authenticated;
grant execute on function private.crm_can_access_contact(uuid, text) to authenticated;
grant execute on function private.crm_can_access_delivery(uuid) to authenticated;

drop policy if exists authenticated_active_all on public.companies;
create policy authenticated_scoped_select on public.companies
for select to authenticated
using ((select private.crm_can_access_company(tax_id)));
create policy internal_insert on public.companies
for insert to authenticated
with check ((select private.crm_can_write()));
create policy internal_update on public.companies
for update to authenticated
using ((select private.crm_can_write()))
with check ((select private.crm_can_write()));
create policy internal_delete on public.companies
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_all on public.contacts;
create policy authenticated_scoped_select on public.contacts
for select to authenticated
using ((select private.crm_can_access_contact(id, company_id)));
create policy internal_insert on public.contacts
for insert to authenticated
with check ((select private.crm_can_write()));
create policy internal_update on public.contacts
for update to authenticated
using ((select private.crm_can_write()))
with check ((select private.crm_can_write()));
create policy internal_delete on public.contacts
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_select on public.contact_companies;
create policy authenticated_scoped_select on public.contact_companies
for select to authenticated
using ((select private.crm_can_access_company(company_id)));

drop policy if exists authenticated_active_all on public.deliveries;
create policy authenticated_scoped_select on public.deliveries
for select to authenticated
using ((select private.crm_can_access_company(company_id)));
create policy internal_insert on public.deliveries
for insert to authenticated
with check ((select private.crm_can_write()));
create policy internal_update on public.deliveries
for update to authenticated
using ((select private.crm_can_write()))
with check ((select private.crm_can_write()));
create policy internal_delete on public.deliveries
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_all on public.negotiations;
create policy authenticated_scoped_select on public.negotiations
for select to authenticated
using ((select private.crm_can_access_company(company_id)));
create policy internal_insert on public.negotiations
for insert to authenticated
with check ((select private.crm_can_write()));
create policy internal_update on public.negotiations
for update to authenticated
using ((select private.crm_can_write()))
with check ((select private.crm_can_write()));
create policy internal_delete on public.negotiations
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_all on public.activities;
create policy authenticated_scoped_select on public.activities
for select to authenticated
using ((select private.crm_can_access_delivery(delivery_id)));
create policy internal_or_supplier_insert on public.activities
for insert to authenticated
with check (
  (select private.crm_can_write())
  or ((select private.crm_current_role()) = 'supplier' and (select private.crm_can_access_delivery(delivery_id)))
);
create policy internal_or_supplier_update on public.activities
for update to authenticated
using (
  (select private.crm_can_write())
  or ((select private.crm_current_role()) = 'supplier' and (select private.crm_can_access_delivery(delivery_id)))
)
with check (
  (select private.crm_can_write())
  or ((select private.crm_current_role()) = 'supplier' and (select private.crm_can_access_delivery(delivery_id)))
);
create policy internal_delete on public.activities
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_all on public.delivery_objectives;
create policy authenticated_scoped_select on public.delivery_objectives
for select to authenticated
using ((select private.crm_can_access_delivery(delivery_id)));
create policy internal_insert on public.delivery_objectives
for insert to authenticated
with check ((select private.crm_can_write()));
create policy internal_update on public.delivery_objectives
for update to authenticated
using ((select private.crm_can_write()))
with check ((select private.crm_can_write()));
create policy internal_delete on public.delivery_objectives
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_all on public.delivery_goals;
create policy authenticated_scoped_select on public.delivery_goals
for select to authenticated
using ((select private.crm_can_access_delivery(delivery_id)));
create policy internal_insert on public.delivery_goals
for insert to authenticated
with check ((select private.crm_can_write()));
create policy internal_update on public.delivery_goals
for update to authenticated
using ((select private.crm_can_write()))
with check ((select private.crm_can_write()));
create policy internal_delete on public.delivery_goals
for delete to authenticated
using ((select private.crm_can_write()));

drop policy if exists authenticated_active_select on public.company_files;
create policy authenticated_scoped_select on public.company_files
for select to authenticated
using ((select private.crm_can_access_company(company_id)));
