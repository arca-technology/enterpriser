begin;

do $test$
declare
  delivery_id uuid := gen_random_uuid();
  template_id uuid := gen_random_uuid();
  activity_id uuid := gen_random_uuid();
  product_id uuid;
  configuration jsonb := '{"BLING":{"modules":["Financeiro"],"submodules":[{"module":"Financeiro","name":"Contas a pagar"}]},"INTER":{"emits_boleto":false}}';
begin
  select id into strict product_id from public.products limit 1;
  insert into public.deliveries (id,name,product_id,erp_platform,financial_accounts,setup_configuration,setup_product_types)
  values (delivery_id,'Detailed setup fixture',product_id,'BLING',array['INTER'],configuration,array['own_national']);
  insert into public.product_activity_templates (id,product_id,activity,required_setup,required_setup_configuration,required_product_types)
  values (template_id,product_id,'Detailed setup fixture',array['BLING','INTER'],configuration,array['own_national']);
  insert into public.activities (id,delivery_id,source_template_id,title,status,required_setup_configuration,required_product_types)
  values (activity_id,delivery_id,template_id,'Detailed setup fixture','canceled',configuration,array['own_national']);

  if (select setup_configuration #>> '{INTER,emits_boleto}' from public.deliveries where id=delivery_id) <> 'false' then
    raise exception 'Explicit no-boleto selection was lost';
  end if;
  begin
    update public.deliveries set setup_configuration='[]'::jsonb where id=delivery_id;
    raise exception 'Expected invalid setup object to be rejected';
  exception when check_violation then null;
  end;
  begin
    update public.product_activity_templates set required_product_types=array['invalid'] where id=template_id;
    raise exception 'Expected invalid product type to be rejected';
  exception when check_violation then null;
  end;
  update public.activities set status='doing' where id=activity_id;
  update public.activities set status='done' where id=activity_id;
  begin
    update public.activities set status='doing' where id=activity_id;
    raise exception 'An attended task must stay terminal';
  exception when check_violation then null;
  end;
end;
$test$;

rollback;
select 'Detailed Setup persistence, constraints, canceled reopening and attended lock passed; fixtures rolled back.' as result;
