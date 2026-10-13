-- All fixtures and temporary profile changes are rolled back.
begin;
create temp table routing_checks (message text);
create temp table routing_context (actor uuid, auth_actor uuid, owner uuid, task uuid);
grant all on routing_checks, routing_context to authenticated;
do $$
declare
  delivery uuid; first_user uuid := gen_random_uuid(); second_user uuid := gen_random_uuid();
  inactive_user uuid := gen_random_uuid(); task_id uuid; actual public.activities;
begin
  select id into delivery from public.deliveries limit 1;
  if delivery is null then raise exception 'A delivery is required for this test'; end if;
  insert into public.profiles(id,full_name,email,role,status,permissions,auto_assignment_categories,
    auto_assignment_channels,auto_assignment_modules,auto_assignment_submodules) values
    (first_user,'A routing fixture','routing-a@example.test','collaborator','active',
      '{"activities":{"view":true,"operate":true}}','{__codex_routing__,Alternate}','{Bling}', '{Contas}', '{Pagar,Receber}'),
    (second_user,'B routing fixture','routing-b@example.test','collaborator','active',
      '{"activities":{"view":true,"edit":true}}','{__codex_routing__}','{}','{}','{}'),
    (inactive_user,'C routing fixture','routing-c@example.test','collaborator','inactive',
      '{"activities":{"view":true,"operate":true}}','{__codex_routing__}','{}','{}','{}');
  insert into public.activities(delivery_id,title,category,channel,module_name,submodule_name)
    values(delivery,'Routing fixture',' __CODEX_ROUTING__ ','bling','Contas','Receber') returning * into actual;
  if actual.owner_id <> first_user or actual.assignee_ids <> array[first_user,second_user] then
    raise exception 'Multiple matching users were not assigned: %',actual.assignee_ids;
  end if;
  task_id := actual.id;
  insert into public.activities(delivery_id,title,category,channel,module_name,submodule_name)
    values(delivery,'Mismatch fixture','__codex_routing__','Other','Contas','Receber') returning * into actual;
  if actual.assignee_ids <> array[second_user] then raise exception 'AND/wildcard matching failed'; end if;
  insert into public.activities(delivery_id,title,category,owner_id,assignee_ids)
    values(delivery,'Manual fixture','__codex_routing__',second_user,array[second_user]) returning * into actual;
  if actual.owner_id <> second_user or actual.assignee_ids <> array[second_user] then raise exception 'Manual assignment overwritten'; end if;
  insert into public.activities(delivery_id,title,category,assignee_job_titles)
    values(delivery,'Job fixture','__codex_routing__','{Gestor}') returning * into actual;
  if actual.owner_id is not null or cardinality(actual.assignee_ids) > 0 then raise exception 'Job assignment overwritten'; end if;
  insert into public.activities(delivery_id,title,category,assign_to_client)
    values(delivery,'Client fixture','__codex_routing__',true) returning * into actual;
  if actual.owner_id is not null or cardinality(actual.assignee_ids) > 0 then raise exception 'Client assignment overwritten'; end if;
  update public.profiles set auto_assignment_categories='{}' where id=first_user;
  update public.activities set category='Other' where id=task_id returning * into actual;
  if actual.assignee_ids <> array[first_user,second_user] then raise exception 'Existing task reassigned on update'; end if;
  insert into public.activities(delivery_id,title,category)
    values(delivery,'No match fixture','__codex_no_match__') returning * into actual;
  if actual.owner_id is not null then raise exception 'All-empty rules assigned a task'; end if;
  insert into routing_context select id,auth_user_id,first_user,task_id from public.profiles
    where role='collaborator' and status='active' and auth_user_id is not null limit 1;
  insert into routing_checks values ('Routing: multiple selections, AND/OR, case/trim, multiple assignees, wildcard, inactive exclusion, explicit assignments and insert-only behavior passed');
end $$;

update public.profiles set access_profile='project_manager',
  permissions=permissions || '{"activities":{"view":true,"edit":true,"operate":true},"projects":{"view":true,"edit":true,"operate":true}}'
  where id=(select actor from routing_context);
select set_config('request.jwt.claim.sub',(select auth_actor::text from routing_context),true);
set local role authenticated;
do $$ begin
  if not private.crm_manages_pm('activities','view') or private.crm_manages_pm('users','edit') then
    raise exception 'Manager scope invalid';
  end if;
  if not exists(select 1 from public.activities where id=(select task from routing_context)) then raise exception 'Manager cannot see team task'; end if;
  if not private.crm_can_mutate_assigned((select owner from routing_context),'{}','{}','projects','edit') then
    raise exception 'Manager cannot edit team result';
  end if;
  update public.activities set notes='Manager fixture' where id=(select task from routing_context);
  if not found then raise exception 'Manager cannot edit team task'; end if;
  begin
    update public.profiles set access_profile='custom' where id=(select actor from routing_context);
    raise exception 'Self access escalation column was writable';
  exception when insufficient_privilege then null; end;
  insert into routing_checks values ('Manager: team visibility/editing, PM-only scope and blocked self profile mutation passed');
end $$;
reset role;
update public.profiles set access_profile='custom' where id=(select actor from routing_context);
set local role authenticated;
do $$ begin
  if exists(select 1 from public.activities where id=(select task from routing_context)) then raise exception 'Ordinary collaborator saw unrelated task'; end if;
  update public.activities set notes='Not allowed' where id=(select task from routing_context);
  if found then raise exception 'Ordinary collaborator edited unrelated task'; end if;
  insert into routing_checks values ('Ordinary collaborator ownership restrictions preserved');
end $$;
reset role;
update public.profiles set access_profile='project_manager', permissions=permissions || '{"activities":{"view":false,"edit":false,"operate":false}}'
  where id=(select actor from routing_context);
set local role authenticated;
do $$ begin
  if private.crm_manages_pm('activities','view') or private.crm_can_mutate_assigned((select owner from routing_context),'{}','{}','activities','edit') then
    raise exception 'Manager bypassed disabled module permissions';
  end if;
  insert into routing_checks values ('Manager honors disabled module permissions');
end $$;
reset role;
select json_agg(message) checks from routing_checks;
rollback;
