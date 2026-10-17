-- Add classification fields without rewriting historical records or execution state.
alter table public.product_goal_templates add column module_name text not null default '', add column submodule_name text not null default '';
alter table public.product_objective_templates add column module_name text not null default '', add column submodule_name text not null default '';
alter table public.delivery_goals add column module_name text not null default '', add column submodule_name text not null default '';
alter table public.delivery_objectives add column module_name text not null default '', add column submodule_name text not null default '';

create or replace function public.guard_result_template_variation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  editable text[] := public.result_variation_detail_fields(tg_table_name);
  dependency_column text;
  execution_table text;
  family jsonb;
  referenced boolean;
  new_fields text[];
begin
  if tg_table_schema <> 'public' or tg_table_name not in ('product_goal_templates','product_objective_templates') then raise exception 'Invalid variation table'; end if;
  dependency_column := case tg_table_name when 'product_goal_templates' then 'dependency_goal_template_ids' else 'dependency_objective_template_ids' end;
  execution_table := case tg_table_name when 'product_goal_templates' then 'delivery_goals' else 'delivery_objectives' end;
  if tg_op='DELETE' then
    if old.variation_parent_id is not null or old.variation_axes<>'{}' then raise exception 'Preserve a família de variações e seus vínculos.'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.variation_parent_id is not null and new.variation_parent_id is distinct from old.variation_parent_id then
    raise exception 'Não é permitido trocar ou remover o pai da variação.';
  end if;
  execute format('select exists(select 1 from public.%I where id=any($1) and (variation_axes<>''{}'' or id=$2))',tg_table_name)
    into referenced using array(select jsonb_array_elements_text(to_jsonb(new)->dependency_column)::uuid),new.id;
  if referenced then raise exception 'Escolha uma filha válida nas dependências, não um pai de variações.'; end if;
  if new.variation_parent_id is not null then
    execute format('select to_jsonb(t) from public.%I t where id=$1',tg_table_name) into family using new.variation_parent_id;
    if family is null or family->>'product_id'<>new.product_id::text or family->'variation_axes'='{}' then raise exception 'Pai de variação inválido.'; end if;
    if pg_trigger_depth()=1 then
      if tg_op<>'UPDATE' or old.variation_parent_id is distinct from new.variation_parent_id then raise exception 'Crie as variações pelo cadastro pai.'; end if;
      if (to_jsonb(new)-editable-array['updated_at','variation_override_fields']) is distinct from (to_jsonb(old)-editable-array['updated_at','variation_override_fields'])
        or new.variation_override_fields is distinct from old.variation_override_fields then raise exception 'Nome, estrutura e vínculos são definidos pelo cadastro pai.'; end if;
      select coalesce(array_agg(distinct field order by field),'{}') into new_fields from (
        select unnest(old.variation_override_fields) as field union all
        select key from jsonb_each(to_jsonb(new)) where key=any(editable) and value is distinct from to_jsonb(old)->key
      ) changes;
      new.variation_override_fields := new_fields;
    end if;
    return new;
  end if;
  if new.variation_axes<>'{}' then
    if exists(select 1 from jsonb_object_keys(new.variation_axes) key where key not in ('category','channel','module','submodule')) then raise exception 'Somente Categoria, Canal, Módulo e Submódulo podem variar neste cadastro.'; end if;
    perform public.task_variation_combinations(new.variation_axes);
    execute format('select exists(select 1 from public.%I where source_template_id=$1) or exists(select 1 from public.%I where $1=any(%I))',execution_table,tg_table_name,dependency_column)
      into referenced using new.id;
    if referenced or (tg_table_name='product_objective_templates' and exists(select 1 from public.product_activity_templates where objective_template_id=new.id)) then
      raise exception 'Use um cadastro sem execuções ou dependências para criar variações. Nenhum registro foi convertido.';
    end if;
    if tg_op='UPDATE' and old.variation_axes<>'{}' and (
      not new.variation_axes @> old.variation_axes or
      (select array_agg(key order by key) from jsonb_object_keys(new.variation_axes) key) is distinct from
      (select array_agg(key order by key) from jsonb_object_keys(old.variation_axes) key)
    ) then raise exception 'Preserve os campos e valores já usados. Você pode acrescentar variações.'; end if;
    if new.variation_axes ? 'category' then new.category := ''; end if;
    if new.variation_axes ? 'channel' then new.channel := ''; end if;
    if new.variation_axes ? 'module' then new.module_name := ''; end if;
    if new.variation_axes ? 'submodule' then new.submodule_name := ''; end if;
  elsif tg_op='UPDATE' and old.variation_axes<>'{}' then raise exception 'Preserve a família de variações.';
  end if;
  return new;
end $$;

create or replace function public.sync_result_template_variations()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  combination jsonb;
  columns_combination jsonb;
  previous jsonb;
  candidate jsonb;
  personal_details jsonb;
  assignments text;
  ordinal integer := 0;
  duplicate boolean;
begin
  if tg_table_schema<>'public' or tg_table_name not in ('product_goal_templates','product_objective_templates') then raise exception 'Invalid variation table'; end if;
  if new.variation_axes='{}' then return new; end if;
  select string_agg(format('%1$I=r.%1$I',field),',') into assignments from unnest(array['name','category','channel','module_name','submodule_name','updated_at','variation_override_fields']||public.result_variation_detail_fields(tg_table_name)) field;
  for combination in select public.task_variation_combinations(new.variation_axes) loop
    select jsonb_object_agg(case key when 'module' then 'module_name' when 'submodule' then 'submodule_name' else key end,value) into columns_combination from jsonb_each(combination);
    execute format('select to_jsonb(t) from public.%I t where variation_parent_id=$1 and variation_values=$2 for update',tg_table_name)
      into previous using new.id,combination;
    candidate := to_jsonb(new)||columns_combination||jsonb_build_object('id',coalesce(previous->>'id',gen_random_uuid()::text),
      'variation_parent_id',new.id,'variation_axes','{}'::jsonb,'variation_values',combination,'variation_override_fields',coalesce(previous->'variation_override_fields','[]'::jsonb),
      'created_at',coalesce(previous->'created_at',to_jsonb(now())),'updated_at',now(),
      'sort_order',coalesce((previous->>'sort_order')::integer,new.sort_order+ordinal+1));
    execute format('select exists(select 1 from public.%I where product_id=$1 and id<>$2 and variation_parent_id is distinct from $3 and variation_axes=''{}'' and lower(btrim(name))=lower(btrim($4)) and lower(btrim(coalesce(category,'''')))=lower(btrim($5)) and lower(btrim(coalesce(channel,'''')))=lower(btrim($6)) and lower(btrim(module_name))=lower(btrim($7)) and lower(btrim(submodule_name))=lower(btrim($8)))',tg_table_name)
      into duplicate using new.product_id,(candidate->>'id')::uuid,new.id,candidate->>'name',coalesce(candidate->>'category',''),coalesce(candidate->>'channel',''),candidate->>'module_name',candidate->>'submodule_name';
    if duplicate then raise exception 'Já existe um cadastro com a mesma categoria, canal, módulo, submódulo e nome neste produto.'; end if;
    if previous is null then
      execute format('insert into public.%1$I select (jsonb_populate_record(null::public.%1$I,$1)).*',tg_table_name) using candidate;
    else
      select coalesce(jsonb_object_agg(key,value),'{}') into personal_details from jsonb_each(previous)
        where key in (select jsonb_array_elements_text(previous->'variation_override_fields'));
      candidate := candidate||personal_details;
      execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=$2',tg_table_name,assignments)
        using candidate,(previous->>'id')::uuid;
    end if;
    ordinal := ordinal+1;
  end loop;
  return new;
end $$;
notify pgrst,'reload schema';
