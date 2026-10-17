create function public.task_variation_detail_fields()
returns text[] language sql immutable security invoker set search_path = '' as $$
  select array['information','recurrence','deadline_window','priority','target_days','start_after_days',
    'consider_business_days','checklist','default_owner_id','default_assignee_ids','default_assignee_job_titles','assign_to_client',
    'objective_template_id','dependency_template_ids','depends_on_template_id','document_ids','custom_table_ids','required_setup',
    'required_setup_configuration','required_product_types','requires_retroactive']::text[];
$$;
revoke all on function public.task_variation_detail_fields() from public, anon;
grant execute on function public.task_variation_detail_fields() to authenticated;

alter table public.product_activity_templates
  add column variation_override_fields text[] not null default '{}',
  add constraint task_variation_overrides_valid check (
    variation_override_fields <@ public.task_variation_detail_fields()
    and (variation_parent_id is not null or cardinality(variation_override_fields) = 0)
  );

create or replace function public.guard_task_template_variation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  family public.product_activity_templates;
  axis record;
  editable text[] := public.task_variation_detail_fields();
begin
  if tg_op = 'DELETE' then
    if old.variation_parent_id is not null and pg_trigger_depth() = 1 then
      raise exception 'A variação é gerenciada pela tarefa pai. Nenhum histórico foi excluído.';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.variation_parent_id is not null and new.variation_parent_id is distinct from old.variation_parent_id then
    raise exception 'Não é permitido desvincular ou trocar o pai de uma variação.';
  end if;
  if exists (select 1 from public.product_activity_templates t where
    (t.id = any(new.dependency_template_ids) or t.id = new.depends_on_template_id)
    and (t.variation_axes <> '{}'::jsonb or t.variation_parent_id = new.id or t.id = new.id)
  ) then raise exception 'Escolha uma variação filha válida nas dependências.'; end if;
  if new.variation_parent_id is not null then
    select * into family from public.product_activity_templates where id = new.variation_parent_id;
    if family.id is null or family.product_id <> new.product_id or family.variation_axes = '{}'::jsonb then
      raise exception 'Pai de variação inválido.';
    end if;
    if pg_trigger_depth() = 1 then
      if tg_op <> 'UPDATE' or old.variation_parent_id is distinct from new.variation_parent_id then
        raise exception 'Crie as variações pela tarefa pai.';
      end if;
      if (to_jsonb(new) - editable - array['updated_at','variation_override_fields'])
        is distinct from (to_jsonb(old) - editable - array['updated_at','variation_override_fields'])
        or new.variation_override_fields is distinct from old.variation_override_fields then
        raise exception 'Nome, estrutura e vínculos da variação são definidos pela tarefa pai.';
      end if;
      select coalesce(array_agg(distinct field order by field), '{}'::text[]) into new.variation_override_fields
        from (
          select unnest(old.variation_override_fields) as field
          union all
          select key from jsonb_each(to_jsonb(new)) where key = any(editable) and value is distinct from to_jsonb(old)->key
        ) changes;
    end if;
    return new;
  end if;
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

create or replace function public.sync_task_template_variations()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  combination jsonb;
  overrides jsonb;
  personal_details jsonb;
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
      -- Preserve only details explicitly customized on this child; all other fields still inherit.
      select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into personal_details
        from jsonb_each(to_jsonb(previous)) where key = any(previous.variation_override_fields);
      candidate := jsonb_populate_record(candidate, personal_details || jsonb_build_object('variation_override_fields', previous.variation_override_fields));
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
        variation_override_fields = candidate.variation_override_fields,
        template_group_id = candidate.template_group_id, updated_at = candidate.updated_at
        where id = previous.id;
    end if;
    ordinal := ordinal + 1;
  end loop;
  return new;
end $$;
notify pgrst, 'reload schema';
