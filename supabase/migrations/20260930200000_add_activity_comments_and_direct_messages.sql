create table if not exists public.activity_comments (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete restrict,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists activity_comments_activity_created_idx
  on public.activity_comments(activity_id, created_at);
create index if not exists activity_comments_author_id_idx
  on public.activity_comments(author_id);

alter table public.activity_comments enable row level security;
revoke all on table public.activity_comments from anon, authenticated;
grant select, insert, delete on table public.activity_comments to authenticated;

create policy "Active users can read activity comments"
on public.activity_comments for select to authenticated
using ((select private.crm_has_active_access()));

create policy "Active users can add their activity comments"
on public.activity_comments for insert to authenticated
with check (
  (select private.crm_has_active_access())
  and author_id = (
    select p.id from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
    limit 1
  )
);

create policy "Authors and admins can delete activity comments"
on public.activity_comments for delete to authenticated
using (
  author_id = (
    select p.id from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
    limit 1
  )
  or exists (
    select 1 from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active' and p.role = 'admin'
  )
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);

create index if not exists direct_messages_conversation_idx
  on public.direct_messages(sender_id, recipient_id, created_at);
create index if not exists direct_messages_recipient_created_idx
  on public.direct_messages(recipient_id, created_at desc);

alter table public.direct_messages enable row level security;
revoke all on table public.direct_messages from anon, authenticated;
grant select, insert, delete on table public.direct_messages to authenticated;

create policy "Users can read their direct messages"
on public.direct_messages for select to authenticated
using (
  (select private.crm_has_active_access())
  and (
    sender_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' limit 1)
    or recipient_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' limit 1)
  )
);

create policy "Users can send direct messages"
on public.direct_messages for insert to authenticated
with check (
  (select private.crm_has_active_access())
  and sender_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' limit 1)
  and exists (select 1 from public.profiles recipient where recipient.id = recipient_id and recipient.status = 'active')
);

create policy "Senders can delete their direct messages"
on public.direct_messages for delete to authenticated
using (
  sender_id = (select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) and p.status = 'active' limit 1)
);
