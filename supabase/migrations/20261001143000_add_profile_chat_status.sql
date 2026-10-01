alter table public.profiles
  add column if not exists chat_status text not null default 'available',
  add column if not exists chat_status_updated_at timestamptz not null default now();

alter table public.profiles
  drop constraint if exists profiles_chat_status_check;

alter table public.profiles
  add constraint profiles_chat_status_check
  check (chat_status in ('available', 'away', 'off_hours'));

create or replace function public.set_my_chat_status(p_status text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_profile public.profiles;
begin
  if p_status not in ('available', 'away', 'off_hours') then
    raise exception 'Status de chat inválido.' using errcode = '22023';
  end if;

  update public.profiles
     set chat_status = p_status,
         chat_status_updated_at = now(),
         updated_at = now()
   where auth_user_id = (select auth.uid())
     and status = 'active'
  returning * into updated_profile;

  if updated_profile.id is null then
    raise exception 'Perfil ativo não encontrado.' using errcode = '42501';
  end if;

  return updated_profile;
end;
$$;

revoke all on function public.set_my_chat_status(text) from public;
revoke all on function public.set_my_chat_status(text) from anon;
grant execute on function public.set_my_chat_status(text) to authenticated;

comment on column public.profiles.chat_status is
  'Presença escolhida pelo colaborador: available, away ou off_hours. O cliente exibe off_hours automaticamente entre 18:00 e 08:00.';

comment on function public.set_my_chat_status(text) is
  'Permite que um colaborador ativo altere exclusivamente o próprio status de presença no chat.';
