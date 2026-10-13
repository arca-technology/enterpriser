begin;
do $$
declare delivery uuid; task uuid; model uuid; violated text; results integer;
begin
  if exists(select 1 from public.activities where title='ONBOARDING' group by delivery_id having count(*)>1) then
    raise exception 'Persisted duplicate onboardings remain';
  end if;
  if exists(select 1 from private.onboarding_repair_snapshots s
    where s.repair='duplicate-onboarding' and s.entity_id=s.preserved_id
      and not exists(select 1 from public.activities a where a.id=s.preserved_id
        and a.status=s.original_row->>'status'
        and ((s.original_row->>'actual_start_date') is null or a.actual_start_date=(s.original_row->>'actual_start_date')::date)
        and ((s.original_row->>'actual_end_date') is null or a.actual_end_date=(s.original_row->>'actual_end_date')::date)
        and ((s.original_row->>'due_date') is null or a.due_date=(s.original_row->>'due_date')::date))) then
    raise exception 'Preserved onboarding history differs from the snapshot';
  end if;
  if has_table_privilege('authenticated','private.onboarding_repair_snapshots','select')
    or has_table_privilege('anon','private.onboarding_repair_snapshots','select') then
    raise exception 'Private repair snapshots are publicly readable';
  end if;
  select id into model from public.product_activity_templates where activity='ONBOARDING' limit 1;
  insert into public.deliveries(name,company_id,product_id,client_name,start_date,end_date,source)
    select 'Onboarding verification fixture',d.company_id,d.product_id,'__verification_fixture__',d.start_date,d.end_date,'manual'
    from public.deliveries d join public.product_activity_templates t on t.product_id=d.product_id
    where t.id=model limit 1 returning id into delivery;
  insert into public.activities(delivery_id,title,activity_type,recurrence,status)
    values(delivery,'ONBOARDING','Reunião','once','done') returning id into task;
  begin
    insert into public.activities(delivery_id,title,category,activity_type,source_template_id)
      values(delivery,'ONBOARDING','Projeto','Reunião',model);
    raise exception 'Unlinked and linked onboarding duplicates were accepted';
  exception when unique_violation then
    get stacked diagnostics violated=constraint_name;
    if violated<>'activities_generic_onboarding_delivery_key' then raise exception 'Unexpected constraint: %',violated; end if;
  end;
  insert into public.activities(delivery_id,title,category,activity_type,module_name)
    values(delivery,'ONBOARDING','Projeto','Reunião','ERP');
  insert into public.activities(delivery_id,title,activity_type,recurrence,occurrence_index)
    values(delivery,'ONBOARDING','Reunião','monthly',0),(delivery,'ONBOARDING','Reunião','monthly',1);
  select count(*) into results from public.activities where delivery_id=delivery;
  if results<>4 then raise exception 'Distinct taxonomy or recurring tasks were incorrectly blocked'; end if;
end $$;
select set_config('request.jwt.claim.sub', (select auth_user_id::text from public.profiles where role='admin' and status='active' and auth_user_id is not null limit 1), true);
set local role authenticated;
do $$
declare delivery uuid; violated text;
begin
  select id into delivery from public.deliveries where client_name='__verification_fixture__';
  if delivery is null then raise exception 'Authenticated admin cannot read the test delivery'; end if;
  begin
    insert into public.activities(delivery_id,title,category,activity_type)
      values(delivery,' onboarding ','Projeto','Reunião');
    raise exception 'Authenticated duplicate insert was accepted';
  exception when unique_violation then
    get stacked diagnostics violated=constraint_name;
    if violated<>'activities_generic_onboarding_delivery_key' then raise exception 'Unexpected authenticated constraint: %',violated; end if;
  end;
end $$;
reset role;
select 'Passed: completed history preserved, private backups protected, new onboarding duplicates rejected, distinct taxonomy and recurring tasks accepted' verification;
rollback;
