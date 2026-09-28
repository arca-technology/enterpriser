alter table public.profiles
  add column if not exists permissions jsonb not null default '{}'::jsonb;

comment on column public.profiles.permissions is
  'Per-module CRM permissions managed by administrators.';
