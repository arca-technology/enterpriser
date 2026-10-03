alter table public.direct_messages
  add column if not exists read_at timestamptz;

comment on column public.direct_messages.read_at is
  'Momento em que o destinatário abriu a mensagem no chat interno.';

create index if not exists direct_messages_unread_recipient_idx
  on public.direct_messages(recipient_id, created_at desc)
  where read_at is null;

grant update(read_at) on table public.direct_messages to authenticated;

create policy "Recipients can mark direct messages as read"
on public.direct_messages for update to authenticated
using (
  recipient_id = (
    select p.id from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
    limit 1
  )
)
with check (
  recipient_id = (
    select p.id from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
    limit 1
  )
);
