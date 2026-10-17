-- Existing records remain independent. Only explicit new links share a group.
alter table public.product_goal_templates add column template_group_id uuid not null default gen_random_uuid();
alter table public.product_objective_templates add column template_group_id uuid not null default gen_random_uuid();
create unique index product_goal_template_product_group on public.product_goal_templates(product_id,template_group_id) where variation_parent_id is null;
create unique index product_objective_template_product_group on public.product_objective_templates(product_id,template_group_id) where variation_parent_id is null;

-- One transaction for all selected products; table RLS and variation guards still apply.
create function public.save_result_template_links(p_section text,p_records jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare
  table_name text;
  entry jsonb;
  payload jsonb;
  detail jsonb;
  record_id uuid;
  target_id uuid;
  field_list text;
  value_list text;
  assignments text;
  exists_row boolean;
  affected integer;
  editable text[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  table_name := case p_section when 'goals' then 'product_goal_templates' when 'objectives' then 'product_objective_templates' end;
  if table_name is null or jsonb_typeof(p_records) is distinct from 'array' then raise exception 'Invalid result links'; end if;
  if jsonb_array_length(p_records) not between 1 and 100 then raise exception 'Select between 1 and 100 records'; end if;
  editable := public.result_variation_detail_fields(table_name);
  for entry in select value from jsonb_array_elements(p_records) loop
    record_id := (entry->>'id')::uuid;
    payload := entry->'body';
    if record_id is null or jsonb_typeof(payload) is distinct from 'object' or payload ?| array['id','created_at'] then raise exception 'Invalid record payload'; end if;
    if exists(select 1 from jsonb_object_keys(payload) key where not exists(
      select 1 from pg_catalog.pg_attribute a where a.attrelid=format('public.%I',table_name)::regclass and a.attname=key and a.attnum>0 and not a.attisdropped
    )) then raise exception 'Unknown result field'; end if;
    execute format('select exists(select 1 from public.%I where id=$1)',table_name) into exists_row using record_id;
    select string_agg(format('%I',key),',' order by key),string_agg(format('r.%I',key),',' order by key),string_agg(format('%1$I=r.%1$I',key),',' order by key)
      into field_list,value_list,assignments from jsonb_object_keys(payload) key;
    if assignments is null then raise exception 'Empty result payload'; end if;
    if exists_row then
      execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=$2',table_name,assignments) using payload,record_id;
    else
      execute format('insert into public.%1$I (id,%2$s) select $2,%3$s from jsonb_populate_record(null::public.%1$I,$1) r',table_name,field_list,value_list) using payload,record_id;
    end if;
    get diagnostics affected = row_count;
    if affected<>1 then raise exception 'Result not writable'; end if;
    if jsonb_typeof(coalesce(entry->'variant_details','[]')) is distinct from 'array' then raise exception 'Invalid variation details'; end if;
    for detail in select value from jsonb_array_elements(coalesce(entry->'variant_details','[]')) loop
      payload := detail->'changes';
      if jsonb_typeof(payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(payload) key where not key=any(editable)) then raise exception 'Invalid variation fields'; end if;
      execute format('select id from public.%I where variation_parent_id=$1 and variation_values=$2',table_name) into target_id using record_id,detail->'values';
      if target_id is null then raise exception 'Variation not found'; end if;
      select string_agg(format('%1$I=r.%1$I',key),',' order by key) into assignments from jsonb_object_keys(payload) key;
      if assignments is not null then
        execute format('update public.%1$I t set %2$s,updated_at=now() from jsonb_populate_record(null::public.%1$I,$1) r where t.id=$2',table_name,assignments) using payload,target_id;
        get diagnostics affected = row_count;
        if affected<>1 then raise exception 'Variation not writable'; end if;
      end if;
    end loop;
  end loop;
end $$;
revoke all on function public.save_result_template_links(text,jsonb) from public,anon;
grant execute on function public.save_result_template_links(text,jsonb) to authenticated;
notify pgrst,'reload schema';
