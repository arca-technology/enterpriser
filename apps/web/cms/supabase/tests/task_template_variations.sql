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
  update public.product_activity_templates set information='Informação da filha',target_days=5,
    default_assignee_job_titles=array['Analista de operações'],checklist='[{"text":"Conferência exclusiva"}]'
    where id=child_ids[1];
  select * into child from public.product_activity_templates where id=child_ids[1];
  if not child.variation_override_fields @> array['information','target_days','default_assignee_job_titles','checklist'] then
    raise exception 'Customized fields were not tracked';
  end if;
  update public.product_activity_templates set information='Informação do pai',target_days=12,
    default_assignee_job_titles=array['Gerente de operações'],activity='Nome herdado',activity_type='Conciliação' where id=family;
  select * into child from public.product_activity_templates where id=child_ids[1];
  if child.information <> 'Informação da filha' or child.target_days <> 5 or child.activity <> 'Nome herdado'
    or child.activity_type <> 'Conciliação' or child.default_assignee_job_titles <> array['Analista de operações']
    or child.checklist <> '[{"text":"Conferência exclusiva"}]'::jsonb then raise exception 'Customized child details were overwritten'; end if;
  if not exists(select 1 from public.product_activity_templates where id=child_ids[2] and information='Informação do pai'
    and target_days=12 and default_assignee_job_titles=array['Gerente de operações']) then raise exception 'Unmodified sibling stopped inheriting'; end if;
  update public.product_activity_templates set information='',target_days=null where id=child_ids[1];
  update public.product_activity_templates set information='Outro padrão',target_days=20 where id=family;
  if exists(select 1 from public.product_activity_templates where id=child_ids[1] and (information<>'' or target_days is not null)) then
    raise exception 'Explicit clearing was not preserved'; end if;
  begin
    update public.product_activity_templates set channel='OMIE' where id=child_ids[1];
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  begin
    update public.product_activity_templates set variation_override_fields='{}' where id=child_ids[1];
    raise exception 'UNEXPECTED_ALLOWED';
  exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  if saved_task is distinct from (select a from public.activities a where id=task_id) then raise exception 'Execution history changed by child edits'; end if;
end $test$;
rollback;
