create function public.result_variation_detail_fields(kind text)
returns text[] language sql immutable security invoker set search_path = '' as $$
  select array['comments','notes','target_days','default_owner_id','default_assignee_ids','assign_to_client','dependency_activity_template_ids']::text[]
    || case when kind = 'product_goal_templates' then array['metric','comparison','target_value','unit','dependency_goal_template_ids']
      else array['completion_criteria','dependency_objective_template_ids'] end;
$$;
revoke all on function public.result_variation_detail_fields(text) from public, anon;
grant execute on function public.result_variation_detail_fields(text) to authenticated;

alter table public.product_goal_templates
  add column variation_parent_id uuid references public.product_goal_templates(id) on delete restrict,
  add column variation_axes jsonb not null default '{}',
  add column variation_values jsonb not null default '{}',
  add column variation_override_fields text[] not null default '{}',
  add constraint goal_variations_shape check (
    jsonb_typeof(variation_axes)='object' and jsonb_typeof(variation_values)='object'
    and variation_parent_id is distinct from id
    and ((variation_parent_id is null and variation_values='{}' and cardinality(variation_override_fields)=0)
      or (variation_parent_id is not null and variation_axes='{}' and variation_values<>'{}'))
    and variation_override_fields <@ public.result_variation_detail_fields('product_goal_templates')
  );
alter table public.product_objective_templates
  add column variation_parent_id uuid references public.product_objective_templates(id) on delete restrict,
  add column variation_axes jsonb not null default '{}',
  add column variation_values jsonb not null default '{}',
  add column variation_override_fields text[] not null default '{}',
  add constraint objective_variations_shape check (
    jsonb_typeof(variation_axes)='object' and jsonb_typeof(variation_values)='object'
    and variation_parent_id is distinct from id
    and ((variation_parent_id is null and variation_values='{}' and cardinality(variation_override_fields)=0)
      or (variation_parent_id is not null and variation_axes='{}' and variation_values<>'{}'))
    and variation_override_fields <@ public.result_variation_detail_fields('product_objective_templates')
  );
create unique index goal_variation_combination_unique on public.product_goal_templates(variation_parent_id,variation_values) where variation_parent_id is not null;
create unique index objective_variation_combination_unique on public.product_objective_templates(variation_parent_id,variation_values) where variation_parent_id is not null;

create function public.guard_result_template_variation()
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
    if exists(select 1 from jsonb_object_keys(new.variation_axes) key where key not in ('category','channel')) then raise exception 'Somente Categoria e Canal podem variar neste cadastro.'; end if;
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
  elsif tg_op='UPDATE' and old.variation_axes<>'{}' then raise exception 'Preserve a família de variações.';
  end if;
  return new;
end $$;

create function public.sync_result_template_variations()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  combination jsonb;
  previous jsonb;
  candidate jsonb;
  personal_details jsonb;
  assignments text;
  ordinal integer := 0;
  duplicate boolean;
begin
  if tg_table_schema<>'public' or tg_table_name not in ('product_goal_templates','product_objective_templates') then raise exception 'Invalid variation table'; end if;
  if new.variation_axes='{}' then return new; end if;
  select string_agg(format('%1$I=r.%1$I',field),',') into assignments from unnest(array['name','category','channel','updated_at','variation_override_fields']||public.result_variation_detail_fields(tg_table_name)) field;
  for combination in select public.task_variation_combinations(new.variation_axes) loop
    execute format('select to_jsonb(t) from public.%I t where variation_parent_id=$1 and variation_values=$2 for update',tg_table_name)
      into previous using new.id,combination;
    candidate := to_jsonb(new)||combination||jsonb_build_object('id',coalesce(previous->>'id',gen_random_uuid()::text),
      'variation_parent_id',new.id,'variation_axes','{}'::jsonb,'variation_values',combination,'variation_override_fields',coalesce(previous->'variation_override_fields','[]'::jsonb),
      'created_at',coalesce(previous->'created_at',to_jsonb(now())),'updated_at',now(),
      'sort_order',coalesce((previous->>'sort_order')::integer,new.sort_order+ordinal+1));
    execute format('select exists(select 1 from public.%I where product_id=$1 and id<>$2 and variation_parent_id is distinct from $3 and variation_axes=''{}'' and lower(btrim(name))=lower(btrim($4)) and lower(btrim(coalesce(category,'''')))=lower(btrim($5)) and lower(btrim(coalesce(channel,'''')))=lower(btrim($6)))',tg_table_name)
      into duplicate using new.product_id,(candidate->>'id')::uuid,new.id,candidate->>'name',coalesce(candidate->>'category',''),coalesce(candidate->>'channel','');
    if duplicate then raise exception 'Já existe um cadastro com a mesma categoria, canal e nome neste produto.'; end if;
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
create trigger guard_goal_template_variation before insert or update or delete on public.product_goal_templates for each row execute function public.guard_result_template_variation();
create trigger guard_objective_template_variation before insert or update or delete on public.product_objective_templates for each row execute function public.guard_result_template_variation();
create trigger sync_goal_template_variations after insert or update on public.product_goal_templates for each row execute function public.sync_result_template_variations();
create trigger sync_objective_template_variations after insert or update on public.product_objective_templates for each row execute function public.sync_result_template_variations();

create function public.guard_result_variation_execution()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  template_table text;
  parent boolean;
begin
  if tg_table_schema<>'public' or tg_table_name not in ('delivery_goals','delivery_objectives','product_activity_templates') then raise exception 'Invalid execution table'; end if;
  template_table := case tg_table_name when 'delivery_goals' then 'product_goal_templates' else 'product_objective_templates' end;
  execute format('select exists(select 1 from public.%I where id=$1 and variation_axes<>''{}'')',template_table)
    into parent using case when tg_table_name='product_activity_templates' then (to_jsonb(new)->>'objective_template_id')::uuid else (to_jsonb(new)->>'source_template_id')::uuid end;
  if parent then raise exception 'Somente as variações filhas podem entrar na execução ou nos vínculos.'; end if;
  return new;
end $$;
create trigger guard_goal_variation_execution before insert or update of source_template_id on public.delivery_goals for each row execute function public.guard_result_variation_execution();
create trigger guard_objective_variation_execution before insert or update of source_template_id on public.delivery_objectives for each row execute function public.guard_result_variation_execution();
create trigger guard_task_objective_variation before insert or update of objective_template_id on public.product_activity_templates for each row execute function public.guard_result_variation_execution();
revoke all on function public.guard_result_template_variation() from public, anon;
revoke all on function public.sync_result_template_variations() from public, anon;
revoke all on function public.guard_result_variation_execution() from public, anon;
notify pgrst,'reload schema';
