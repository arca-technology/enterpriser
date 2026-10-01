create or replace function private.crm_can_use_internal_chat()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.auth_user_id = (select auth.uid())
       and p.status = 'active'
       and p.role in ('admin', 'collaborator')
  );
$$;

revoke all on function private.crm_can_use_internal_chat() from public;
revoke all on function private.crm_can_use_internal_chat() from anon;
grant execute on function private.crm_can_use_internal_chat() to authenticated;

drop policy if exists "Users can read their direct messages" on public.direct_messages;
drop policy if exists "Users can send direct messages" on public.direct_messages;
drop policy if exists "Senders can delete their direct messages" on public.direct_messages;
drop policy if exists "Recipients can mark direct messages as read" on public.direct_messages;

create policy "Internal users can read their direct messages"
on public.direct_messages for select to authenticated
using (
  (select private.crm_can_use_internal_chat())
  and (
    sender_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role in ('admin', 'collaborator') limit 1)
    or recipient_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role in ('admin', 'collaborator') limit 1)
  )
);

create policy "Internal users can send direct messages"
on public.direct_messages for insert to authenticated
with check (
  (select private.crm_can_use_internal_chat())
  and sender_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role in ('admin', 'collaborator') limit 1)
  and exists (
    select 1 from public.profiles recipient
     where recipient.id = recipient_id
       and recipient.status = 'active'
       and recipient.role in ('admin', 'collaborator')
  )
);

create policy "Internal senders can delete their direct messages"
on public.direct_messages for delete to authenticated
using (
  (select private.crm_can_use_internal_chat())
  and sender_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role in ('admin', 'collaborator') limit 1)
);

create policy "Internal recipients can mark direct messages as read"
on public.direct_messages for update to authenticated
using (
  (select private.crm_can_use_internal_chat())
  and recipient_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role in ('admin', 'collaborator') limit 1)
)
with check (
  (select private.crm_can_use_internal_chat())
  and recipient_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role in ('admin', 'collaborator') limit 1)
);

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
     and role in ('admin', 'collaborator')
  returning * into updated_profile;

  if updated_profile.id is null then
    raise exception 'Chat disponível apenas para colaboradores e administradores ativos.' using errcode = '42501';
  end if;

  return updated_profile;
end;
$$;

revoke all on function public.set_my_chat_status(text) from public;
revoke all on function public.set_my_chat_status(text) from anon;
grant execute on function public.set_my_chat_status(text) to authenticated;
