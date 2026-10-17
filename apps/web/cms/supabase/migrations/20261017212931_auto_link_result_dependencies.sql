-- Resolve missing prerequisite templates inside the same transaction as the result.
create function public.template_product_link_identity(p_kind text,p_row jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_array(
    (select jsonb_object_agg(key,lower(btrim(coalesce(p_row->>key,'')))) from unnest(
      case when p_kind='activities' then array['group_name','subgroup_name','sector','subsector','module_name','submodule_name','category','channel','activity_type','activity','recurrence','requires_retroactive']
      else array['category','channel','module_name','submodule_name','name'] end
    ) key),coalesce(p_row->'variation_axes','{}'::jsonb));
$$;

create function public.ensure_template_product_link(p_kind text,p_source uuid,p_product uuid,p_path text[] default '{}')
returns uuid language plpgsql security invoker set search_path='' as $$
declare
  relation_name text;
  source_row jsonb;
  payload jsonb;
  child jsonb;
  details jsonb;
  candidate_ids uuid[];
  target_id uuid;
  target_parent uuid;
  objective_id uuid;
  group_id uuid;
  token text;
  child_token text;
  editable text[];
  assignments text;
  ordinal integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  relation_name:=case p_kind when 'activities' then 'product_activity_templates' when 'goals' then 'product_goal_templates' when 'objectives' then 'product_objective_templates' end;
  if relation_name is null then raise exception 'Invalid template kind'; end if;
  execute format('select to_jsonb(t) from public.%I t where id=$1',relation_name) into source_row using p_source;
  if source_row is null then raise exception 'Uma dependência não foi encontrada ou não está acessível.'; end if;
  if (source_row->>'product_id')::uuid=p_product then return p_source; end if;
  token:=p_kind||':'||p_source::text||':'||p_product::text;
  if source_row->>'variation_parent_id' is not null then
    target_parent:=public.ensure_template_product_link(p_kind,(source_row->>'variation_parent_id')::uuid,p_product,p_path);
    execute format('select id from public.%I where variation_parent_id=$1 and variation_values=$2',relation_name) into target_id using target_parent,source_row->'variation_values';
    if target_id is null then raise exception 'A variação necessária não foi encontrada no produto.'; end if;
    return target_id;
  end if;
  group_id:=coalesce((source_row->>'template_group_id')::uuid,p_source);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_kind||':'||group_id::text||':'||p_product::text,0));
  execute format('select array_agg(id) from public.%I where product_id=$1 and variation_parent_id is null and template_group_id=$2',relation_name) into candidate_ids using p_product,group_id;
  if coalesce(cardinality(candidate_ids),0)>1 then raise exception 'Há cadastros ambíguos no produto. Revise os vínculos.'; end if;
  if cardinality(candidate_ids)=1 then return candidate_ids[1]; end if;
  if token=any(p_path) or cardinality(p_path)>=64 then raise exception 'As dependências contêm um ciclo ou uma hierarquia muito extensa.'; end if;
  if p_kind='activities' and source_row->>'parent_template_id' is not null then
    target_parent:=public.ensure_template_product_link('activities',(source_row->>'parent_template_id')::uuid,p_product,array_append(p_path,token));
    -- Linking the parent may already have materialized this subtask.
    execute format('select id from public.%I where product_id=$1 and template_group_id=$2 and parent_template_id=$3 limit 1',relation_name) into target_id using p_product,group_id,target_parent;
    if target_id is not null then return target_id; end if;
  end if;
  execute format('select array_agg(t.id) from public.%I t where t.product_id=$1 and t.variation_parent_id is null and public.template_product_link_identity($2,to_jsonb(t))=public.template_product_link_identity($2,$3) and ($2<>''activities'' or (to_jsonb(t)->>''parent_template_id'')::uuid is not distinct from $4)',relation_name)
    into candidate_ids using p_product,p_kind,source_row,target_parent;
  if coalesce(cardinality(candidate_ids),0)>1 then raise exception 'Há mais de uma dependência correspondente no produto. Revise os cadastros.'; end if;
  if cardinality(candidate_ids)=1 then return candidate_ids[1]; end if;
  target_id:=gen_random_uuid();
  execute format('select coalesce(max(sort_order),-1)+1 from public.%I where product_id=$1',relation_name) into ordinal using p_product;
  payload:=source_row||jsonb_build_object('id',target_id,'product_id',p_product,'template_group_id',group_id,'created_at',now(),'updated_at',now(),'sort_order',ordinal,'variation_override_fields','[]'::jsonb);
  payload:=public.remap_template_product_dependencies(payload,p_product,array_append(p_path,token));
  if p_kind='activities' then
    objective_id:=null;
    if source_row->>'objective_template_id' is not null then
      select t.id into objective_id from public.product_objective_templates t join public.product_objective_templates s on s.id=(source_row->>'objective_template_id')::uuid
      where t.product_id=p_product and t.variation_axes='{}' and (t.template_group_id=s.template_group_id or public.template_product_link_identity('objectives',to_jsonb(t))=public.template_product_link_identity('objectives',to_jsonb(s))) limit 1;
    end if;
    payload:=payload||jsonb_build_object('parent_template_id',target_parent,'objective_template_id',objective_id);
  end if;
  execute format('insert into public.%1$I select (jsonb_populate_record(null::public.%1$I,$1)).*',relation_name) using payload;
  editable:=case p_kind when 'activities' then public.task_variation_detail_fields() else public.result_variation_detail_fields(relation_name) end;
  for child in execute format('select to_jsonb(t) from public.%I t where variation_parent_id=$1',relation_name) using p_source loop
    select coalesce(jsonb_object_agg(key,value),'{}') into details from jsonb_each(child)
      where key=any(editable) and key in (select jsonb_array_elements_text(child->'variation_override_fields'));
    if details<>'{}' then
      details:=public.remap_template_product_dependencies(details,p_product,array_append(p_path,token));
      select string_agg(format('%1$I=r.%1$I',key),',') into assignments from jsonb_object_keys(details) key;
      execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.variation_parent_id=$2 and t.variation_values=$3',relation_name,assignments) using details,target_id,child->'variation_values';
    end if;
  end loop;
  if p_kind='activities' then
    for child in select to_jsonb(t) from public.product_activity_templates t where parent_template_id=p_source loop
      child_token:='activities:'||(child->>'id')||':'||p_product::text;
      if not child_token=any(p_path) then perform public.ensure_template_product_link('activities',(child->>'id')::uuid,p_product,array_append(p_path,token)); end if;
    end loop;
  end if;
  return target_id;
end $$;

create function public.remap_template_product_dependencies(p_body jsonb,p_product uuid,p_path text[] default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  pair record;
  ids jsonb;
  result jsonb:=p_body;
  objective_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  for pair in select * from (values ('dependency_template_ids','activities'),('dependency_activity_template_ids','activities'),('dependency_goal_template_ids','goals'),('dependency_objective_template_ids','objectives')) as x(field,kind) loop
    if result ? pair.field then
      select coalesce(jsonb_agg(public.ensure_template_product_link(pair.kind,value::uuid,p_product,p_path) order by ordinal),'[]'::jsonb) into ids from jsonb_array_elements_text(result->pair.field) with ordinality as x(value,ordinal);
      result:=jsonb_set(result,array[pair.field],ids);
    end if;
  end loop;
  if result ? 'depends_on_template_id' then
    result:=jsonb_set(result,array['depends_on_template_id'],coalesce(result->'dependency_template_ids'->0,
      case when result->>'depends_on_template_id' is not null then to_jsonb(public.ensure_template_product_link('activities',(result->>'depends_on_template_id')::uuid,p_product,p_path)) else 'null'::jsonb end));
  end if;
  if result ? 'objective_template_id' then
    select t.id into objective_id from public.product_objective_templates t join public.product_objective_templates s on s.id=(result->>'objective_template_id')::uuid
      where t.product_id=p_product and t.variation_axes='{}' and (t.template_group_id=s.template_group_id or public.template_product_link_identity('objectives',to_jsonb(t))=public.template_product_link_identity('objectives',to_jsonb(s))) limit 1;
    result:=jsonb_set(result,array['objective_template_id'],coalesce(to_jsonb(objective_id),'null'::jsonb));
  end if;
  return result;
end $$;

create or replace function public.save_result_template_links(p_section text,p_records jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare
  table_name text;
  entry jsonb;
  payload jsonb;
  detail jsonb;
  record_id uuid;
  target_id uuid;
  product_id uuid;
  field_list text;
  value_list text;
  assignments text;
  exists_row boolean;
  affected integer;
  editable text[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  table_name:=case p_section when 'goals' then 'product_goal_templates' when 'objectives' then 'product_objective_templates' end;
  if table_name is null or jsonb_typeof(p_records) is distinct from 'array' then raise exception 'Invalid result links'; end if;
  if jsonb_array_length(p_records) not between 1 and 100 then raise exception 'Select between 1 and 100 records'; end if;
  editable:=public.result_variation_detail_fields(table_name);
  for entry in select value from jsonb_array_elements(p_records) loop
    record_id:=(entry->>'id')::uuid; payload:=entry->'body';
    if record_id is null or jsonb_typeof(payload) is distinct from 'object' or payload ?| array['id','created_at'] then raise exception 'Invalid record payload'; end if;
    if exists(select 1 from jsonb_object_keys(payload) key where not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=format('public.%I',table_name)::regclass and a.attname=key and a.attnum>0 and not a.attisdropped)) then raise exception 'Unknown result field'; end if;
    execute format('select exists(select 1 from public.%I where id=$1)',table_name) into exists_row using record_id;
    product_id:=(payload->>'product_id')::uuid;
    if product_id is null then execute format('select t.product_id from public.%I t where id=$1',table_name) into product_id using record_id; end if;
    payload:=public.remap_template_product_dependencies(payload,product_id);
    select string_agg(format('%I',key),',' order by key),string_agg(format('r.%I',key),',' order by key),string_agg(format('%1$I=r.%1$I',key),',' order by key)
      into field_list,value_list,assignments from jsonb_object_keys(payload) key;
    if assignments is null then raise exception 'Empty result payload'; end if;
    if exists_row then
      execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=$2',table_name,assignments) using payload,record_id;
    else
      execute format('insert into public.%1$I (id,%2$s) select $2,%3$s from jsonb_populate_record(null::public.%1$I,$1) r',table_name,field_list,value_list) using payload,record_id;
    end if;
    get diagnostics affected=row_count;
    if affected<>1 then raise exception 'Result not writable'; end if;
    if jsonb_typeof(coalesce(entry->'variant_details','[]')) is distinct from 'array' then raise exception 'Invalid variation details'; end if;
    for detail in select value from jsonb_array_elements(coalesce(entry->'variant_details','[]')) loop
      payload:=detail->'changes';
      if jsonb_typeof(payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(payload) key where not key=any(editable)) then raise exception 'Invalid variation fields'; end if;
      payload:=public.remap_template_product_dependencies(payload,product_id);
      execute format('select id from public.%I where variation_parent_id=$1 and variation_values=$2',table_name) into target_id using record_id,detail->'values';
      if target_id is null then raise exception 'Variation not found'; end if;
      select string_agg(format('%1$I=r.%1$I',key),',' order by key) into assignments from jsonb_object_keys(payload) key;
      if assignments is not null then
        execute format('update public.%1$I t set %2$s,updated_at=now() from jsonb_populate_record(null::public.%1$I,$1) r where t.id=$2',table_name,assignments) using payload,target_id;
        get diagnostics affected=row_count;
        if affected<>1 then raise exception 'Variation not writable'; end if;
      end if;
    end loop;
  end loop;
end $$;
revoke all on function public.template_product_link_identity(text,jsonb),public.ensure_template_product_link(text,uuid,uuid,text[]),public.remap_template_product_dependencies(jsonb,uuid,text[]) from public,anon;
grant execute on function public.template_product_link_identity(text,jsonb),public.ensure_template_product_link(text,uuid,uuid,text[]),public.remap_template_product_dependencies(jsonb,uuid,text[]) to authenticated;
notify pgrst,'reload schema';
