-- All fixtures and changes are rolled back.
begin;
do $test$
declare
  kind text;
  delivery uuid;
  product uuid;
  family uuid;
  children uuid[];
  original_ids uuid[];
  child jsonb;
  sibling jsonb;
  snapshot jsonb;
  count_rows integer;
  execution uuid;
begin
  select id,product_id into delivery,product from public.deliveries limit 1;
  if delivery is null then raise exception 'A delivery fixture is required'; end if;
  foreach kind in array array['product_goal_templates','product_objective_templates'] loop
    family := gen_random_uuid(); execution := gen_random_uuid();
    if kind='product_goal_templates' then
      insert into public.product_goal_templates(id,product_id,name,metric,target_value,category,variation_axes,notes,target_days)
        values(family,product,'Variation goal fixture','Pedidos',1,'ERP','{"channel":["BLING","OLIST"]}','Inherited',10);
    else
      insert into public.product_objective_templates(id,product_id,name,category,variation_axes,notes,target_days)
        values(family,product,'Variation objective fixture','ERP','{"channel":["BLING","OLIST"]}','Inherited',10);
    end if;
    execute format('select array_agg(id order by channel) from public.%I where variation_parent_id=$1',kind) into children using family;
    if cardinality(children)<>2 then raise exception 'Expected two variations for %',kind; end if;
    original_ids := children;
    execute format('update public.%I set notes=''Child notes'',target_days=5,default_assignee_ids=''{}'' where id=$1',kind) using children[1];
    execute format('update public.%I set name=name||'' renamed'',notes=''New inherited'',target_days=20,comments=''Parent comment'' where id=$1',kind) using family;
    execute format('select to_jsonb(t) from public.%I t where id=$1',kind) into child using children[1];
    execute format('select to_jsonb(t) from public.%I t where id=$1',kind) into sibling using children[2];
    if child->>'notes'<>'Child notes' or (child->>'target_days')::integer<>5 or child->>'comments'<>'Parent comment'
      or sibling->>'notes'<>'New inherited' or (sibling->>'target_days')::integer<>20 or child->>'name' not like '% renamed' then
      raise exception 'Selective inheritance failed for %',kind;
    end if;
    if not (child->'variation_override_fields') @> '["notes","target_days"]' then raise exception 'Overrides not tracked'; end if;
    if kind='product_goal_templates' then
      update public.product_goal_templates set metric='Faturamento',target_value=100 where id=children[1];
      update public.product_goal_templates set metric='Pedidos',target_value=2 where id=family;
      if not exists(select 1 from public.product_goal_templates where id=children[1] and metric='Faturamento' and target_value=100) then raise exception 'Goal targets overwritten'; end if;
      insert into public.delivery_goals(id,delivery_id,source_template_id,name,metric,target_value,current_value,status,due_date)
        values(execution,delivery,children[1],'Historical goal','Pedidos',1,1,'done','2026-10-01');
      select to_jsonb(t) into snapshot from public.delivery_goals t where id=execution;
    else
      update public.product_objective_templates set completion_criteria='Own criteria' where id=children[1];
      update public.product_objective_templates set completion_criteria='Parent criteria' where id=family;
      if not exists(select 1 from public.product_objective_templates where id=children[1] and completion_criteria='Own criteria') then raise exception 'Objective criteria overwritten'; end if;
      insert into public.delivery_objectives(id,delivery_id,source_template_id,name,status,due_date)
        values(execution,delivery,children[1],'Historical objective','done','2026-10-01');
      select to_jsonb(t) into snapshot from public.delivery_objectives t where id=execution;
    end if;
    execute format('update public.%I set variation_axes='' {"channel":["BLING","OLIST","OMIE"]}'' where id=$1',kind) using family;
    execute format('select count(*) from public.%I where variation_parent_id=$1',kind) into count_rows using family;
    if count_rows<>3 then raise exception 'Adding values failed'; end if;
    execute format('select array_agg(id order by channel) from public.%I where id=any($1)',kind) into children using original_ids;
    if children<>original_ids then raise exception 'Child IDs changed'; end if;
    if kind='product_goal_templates' then
      if snapshot is distinct from (select to_jsonb(t) from public.delivery_goals t where id=execution) then raise exception 'Goal execution changed'; end if;
    else
      if snapshot is distinct from (select to_jsonb(t) from public.delivery_objectives t where id=execution) then raise exception 'Objective execution changed'; end if;
    end if;
    begin
      execute format('update public.%I set channel=''WRONG'' where id=$1',kind) using children[1];
      raise exception 'UNEXPECTED_ALLOWED';
    exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
    begin
      execute format('update public.%I set variation_axes=''{"channel":["BLING"]}'' where id=$1',kind) using family;
      raise exception 'UNEXPECTED_ALLOWED';
    exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
    begin
      if kind='product_goal_templates' then
        insert into public.delivery_goals(delivery_id,source_template_id,name,metric) values(delivery,family,'Invalid parent','Pedidos');
      else
        insert into public.delivery_objectives(delivery_id,source_template_id,name) values(delivery,family,'Invalid parent');
      end if;
      raise exception 'UNEXPECTED_ALLOWED';
    exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
    begin
      execute format('delete from public.%I where id=$1',kind) using children[1];
      raise exception 'UNEXPECTED_ALLOWED';
    exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
    begin
      execute format('update public.%I set variation_parent_id=null,variation_values=''{}'' where id=$1',kind) using children[1];
      raise exception 'UNEXPECTED_ALLOWED';
    exception when others then if sqlerrm='UNEXPECTED_ALLOWED' then raise; end if; end;
  end loop;
end $test$;
rollback;
