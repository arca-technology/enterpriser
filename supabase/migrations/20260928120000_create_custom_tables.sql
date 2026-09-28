create table public.custom_tables (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  column_definitions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(column_definitions) = 'array'),
  row_data jsonb not null default '[]'::jsonb
    check (jsonb_typeof(row_data) = 'array'),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.custom_tables is
  'Tabelas simples criadas no CRM, com colunas e linhas dinâmicas armazenadas em JSON.';

create index custom_tables_updated_at_idx on public.custom_tables(updated_at desc);
create index custom_tables_created_by_idx on public.custom_tables(created_by);

alter table public.custom_tables enable row level security;

create policy authenticated_active_select
on public.custom_tables
for select
to authenticated
using ((select private.crm_has_active_access()));

create policy admin_insert
on public.custom_tables
for insert
to authenticated
with check (
  (select private.crm_has_active_access())
  and created_by = (select auth.uid())
  and exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

create policy admin_update
on public.custom_tables
for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

create policy admin_delete
on public.custom_tables
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

grant select, insert, update, delete on public.custom_tables to authenticated;
revoke all on public.custom_tables from anon;
