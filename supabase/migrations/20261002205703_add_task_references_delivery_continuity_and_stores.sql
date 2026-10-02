alter table public.product_activity_templates
  add column if not exists document_ids uuid[] not null default '{}'::uuid[],
  add column if not exists custom_table_ids uuid[] not null default '{}'::uuid[];

alter table public.activities
  add column if not exists document_ids uuid[] not null default '{}'::uuid[],
  add column if not exists custom_table_ids uuid[] not null default '{}'::uuid[];

alter table public.deliveries
  add column if not exists store_platforms text[] not null default '{}'::text[],
  add column if not exists continuation_of_id uuid;

update public.deliveries
set store_platforms = array[store_platform]
where store_platform is not null
  and btrim(store_platform) <> ''
  and not (store_platform = any(store_platforms));

alter table public.deliveries
  drop constraint if exists deliveries_continuation_of_id_fkey;

alter table public.deliveries
  add constraint deliveries_continuation_of_id_fkey
  foreign key (continuation_of_id) references public.deliveries(id) on delete set null;

alter table public.deliveries
  drop constraint if exists deliveries_continuation_not_self;

alter table public.deliveries
  add constraint deliveries_continuation_not_self
  check (continuation_of_id is null or continuation_of_id <> id);

create index if not exists deliveries_continuation_of_id_idx
  on public.deliveries(continuation_of_id);

comment on column public.product_activity_templates.document_ids is 'Documentos de apoio vinculados ao modelo da tarefa.';
comment on column public.product_activity_templates.custom_table_ids is 'Tabelas de apoio vinculadas ao modelo da tarefa.';
comment on column public.activities.document_ids is 'Documentos de apoio vinculados a tarefa.';
comment on column public.activities.custom_table_ids is 'Tabelas de apoio vinculadas a tarefa.';
comment on column public.deliveries.store_platforms is 'Lojas ativadas para a entrega.';
comment on column public.deliveries.continuation_of_id is 'Entrega anterior da qual esta entrega e continuidade.';
