create table private.onboarding_repair_snapshots (
  repair text not null,
  entity_table text not null,
  entity_id uuid not null,
  preserved_id uuid,
  original_row jsonb not null,
  captured_at timestamptz not null default now(),
  primary key (repair, entity_table, entity_id)
);
alter table private.onboarding_repair_snapshots enable row level security;
revoke all on private.onboarding_repair_snapshots from public, anon, authenticated;
grant select on private.onboarding_repair_snapshots to service_role;

create function private.crm_is_generic_onboarding(p_title text, p_category text, p_channel text,
  p_module text, p_submodule text, p_type text, p_recurrence text, p_parent uuid)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select lower(btrim(coalesce(p_title, ''))) = 'onboarding'
    and coalesce(p_recurrence, 'once') = 'once' and p_parent is null
    and lower(btrim(coalesce(p_category, ''))) in ('', 'projeto')
    and lower(btrim(coalesce(p_type, ''))) in ('', 'reunião', 'reuniao')
    and btrim(coalesce(p_channel, '')) = '' and btrim(coalesce(p_module, '')) = ''
    and btrim(coalesce(p_submodule, '')) = '';
$$;
revoke all on function private.crm_is_generic_onboarding(text,text,text,text,text,text,text,uuid) from public, anon;
grant execute on function private.crm_is_generic_onboarding(text,text,text,text,text,text,text,uuid) to authenticated, service_role;

-- Preserve the older D'ELUS delivery explicitly chosen by the user, with a full snapshot of the unused copy.
lock table public.deliveries, public.activities, public.delivery_goals, public.delivery_objectives in share row exclusive mode;
do $$
declare old_delivery public.deliveries; duplicate public.deliveries; matching_count integer;
begin
  select d.* into old_delivery from public.deliveries d join public.products p on p.id=d.product_id
    where d.client_name='D''ELUS' and p.name='@START' order by d.created_at limit 1;
  if old_delivery.id is null then return; end if;
  select count(*) into matching_count from public.deliveries d
    where d.company_id=old_delivery.company_id and d.product_id=old_delivery.product_id
      and d.client_name=old_delivery.client_name and d.start_date=old_delivery.start_date and d.end_date=old_delivery.end_date;
  if matching_count=1 then return; end if;
  if matching_count<>2 then raise exception 'Unexpected D ELUS delivery count; manual review required'; end if;
  select d.* into duplicate from public.deliveries d where d.id<>old_delivery.id
    and d.company_id=old_delivery.company_id and d.product_id=old_delivery.product_id
    and d.client_name=old_delivery.client_name and d.start_date=old_delivery.start_date and d.end_date=old_delivery.end_date;
  if duplicate.created_at::date<>'2026-10-13'::date or duplicate.negotiation_id is not null
    or duplicate.continuation_of_id is not null or duplicate.business_metrics<>'[]'::jsonb then
    raise exception 'D ELUS copy differs from the audited delivery';
  end if;
  if exists(select 1 from public.activities a where a.delivery_id=duplicate.id and (
      a.source_template_id is null or a.status<>'todo' or a.actual_start_date is not null or a.actual_end_date is not null
      or nullif(btrim(a.notes),'') is not null or cardinality(a.document_ids)>0 or cardinality(a.custom_table_ids)>0
      or exists(select 1 from jsonb_array_elements(a.checklist) item where item->>'checked'='true')))
    or exists(select 1 from public.activity_comments c join public.activities a on a.id=c.activity_id where a.delivery_id=duplicate.id)
    or exists(select 1 from public.delivery_goals g where g.delivery_id=duplicate.id and (
      coalesce(g.current_value,0)<>0 or g.status<>'todo' or nullif(btrim(g.notes),'') is not null or nullif(btrim(g.comments),'') is not null))
    or exists(select 1 from public.delivery_objectives o where o.delivery_id=duplicate.id and (
      o.status<>'todo' or nullif(btrim(o.notes),'') is not null or nullif(btrim(o.comments),'') is not null))
    or exists(select 1 from public.client_email_accounts e where e.delivery_id=duplicate.id)
    or exists(select 1 from public.deliveries d where d.continuation_of_id=duplicate.id) then
    raise exception 'The duplicate delivery contains work or external links; do not delete it automatically';
  end if;
  insert into private.onboarding_repair_snapshots(repair,entity_table,entity_id,preserved_id,original_row)
    select 'duplicate-delivery','deliveries',duplicate.id,old_delivery.id,to_jsonb(duplicate)
    union all select 'duplicate-delivery','activities',a.id,old_delivery.id,to_jsonb(a) from public.activities a where a.delivery_id=duplicate.id
    union all select 'duplicate-delivery','delivery_goals',g.id,old_delivery.id,to_jsonb(g) from public.delivery_goals g where g.delivery_id=duplicate.id
    union all select 'duplicate-delivery','delivery_objectives',o.id,old_delivery.id,to_jsonb(o) from public.delivery_objectives o where o.delivery_id=duplicate.id;
  delete from public.deliveries where id=duplicate.id;
end $$;

create temp table onboarding_repair_plan on commit drop as
with templates as (
  select product_id,min(id::text)::uuid template_id from public.product_activity_templates t
    where private.crm_is_generic_onboarding(t.activity,t.category,t.channel,t.module_name,t.submodule_name,t.activity_type,t.recurrence,t.parent_template_id)
    group by product_id having count(*)=1
), candidates as (
  select a.*,t.template_id,
    count(*) over(partition by a.delivery_id) group_size,
    first_value(a.id) over(partition by a.delivery_id order by
      case a.status when 'done' then 0 when 'doing' then 1 when 'todo' then 2 else 3 end,
      a.schedule_manual desc,(a.due_date is not null) desc,a.created_at,a.id) kept_id
  from public.activities a join public.deliveries d on d.id=a.delivery_id join templates t on t.product_id=d.product_id
  where private.crm_is_generic_onboarding(a.title,a.category,a.channel,a.module_name,a.submodule_name,a.activity_type,a.recurrence,a.parent_activity_id)
) select * from candidates where group_size>1;

-- Abort rather than discard any unreviewed notes, checklist progress or linked records.
do $$ begin
  if (select count(*) from onboarding_repair_plan)>100 then raise exception 'Unexpected onboarding repair size'; end if;
  if exists(select 1 from onboarding_repair_plan where nullif(btrim(notes),'') is not null
      or nullif(btrim(information),'') is not null or checklist<>'[]'::jsonb or objective_id is not null
      or cardinality(document_ids)>0 or cardinality(custom_table_ids)>0 or cardinality(dependency_ids)>0 or depends_on_activity_id is not null)
    or exists(select 1 from public.activity_comments where activity_id in(select id from onboarding_repair_plan))
    or exists(select 1 from public.activities a where a.parent_activity_id in(select id from onboarding_repair_plan)
      or a.depends_on_activity_id in(select id from onboarding_repair_plan)
      or a.dependency_ids && array(select id from onboarding_repair_plan))
    or exists(select 1 from public.delivery_goals g where g.dependency_activity_ids && array(select id from onboarding_repair_plan))
    or exists(select 1 from public.delivery_objectives o where o.dependency_activity_ids && array(select id from onboarding_repair_plan)) then
    raise exception 'Onboarding records gained work or links since audit; manual merge required';
  end if;
end $$;
insert into private.onboarding_repair_snapshots(repair,entity_table,entity_id,preserved_id,original_row)
  select 'duplicate-onboarding','activities',p.id,p.kept_id,to_jsonb(a)
    from onboarding_repair_plan p join public.activities a on a.id=p.id;

create temp table onboarding_repair_values on commit drop as
  select kept_id,template_id,min(actual_start_date) actual_start,max(actual_end_date) actual_end,
    min(planned_start_date) planned_start,min(planned_end_date) planned_end,min(due_date) due,
    bool_or(schedule_manual) manual,bool_or(assign_to_client) client,
    array(select distinct x from onboarding_repair_plan p2 cross join lateral unnest(p2.assignee_ids || array[p2.owner_id]) x
      where p2.kept_id=p.kept_id and x is not null order by x) assignees,
    array(select distinct x from onboarding_repair_plan p2 cross join lateral unnest(p2.assignee_job_titles) x
      where p2.kept_id=p.kept_id order by x) job_titles
  from onboarding_repair_plan p group by kept_id,template_id;
delete from public.activities a using onboarding_repair_plan p where a.id=p.id and p.id<>p.kept_id;
update public.activities a set source_template_id=v.template_id,occurrence_index=0,
  assignee_ids=v.assignees,assignee_job_titles=v.job_titles,owner_id=coalesce(a.owner_id,v.assignees[1]),
  actual_start_date=coalesce(a.actual_start_date,v.actual_start),actual_end_date=coalesce(a.actual_end_date,v.actual_end),
  planned_start_date=coalesce(a.planned_start_date,v.planned_start),planned_end_date=coalesce(a.planned_end_date,v.planned_end),
  due_date=coalesce(a.due_date,v.due),schedule_manual=v.manual,assign_to_client=v.client,updated_at=now()
  from onboarding_repair_values v where a.id=v.kept_id;

create unique index activities_generic_onboarding_delivery_key on public.activities(delivery_id)
  where private.crm_is_generic_onboarding(title,category,channel,module_name,submodule_name,activity_type,recurrence,parent_activity_id);
