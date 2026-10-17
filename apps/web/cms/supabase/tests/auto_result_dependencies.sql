begin;
select set_config('request.jwt.claim.sub',(select auth_user_id::text from public.profiles where role='admin' and status='active' and auth_user_id is not null limit 1),true);
set local role authenticated;
do $$
declare
  a uuid;
  b uuid;
  task_id uuid:=gen_random_uuid();
  goal_id uuid:=gen_random_uuid();
  objective_id uuid:=gen_random_uuid();
  family_id uuid:=gen_random_uuid();
  source_child uuid;
  target_child uuid;
  target_task uuid;
  target_goal uuid;
  parent_id uuid:=gen_random_uuid();
  subtask_id uuid:=gen_random_uuid();
  failed_id uuid:=gen_random_uuid();
  n integer;
  rejected boolean:=false;
  payload jsonb;
begin
  select id into a from public.products order by id limit 1;
  select id into b from public.products order by id limit 1 offset 1;
  insert into public.product_activity_templates(id,product_id,activity,category) values(task_id,a,'__certificate_'||task_id::text,'ERP');
  insert into public.product_goal_templates(id,product_id,name,metric,target_value,dependency_activity_template_ids) values(goal_id,a,'__goal_'||goal_id::text,'Pedidos',1,array[task_id]);
  payload:=jsonb_build_object('product_id',b,'name','__objective_'||objective_id::text,'dependency_activity_template_ids',jsonb_build_array(task_id),'dependency_goal_template_ids',jsonb_build_array(goal_id));
  perform public.save_result_template_links('objectives',jsonb_build_array(jsonb_build_object('id',objective_id,'body',payload)));
  select dependency_activity_template_ids[1],dependency_goal_template_ids[1] into target_task,target_goal from public.product_objective_templates where id=objective_id;
  if target_task=task_id or target_goal=goal_id then raise exception 'Source IDs leaked into target product'; end if;
  if not exists(select 1 from public.product_activity_templates where id=target_task and product_id=b) then raise exception 'Task dependency missing'; end if;
  if not exists(select 1 from public.product_goal_templates where id=target_goal and product_id=b and dependency_activity_template_ids=array[target_task]) then raise exception 'Goal dependency graph was not remapped'; end if;
  perform public.save_result_template_links('objectives',jsonb_build_array(jsonb_build_object('id',objective_id,'body',payload)));
  select count(*) into n from public.product_activity_templates where product_id=b and activity='__certificate_'||task_id::text;
  if n<>1 then raise exception 'Repeated save duplicated a dependency'; end if;
  insert into public.product_activity_templates(id,product_id,activity,category,variation_axes) values(family_id,a,'__task_family_'||family_id::text,'ERP','{"channel":["BLING","OLIST"]}');
  select id into source_child from public.product_activity_templates where variation_parent_id=family_id and channel='BLING';
  update public.product_activity_templates set information='Exclusive Bling information',target_days=5 where id=source_child;
  perform public.save_result_template_links('objectives',jsonb_build_array(jsonb_build_object('id',objective_id,'body',jsonb_build_object('dependency_activity_template_ids',jsonb_build_array(source_child)))));
  select dependency_activity_template_ids[1] into target_child from public.product_objective_templates where id=objective_id;
  if not exists(select 1 from public.product_activity_templates t join public.product_activity_templates p on p.id=t.variation_parent_id where t.id=target_child and t.product_id=b and p.product_id=b and t.information='Exclusive Bling information' and t.target_days=5 and t.channel='BLING') then raise exception 'Task variation details lost'; end if;
  insert into public.product_activity_templates(id,product_id,activity) values(parent_id,a,'__parent_'||parent_id::text);
  insert into public.product_activity_templates(id,product_id,activity,parent_template_id) values(subtask_id,a,'__subtask_'||subtask_id::text,parent_id);
  perform public.save_result_template_links('goals',jsonb_build_array(jsonb_build_object('id',target_goal,'body',jsonb_build_object('dependency_activity_template_ids',jsonb_build_array(subtask_id)))));
  if not exists(select 1 from public.product_goal_templates g join public.product_activity_templates t on t.id=g.dependency_activity_template_ids[1] join public.product_activity_templates p on p.id=t.parent_template_id where g.id=target_goal and t.product_id=b and p.product_id=b) then raise exception 'Subtask parent missing'; end if;
  family_id:=gen_random_uuid();
  insert into public.product_goal_templates(id,product_id,name,metric,target_value,variation_axes) values(family_id,a,'__goal_family_'||family_id::text,'Pedidos',1,'{"channel":["AMAZON","SHOPEE"]}');
  select id into source_child from public.product_goal_templates where variation_parent_id=family_id and channel='AMAZON';
  update public.product_goal_templates set target_value=99 where id=source_child;
  perform public.save_result_template_links('objectives',jsonb_build_array(jsonb_build_object('id',objective_id,'body',jsonb_build_object('dependency_goal_template_ids',jsonb_build_array(source_child)))));
  if not exists(select 1 from public.product_objective_templates o join public.product_goal_templates g on g.id=o.dependency_goal_template_ids[1] where o.id=objective_id and g.product_id=b and g.target_value=99 and g.channel='AMAZON') then raise exception 'Goal variation details lost'; end if;
  task_id:=gen_random_uuid();
  insert into public.product_activity_templates(id,product_id,activity) values(task_id,a,'__rollback_'||task_id::text);
  begin
    perform public.save_result_template_links('objectives',jsonb_build_array(
      jsonb_build_object('id',failed_id,'body',jsonb_build_object('product_id',b,'name','__failed_'||failed_id::text,'dependency_activity_template_ids',jsonb_build_array(task_id))),
      jsonb_build_object('id',gen_random_uuid(),'body',jsonb_build_object('unknown_column',true))));
  exception when others then rejected:=true;
  end;
  if not rejected or exists(select 1 from public.product_activity_templates where product_id=b and activity='__rollback_'||task_id::text) or exists(select 1 from public.product_objective_templates where id=failed_id) then raise exception 'Dependency writes were not rolled back with the batch'; end if;
end $$;
rollback;
select 'PASS: recursive task/goal prerequisites, reuse, variation details, subtask parents and atomic rollback. All test writes rolled back.' as result;
