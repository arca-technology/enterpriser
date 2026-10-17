-- Run against a database with one delivery/task fixture. All test writes are rolled back.
begin;

do $test$
declare
  p uuid; family uuid := gen_random_uuid(); child_ids uuid[]; original_ids uuid[];
  child public.product_activity_templates; original_task public.activities; saved_task public.activities; task_id uuid := gen_random_uuid();
begin
  select d.product_id into p from public.activities a join public.deliveries d on d.id=a.delivery_id limit 1;
  insert into public.product_activity_templates(id,product_id,activity,category,module_name,submodule_name,activity_type,variation_axes,required_setup)
    values(family,p,'','ERP','Financeiro','Contas a pagar','Importação','{"channel":["BLING","OLIST"]}',array['BLING']);
  select array_agg(id order by id) into child_ids from public.product_activity_templates where variation_parent_id=family;
  if cardinality(child_ids) <> 2 then raise exception 'Expected two variations'; end if;
  if not exists (select 1 from public.product_activity_templates where variation_parent_id=family and channel='OLIST' and required_setup=array['OLIST']) then raise exception 'Variant Setup was not isolated'; end if;
  original_ids := child_ids;
  select a.* into original_task from public.activities a join public.deliveries d on d.id=a.delivery_id where d.product_id=p limit 1;
  insert into public.activities select (jsonb_populate_record(null::public.activities,to_jsonb(original_task) || jsonb_build_object(
    'id',task_id,'source_template_id',child_ids[1],'occurrence_index',0,'title','Historical snapshot','status','todo','actual_start_date',null,'actual_end_date',null))).*;
  select * into saved_task from public.activities where id=task_id;
  update public.product_activity_templates set activity='Nome atualizado',information='Instrução comum' where id=family;
  select array_agg(id order by id) into child_ids from public.product_activity_templates where variation_parent_id=family;
  if child_ids <> original_ids or exists(select 1 from public.product_activity_templates where variation_parent_id=family and (activity<>'Nome atualizado' or information<>'Instrução comum')) then raise exception 'Inheritance/id preservation failed'; end if;
  if saved_task is distinct from (select a from public.activities a where id=task_id) then raise exception 'Execution history changed'; end if;
  begin
    update public.product_activity_templates set activity='Override' where id=child_ids[1];
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  begin
    update public.product_activity_templates set variation_axes='{"channel":["BLING"]}' where id=family;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  begin
    insert into public.activities select (jsonb_populate_record(null::public.activities,to_jsonb(original_task) || jsonb_build_object(
      'id',gen_random_uuid(),'source_template_id',family,'occurrence_index',0,'status','todo','actual_start_date',null,'actual_end_date',null))).*;
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  update public.product_activity_templates set variation_axes='{"channel":["BLING","OLIST","INTER"]}' where id=family;
  if (select count(*) from public.product_activity_templates where variation_parent_id=family) <> 3 then raise exception 'Adding variations failed'; end if;
  if (select count(*) from public.task_variation_combinations('{"channel":["BLING","OLIST"],"type":["Importação","Exportação"]}')) <> 4 then raise exception 'Cross product failed'; end if;
end $test$;
rollback;
