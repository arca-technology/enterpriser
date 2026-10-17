begin;
select set_config('request.jwt.claim.sub',(select auth_user_id::text from public.profiles where role='admin' and status='active' and auth_user_id is not null limit 1),true);
set local role authenticated;
do $$
declare
  section text;
  table_name text;
  product_a uuid;
  product_b uuid;
  first_id uuid;
  second_id uuid;
  family_id uuid;
  child_id uuid;
  group_id uuid;
  base jsonb;
  n integer;
  rejected boolean;
begin
  select id into product_a from public.products order by id limit 1;
  select id into product_b from public.products order by id limit 1 offset 1;
  if product_b is null then raise exception 'Two products are needed for this test'; end if;
  foreach section in array array['goals','objectives'] loop
    table_name := case section when 'goals' then 'product_goal_templates' else 'product_objective_templates' end;
    first_id:=gen_random_uuid(); second_id:=gen_random_uuid(); group_id:=gen_random_uuid();
    base:=jsonb_build_object('name','__result_links_smoke__','template_group_id',group_id,'category','ERP','module_name','Sistema');
    if section='goals' then base:=base||jsonb_build_object('metric','Contagem','target_value',1); end if;
    perform public.save_result_template_links(section,jsonb_build_array(
      jsonb_build_object('id',first_id,'body',base||jsonb_build_object('product_id',product_a)),
      jsonb_build_object('id',second_id,'body',base||jsonb_build_object('product_id',product_b))
    ));
    execute format('select count(*) from public.%I where template_group_id=$1',table_name) into n using group_id;
    if n<>2 then raise exception 'Multi-product insert failed'; end if;
    perform public.save_result_template_links(section,jsonb_build_array(
      jsonb_build_object('id',first_id,'body',jsonb_build_object('name','__renamed_result__')),
      jsonb_build_object('id',second_id,'body',jsonb_build_object('name','__renamed_result__'))
    ));
    execute format('select count(*) from public.%I where id=any($1) and name=$2',table_name) into n using array[first_id,second_id],'__renamed_result__';
    if n<>2 then raise exception 'Stable-ID update failed'; end if;
    family_id:=gen_random_uuid();
    rejected:=false;
    begin
      perform public.save_result_template_links(section,jsonb_build_array(
        jsonb_build_object('id',family_id,'body',base||jsonb_build_object('product_id',product_a,'template_group_id',gen_random_uuid())),
        jsonb_build_object('id',gen_random_uuid(),'body',jsonb_build_object('unknown_column',true))
      ));
    exception when others then rejected:=true;
    end;
    if not rejected then raise exception 'Invalid batch accepted'; end if;
    execute format('select count(*) from public.%I where id=$1',table_name) into n using family_id;
    if n<>0 then raise exception 'Partial batch was not rolled back'; end if;
    base:=base||jsonb_build_object('product_id',product_a,'template_group_id',gen_random_uuid(),'name','__variation_links__','variation_axes',jsonb_build_object('channel',jsonb_build_array('BLING','OLIST')));
    perform public.save_result_template_links(section,jsonb_build_array(jsonb_build_object('id',family_id,'body',base,
      'variant_details',jsonb_build_array(jsonb_build_object('values',jsonb_build_object('channel','BLING'),'changes',jsonb_build_object('comments','Detalhe independente','target_days',4))))));
    execute format('select count(*) from public.%I where variation_parent_id=$1',table_name) into n using family_id;
    if n<>2 then raise exception 'Variation family missing'; end if;
    execute format('select id from public.%I where variation_parent_id=$1 and channel=$2 and comments=$3 and target_days=4',table_name) into child_id using family_id,'BLING','Detalhe independente';
    if child_id is null then raise exception 'Independent child details missing'; end if;
    rejected:=false;
    begin
      perform public.save_result_template_links(section,jsonb_build_array(jsonb_build_object('id',child_id,'body',jsonb_build_object('name','Must not change'))));
    exception when others then rejected:=true;
    end;
    if not rejected then raise exception 'Inherited child structure was editable'; end if;
  end loop;
  if has_function_privilege('anon','public.save_result_template_links(text,jsonb)','EXECUTE') then raise exception 'Anonymous role has RPC access'; end if;
end $$;
rollback;
select 'PASS: authenticated multi-product insert/update, stable IDs, atomic rollback, variation details, locked structure and no anonymous access; all test writes rolled back.' as result;
