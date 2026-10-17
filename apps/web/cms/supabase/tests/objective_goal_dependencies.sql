-- Fixtures and all writes are rolled back.
begin;
do $test$
declare
  product uuid;
  delivery uuid;
  goal uuid := gen_random_uuid();
  second_goal uuid := gen_random_uuid();
  objective uuid := gen_random_uuid();
  family uuid := gen_random_uuid();
  child uuid;
  goal_execution uuid := gen_random_uuid();
  objective_execution uuid := gen_random_uuid();
begin
  select id,product_id into delivery,product from public.deliveries limit 1;
  insert into public.product_goal_templates(id,product_id,name,metric,target_value) values
    (goal,product,'Goal dependency fixture','Pedidos',1),(second_goal,product,'Second dependency fixture','Pedidos',2);
  insert into public.product_objective_templates(id,product_id,name,dependency_goal_template_ids)
    values(objective,product,'Objective dependency fixture',array[goal]);
  begin
    update public.product_goal_templates set variation_axes='{"channel":["BLING","OLIST"]}' where id=goal;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  begin
    delete from public.product_goal_templates where id=goal;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  insert into public.product_objective_templates(id,product_id,name,dependency_goal_template_ids,variation_axes)
    values(family,product,'Objective family fixture',array[goal],'{"channel":["BLING","OLIST"]}');
  select id into child from public.product_objective_templates where variation_parent_id=family order by channel limit 1;
  if not exists(select 1 from public.product_objective_templates where id=child and dependency_goal_template_ids=array[goal]) then raise exception 'Goal dependency was not inherited'; end if;
  update public.product_objective_templates set dependency_goal_template_ids=array[second_goal] where id=child;
  update public.product_objective_templates set notes='Parent updated' where id=family;
  if not exists(select 1 from public.product_objective_templates where id=child and dependency_goal_template_ids=array[second_goal]
    and variation_override_fields @> array['dependency_goal_template_ids']) then raise exception 'Child goal dependency override was lost'; end if;
  insert into public.delivery_goals(id,delivery_id,source_template_id,name,metric,target_value)
    values(goal_execution,delivery,goal,'Dependency execution','Pedidos',1);
  insert into public.delivery_objectives(id,delivery_id,source_template_id,name,dependency_goal_ids)
    values(objective_execution,delivery,objective,'Dependent objective',array[goal_execution]);
  begin
    update public.delivery_objectives set status='doing' where id=objective_execution;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  update public.delivery_goals set status='done' where id=goal_execution;
  update public.delivery_objectives set status='doing' where id=objective_execution;
  begin
    update public.delivery_goals set status='todo' where id=goal_execution;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  update public.delivery_objectives set status='todo' where id=objective_execution;
  update public.delivery_goals set status='todo' where id=goal_execution;
  begin
    update public.product_objective_templates set dependency_goal_template_ids=array[gen_random_uuid()] where id=objective;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  begin
    update public.delivery_objectives set dependency_goal_ids=array[gen_random_uuid()] where id=objective_execution;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
end $test$;
rollback;
