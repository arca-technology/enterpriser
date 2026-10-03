alter table public.profiles
  drop constraint if exists profiles_role_check;

update public.profiles
set role = 'collaborator',
    updated_at = now()
where role = 'user';

alter table public.profiles
  alter column role set default 'collaborator';

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('collaborator', 'developer', 'admin', 'client', 'supplier'));

comment on column public.profiles.role is
  'Perfil de acesso: collaborator, developer, admin, client ou supplier.';
