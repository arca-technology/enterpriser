alter table public.activities
  add column if not exists target_days integer;

alter table public.activities
  drop constraint if exists activities_target_days_check;

alter table public.activities
  add constraint activities_target_days_check
  check (target_days is null or target_days >= 0);

comment on column public.activities.target_days is
  'Prazo sugerido em dias herdado do modelo de tarefa.';
