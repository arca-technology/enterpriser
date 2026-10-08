create table if not exists public.user_ui_preferences (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  column_preferences jsonb not null default '{}'::jsonb,
  secondary_column_preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_ui_preferences enable row level security;

revoke all on table public.user_ui_preferences from anon, authenticated;
grant select, insert, update on table public.user_ui_preferences to authenticated;

drop policy if exists "Users can read their own UI preferences" on public.user_ui_preferences;
create policy "Users can read their own UI preferences"
on public.user_ui_preferences for select
to authenticated
using (profile_id = (select private.crm_current_profile_id()));

drop policy if exists "Users can create their own UI preferences" on public.user_ui_preferences;
create policy "Users can create their own UI preferences"
on public.user_ui_preferences for insert
to authenticated
with check (profile_id = (select private.crm_current_profile_id()));

drop policy if exists "Users can update their own UI preferences" on public.user_ui_preferences;
create policy "Users can update their own UI preferences"
on public.user_ui_preferences for update
to authenticated
using (profile_id = (select private.crm_current_profile_id()))
with check (profile_id = (select private.crm_current_profile_id()));

comment on table public.user_ui_preferences is
  'Preferências visuais persistentes por usuário, incluindo visibilidade e ordem das colunas.';
