-- Conversas (WhatsApp, Reddit e importações) passam a ficar no banco, por
-- usuário: cada pessoa da equipe tem a própria conversa com um contato e
-- todos os usuários internos conseguem consultar.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default private.crm_current_profile_id() references public.profiles(id) on delete cascade,
  source text not null default 'WhatsApp',
  origin text,
  conversation_key text not null,
  contact_name text,
  contact text,
  username text,
  profile_url text,
  chat_url text,
  phone text,
  email text,
  contact_id uuid references public.contacts(id) on delete set null,
  amount numeric,
  title text,
  summary text,
  message_count integer not null default 0,
  first_at text,
  last_at text,
  imported_at text,
  status text not null default 'imported',
  messages jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_owner_key_idx on public.conversations (owner_id, source, conversation_key);
create index if not exists conversations_contact_idx on public.conversations (contact_id);

alter table public.conversations enable row level security;

create policy "Internal users can read conversations" on public.conversations
  for select to authenticated using ((select private.crm_current_role()) in ('admin', 'collaborator', 'developer'));
create policy "Internal users can add their conversations" on public.conversations
  for insert to authenticated with check ((select private.crm_can_write()) and owner_id = (select private.crm_current_profile_id()));
create policy "Internal users can update conversations" on public.conversations
  for update to authenticated using ((select private.crm_can_write())) with check ((select private.crm_can_write()));
create policy "Owners and admins can delete conversations" on public.conversations
  for delete to authenticated using (owner_id = (select private.crm_current_profile_id()) or (select private.crm_is_admin()));

alter publication supabase_realtime add table public.conversations;
