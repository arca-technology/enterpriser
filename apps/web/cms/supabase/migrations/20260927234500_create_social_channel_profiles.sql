create table if not exists public.social_channel_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  channel text not null check (channel in ('facebook', 'instagram', 'linkedin', 'reddit', 'tiktokshop', 'youtube')),
  username text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, channel)
);

alter table public.social_channel_profiles enable row level security;

revoke all on table public.social_channel_profiles from anon, authenticated;
grant select, insert, update, delete on table public.social_channel_profiles to authenticated;

create policy "Users can read their own social profiles"
on public.social_channel_profiles for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own social profiles"
on public.social_channel_profiles for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own social profiles"
on public.social_channel_profiles for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own social profiles"
on public.social_channel_profiles for delete
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists social_channel_profiles_user_id_idx
  on public.social_channel_profiles(user_id);
