alter table public.product_activity_templates
  add column variation_axes jsonb not null default '{}'::jsonb,
  add column variation_parent_id uuid references public.product_activity_templates(id) on delete restrict,
  add column variation_values jsonb not null default '{}'::jsonb,
  add constraint task_variations_shape check (
    jsonb_typeof(variation_axes) = 'object' and jsonb_typeof(variation_values) = 'object'
    and (variation_parent_id is null or (variation_axes = '{}'::jsonb and variation_values <> '{}'::jsonb))
    and (variation_parent_id is not null or variation_values = '{}'::jsonb)
    and variation_parent_id is distinct from id
  );
create unique index task_variation_combination_unique
  on public.product_activity_templates (variation_parent_id, variation_values)
  where variation_parent_id is not null;
create unique index task_variation_family_product_unique
  on public.product_activity_templates (product_id, template_group_id)
  where variation_axes <> '{}'::jsonb;

create function public.task_variation_combinations(axes jsonb)
returns setof jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  axis record;
  combinations jsonb := '[{}]'::jsonb;
  values_count integer;
begin
  if jsonb_typeof(axes) is distinct from 'object' then raise exception 'Variações inválidas.'; end if;
  for axis in select key, value from jsonb_each(axes) order by key loop
    if axis.key not in ('category','channel','module','submodule','type') or jsonb_typeof(axis.value) <> 'array' then
      raise exception 'Campo de variação inválido.';
    end if;
    values_count := jsonb_array_length(axis.value);
    if values_count = 0 or values_count > 50 or exists (
      select 1 from jsonb_array_elements(axis.value) v where jsonb_typeof(v) <> 'string' or btrim(v #>> '{}') = '' or length(v #>> '{}') > 200
    ) then raise exception 'Selecione de 1 a 50 valores por campo de variação.'; end if;
    if (select count(distinct lower(btrim(v))) from jsonb_array_elements_text(axis.value) v) <> values_count then
      raise exception 'Valores de variação repetidos.';
    end if;
    if jsonb_array_length(combinations) * values_count > 200 then raise exception 'O limite é 200 combinações por tarefa.'; end if;
    select jsonb_agg(c || jsonb_build_object(axis.key, btrim(v #>> '{}')))
      into combinations from jsonb_array_elements(combinations) c cross join jsonb_array_elements(axis.value) v;
  end loop;
  return query select value from jsonb_array_elements(combinations);
end $$;

create function public.guard_task_template_variation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  family public.product_activity_templates;
  axis record;
begin
  if tg_op = 'DELETE' then
    if old.variation_parent_id is not null and pg_trigger_depth() = 1 then
      raise exception 'A variação é gerenciada pela tarefa pai. Nenhum histórico foi excluído.';
    end if;
    return old;
  end if;
  if new.variation_parent_id is not null then
    if pg_trigger_depth() = 1 then raise exception 'Edite a tarefa pai para alterar suas variações.'; end if;
    select * into family from public.product_activity_templates where id = new.variation_parent_id;
    if family.id is null or family.product_id <> new.product_id or family.variation_axes = '{}'::jsonb then
      raise exception 'Pai de variação inválido.';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.variation_parent_id is not null then raise exception 'Não é permitido desvincular uma variação de sua tarefa pai.'; end if;
  if exists (select 1 from public.product_activity_templates t where
    (t.id = any(new.dependency_template_ids) or t.id = new.depends_on_template_id)
    and (t.variation_axes <> '{}'::jsonb or t.variation_parent_id = new.id)
  ) then raise exception 'Escolha uma variação filha válida nas dependências.'; end if;
  if new.variation_axes <> '{}'::jsonb then
    perform public.task_variation_combinations(new.variation_axes);
    if new.parent_template_id is not null or exists (select 1 from public.product_activity_templates where parent_template_id = new.id)
      or exists (select 1 from public.activities where source_template_id = new.id) then
      raise exception 'Use uma tarefa principal sem execuções ou subtarefas para criar variações.';
    end if;
    if exists (select 1 from public.product_activity_templates where new.id = any(dependency_template_ids) or depends_on_template_id = new.id)
      or exists (select 1 from public.product_goal_templates where new.id = any(dependency_activity_template_ids))
      or exists (select 1 from public.product_objective_templates where new.id = any(dependency_activity_template_ids)) then
      raise exception 'Selecione as filhas nas dependências, não o pai de variações.';
    end if;
    if tg_op = 'UPDATE' and old.variation_axes <> '{}'::jsonb and (
      not new.variation_axes @> old.variation_axes or
      (select array_agg(key order by key) from jsonb_object_keys(new.variation_axes) key)
        is distinct from (select array_agg(key order by key) from jsonb_object_keys(old.variation_axes) key)
    ) then raise exception 'Preserve os campos e valores já usados nas variações. Você pode acrescentar valores sem perder histórico.'; end if;
    for axis in select key from jsonb_each(new.variation_axes) loop
      new := jsonb_populate_record(new, jsonb_build_object(case axis.key when 'module' then 'module_name' when 'submodule' then 'submodule_name' when 'type' then 'activity_type' else axis.key end, ''));
    end loop;
  elsif tg_op = 'UPDATE' and old.variation_axes <> '{}'::jsonb then
    raise exception 'Uma tarefa com variações não pode virar simples enquanto possuir filhas.';
  end if;
  return new;
end $$;

create function public.sync_task_template_variations()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  combination jsonb;
  overrides jsonb;
  candidate public.product_activity_templates;
  previous public.product_activity_templates;
  ordinal integer := 0;
begin
  if new.variation_axes = '{}'::jsonb then return new; end if;
  for combination in select public.task_variation_combinations(new.variation_axes) loop
    select jsonb_object_agg(case key when 'module' then 'module_name' when 'submodule' then 'submodule_name' when 'type' then 'activity_type' else key end, value)
      into overrides from jsonb_each(combination);
    select * into previous from public.product_activity_templates where variation_parent_id = new.id and variation_values = combination for update;
    candidate := jsonb_populate_record(null::public.product_activity_templates,
      to_jsonb(new) || overrides || jsonb_build_object(
        'id', coalesce(previous.id, gen_random_uuid()), 'variation_axes', '{}'::jsonb,
        'variation_parent_id', new.id, 'variation_values', combination,
        'template_group_id', md5(new.template_group_id::text || combination::text)::uuid,
        'created_at', coalesce(previous.created_at, now()), 'updated_at', now(),
        'sort_order', coalesce(previous.sort_order, new.sort_order + ordinal + 1)
      ));
    if combination ? 'channel' and exists (
      select 1 from unnest(new.required_setup) required, jsonb_array_elements_text(new.variation_axes->'channel') axis
      where lower(btrim(required)) = lower(btrim(axis))
    ) then
      candidate.required_setup := array(select distinct required from (
        select required from unnest(new.required_setup) required where not exists (
          select 1 from jsonb_array_elements_text(new.variation_axes->'channel') axis where lower(btrim(required)) = lower(btrim(axis))
        ) union all select combination->>'channel'
      ) requirements order by required);
      select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into candidate.required_setup_configuration
        from jsonb_each(new.required_setup_configuration) where lower(key) = lower(combination->>'channel') or not exists (
          select 1 from jsonb_array_elements_text(new.variation_axes->'channel') axis where lower(key) = lower(axis)
        );
    end if;
    if previous.id is null then
      insert into public.product_activity_templates select candidate.*;
    else
      update public.product_activity_templates set
        group_name = candidate.group_name, subgroup_name = candidate.subgroup_name, sector = candidate.sector, subsector = candidate.subsector,
        category = candidate.category, channel = candidate.channel, module_name = candidate.module_name, submodule_name = candidate.submodule_name,
        activity_type = candidate.activity_type, activity = candidate.activity, information = candidate.information,
        recurrence = candidate.recurrence, deadline_window = candidate.deadline_window, checklist = candidate.checklist, priority = candidate.priority,
        default_owner_id = candidate.default_owner_id, default_assignee_ids = candidate.default_assignee_ids,
        default_assignee_job_titles = candidate.default_assignee_job_titles, assign_to_client = candidate.assign_to_client,
        target_days = candidate.target_days, start_after_days = candidate.start_after_days, consider_business_days = candidate.consider_business_days,
        objective_template_id = candidate.objective_template_id, dependency_template_ids = candidate.dependency_template_ids,
        depends_on_template_id = candidate.depends_on_template_id, document_ids = candidate.document_ids, custom_table_ids = candidate.custom_table_ids,
        required_setup = candidate.required_setup, required_setup_configuration = candidate.required_setup_configuration,
        required_product_types = candidate.required_product_types, requires_retroactive = candidate.requires_retroactive,
        template_group_id = candidate.template_group_id, updated_at = candidate.updated_at
        where id = previous.id;
    end if;
    ordinal := ordinal + 1;
  end loop;
  return new;
end $$;

create trigger guard_task_template_variation before insert or update or delete on public.product_activity_templates
  for each row execute function public.guard_task_template_variation();
create trigger sync_task_template_variations after insert or update on public.product_activity_templates
  for each row execute function public.sync_task_template_variations();

create function public.guard_variation_parent_execution()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.source_template_id is not null and exists (
    select 1 from public.product_activity_templates where id = new.source_template_id and variation_axes <> '{}'::jsonb
  ) then raise exception 'Somente as variações filhas podem gerar tarefas na execução.'; end if;
  return new;
end $$;
create trigger guard_variation_parent_execution before insert or update of source_template_id on public.activities
  for each row execute function public.guard_variation_parent_execution();

revoke all on function public.task_variation_combinations(jsonb) from public, anon;
grant execute on function public.task_variation_combinations(jsonb) to authenticated;
revoke all on function public.guard_task_template_variation() from public, anon;
revoke all on function public.sync_task_template_variations() from public, anon;
revoke all on function public.guard_variation_parent_execution() from public, anon;
notify pgrst, 'reload schema';
