alter table public.profiles
  add column access_profile text not null default 'custom',
  add column auto_assignment_categories text[] not null default '{}',
  add column auto_assignment_channels text[] not null default '{}',
  add column auto_assignment_modules text[] not null default '{}',
  add column auto_assignment_submodules text[] not null default '{}',
  add constraint profiles_access_profile_check check (
    access_profile in ('custom', 'collaborator', 'project_manager')
    and (role = 'collaborator' or access_profile = 'custom')
  );

revoke update (access_profile, auto_assignment_categories, auto_assignment_channels,
  auto_assignment_modules, auto_assignment_submodules) on public.profiles from anon, authenticated;

create function private.crm_manages_pm(p_module text, p_action text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
      and p.role = 'collaborator' and p.access_profile = 'project_manager'
      and p_module in ('activities', 'projects')
      and ((p.permissions -> p_module ->> p_action) = 'true'
        or (p_action = 'edit' and (p.permissions -> p_module ->> 'operate') = 'true')));
$$;
revoke all on function private.crm_manages_pm(text, text) from public, anon;
grant execute on function private.crm_manages_pm(text, text) to authenticated;

create or replace function private.crm_can_mutate_assigned(p_owner uuid, p_assignees uuid[], p_job_titles text[], p_module text, p_action text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
      and (p.role = 'admin' or (p.role = 'collaborator'
        and ((p.permissions -> p_module ->> p_action) = 'true'
          or (p_action = 'edit' and (p.permissions -> p_module ->> 'operate') = 'true'))
        and (private.crm_row_is_mine(p_owner, p_assignees, p_job_titles)
          or (p.access_profile = 'project_manager' and p_module in ('activities', 'projects'))))));
$$;

alter policy authenticated_scoped_select on public.activities using (
  (select private.crm_can_access_delivery(activities.delivery_id))
  and ((select private.crm_current_role()) <> 'collaborator'
    or (select private.crm_manages_pm('activities', 'view'))
    or id in (select private.crm_visible_activity_ids()))
);
alter policy "Active users can add their activity comments" on public.activity_comments with check (
  author_id = (select id from public.profiles where auth_user_id = (select auth.uid()) and status = 'active' limit 1)
  and exists(select 1 from public.activities a where a.id = activity_comments.activity_id
    and ((select private.crm_current_role()) <> 'collaborator'
      or (select private.crm_manages_pm('activities', 'operate'))
      or private.crm_row_is_mine(a.owner_id, a.assignee_ids, a.assignee_job_titles)))
);

create function private.crm_task_rule_matches(p_choices text[], p_value text)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select cardinality(p_choices) = 0 or exists (
    select 1 from unnest(p_choices) choice
    where nullif(btrim(choice), '') is not null and lower(btrim(choice)) = lower(btrim(p_value))
  );
$$;
revoke all on function private.crm_task_rule_matches(text[], text) from public, anon;
grant execute on function private.crm_task_rule_matches(text[], text) to authenticated, service_role;

-- Preserve every explicit assignment; routing only runs for new, unassigned tasks.
create function private.crm_assign_new_task()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare matching_ids uuid[];
begin
  if new.owner_id is not null or cardinality(coalesce(new.assignee_ids, '{}')) > 0
    or cardinality(coalesce(new.assignee_job_titles, '{}')) > 0 or coalesce(new.assign_to_client, false) then
    return new;
  end if;
  select array_agg(p.id order by lower(coalesce(nullif(p.nickname, ''), nullif(p.full_name, ''), p.email)), p.id)
    into matching_ids from public.profiles p
    where p.status = 'active' and p.role in ('admin', 'collaborator')
      and (p.role = 'admin' or ((p.permissions -> 'activities' ->> 'view') = 'true'
        and ((p.permissions -> 'activities' ->> 'operate') = 'true' or (p.permissions -> 'activities' ->> 'edit') = 'true')))
      and (cardinality(p.auto_assignment_categories) + cardinality(p.auto_assignment_channels)
        + cardinality(p.auto_assignment_modules) + cardinality(p.auto_assignment_submodules)) > 0
      and private.crm_task_rule_matches(p.auto_assignment_categories, new.category)
      and private.crm_task_rule_matches(p.auto_assignment_channels, new.channel)
      and private.crm_task_rule_matches(p.auto_assignment_modules, new.module_name)
      and private.crm_task_rule_matches(p.auto_assignment_submodules, new.submodule_name);
  if cardinality(matching_ids) > 0 then
    new.owner_id := matching_ids[1];
    new.assignee_ids := matching_ids;
  end if;
  return new;
end;
$$;
revoke all on function private.crm_assign_new_task() from public, anon;
create trigger assign_new_task_responsibility before insert on public.activities
  for each row execute function private.crm_assign_new_task();
