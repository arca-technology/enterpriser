alter table public.product_objective_templates add column dependency_goal_template_ids uuid[] not null default '{}';
alter table public.delivery_objectives add column dependency_goal_ids uuid[] not null default '{}';

create or replace function public.result_variation_detail_fields(kind text)
returns text[] language sql immutable security invoker set search_path = '' as $$
  select array['comments','notes','target_days','default_owner_id','default_assignee_ids','assign_to_client','dependency_activity_template_ids','dependency_goal_template_ids']::text[]
    || case when kind='product_goal_templates' then array['metric','comparison','target_value','unit']
      else array['completion_criteria','dependency_objective_template_ids'] end;
$$;

create function public.guard_objective_goal_dependencies()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  goal_id uuid;
begin
  if tg_table_name='product_objective_templates' then
    for goal_id in select unnest(new.dependency_goal_template_ids) loop
      if not exists(select 1 from public.product_goal_templates where id=goal_id and product_id=new.product_id and variation_axes='{}') then
        raise exception 'Escolha uma meta simples ou variação filha do mesmo produto.';
      end if;
    end loop;
  elsif tg_table_name='delivery_objectives' then
    for goal_id in select unnest(new.dependency_goal_ids) loop
      if not exists(select 1 from public.delivery_goals where id=goal_id and delivery_id=new.delivery_id) then
        raise exception 'A meta dependente deve pertencer à mesma entrega.';
      end if;
    end loop;
    if new.status<>'todo' and (tg_op='INSERT' or new.status is distinct from old.status) and exists(
      select 1 from public.delivery_goals where id=any(new.dependency_goal_ids) and status<>'done'
    ) then raise exception 'Conclua as metas dependentes antes de avançar este objetivo.'; end if;
  else raise exception 'Invalid dependency table';
  end if;
  return new;
end $$;
create trigger guard_objective_goal_dependencies before insert or update of dependency_goal_template_ids,product_id on public.product_objective_templates
  for each row execute function public.guard_objective_goal_dependencies();
create trigger guard_delivery_objective_goals before insert or update of dependency_goal_ids,delivery_id,status on public.delivery_objectives
  for each row execute function public.guard_objective_goal_dependencies();

create function public.guard_goal_objective_references()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_table_name='product_goal_templates' then
    if tg_op='DELETE' then
      if exists(select 1 from public.product_objective_templates where old.id=any(dependency_goal_template_ids)) then
        raise exception 'Remova o vínculo dos objetivos antes de excluir esta meta.';
      end if;
      return old;
    end if;
    if old.variation_axes='{}' and new.variation_axes<>'{}' and exists(
      select 1 from public.product_objective_templates where new.id=any(dependency_goal_template_ids)
    ) then raise exception 'Uma meta usada por objetivos não pode virar pai de variações. Preserve os vínculos atuais.'; end if;
  elsif tg_table_name='delivery_goals' then
    if old.status='done' and new.status<>'done' and exists(
      select 1 from public.delivery_objectives where old.id=any(dependency_goal_ids) and status<>'todo'
    ) then raise exception 'Volte os objetivos dependentes para A fazer antes de reabrir esta meta.'; end if;
  else raise exception 'Invalid referenced table';
  end if;
  return new;
end $$;
create trigger guard_goal_objective_references before update or delete on public.product_goal_templates
  for each row execute function public.guard_goal_objective_references();
create trigger guard_delivery_goal_objectives before update of status on public.delivery_goals
  for each row execute function public.guard_goal_objective_references();

revoke all on function public.guard_objective_goal_dependencies() from public,anon;
revoke all on function public.guard_goal_objective_references() from public,anon;
notify pgrst,'reload schema';
