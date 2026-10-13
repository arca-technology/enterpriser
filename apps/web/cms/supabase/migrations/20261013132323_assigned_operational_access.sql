alter table public.crm_workspace_settings add column task_date_migration_enabled boolean not null default true;

create function private.crm_row_is_mine(p_owner uuid, p_assignees uuid[], p_job_titles text[] default '{}')
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
      and (p.id = p_owner or p.id = any(coalesce(p_assignees, '{}'))
        or (nullif(btrim(p.job_title), '') is not null and exists (
          select 1 from unnest(coalesce(p_job_titles, '{}')) title
          where lower(btrim(title)) = lower(btrim(p.job_title))))));
$$;

create function private.crm_can_mutate_assigned(p_owner uuid, p_assignees uuid[], p_job_titles text[], p_module text, p_action text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.status = 'active'
      and (p.role = 'admin' or (p.role = 'collaborator'
        and ((p.permissions -> p_module ->> p_action) = 'true'
          or (p_action = 'edit' and (p.permissions -> p_module ->> 'operate') = 'true'))
        and private.crm_row_is_mine(p_owner, p_assignees, p_job_titles))));
$$;

-- The closure is evaluated once per statement and UNION terminates dependency cycles.
create function private.crm_visible_activity_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  with recursive actor as (
    select id, job_title from public.profiles
    where auth_user_id = (select auth.uid()) and status = 'active' and role = 'collaborator'
      and (permissions -> 'activities' ->> 'view') = 'true'
  ), visible(id) as (
    select a.id from public.activities a cross join actor p
    where a.owner_id = p.id or p.id = any(coalesce(a.assignee_ids, '{}'))
      or (nullif(btrim(p.job_title), '') is not null and exists (
        select 1 from unnest(coalesce(a.assignee_job_titles, '{}')) title
        where lower(btrim(title)) = lower(btrim(p.job_title))))
    union
    select dependency.id from visible v join public.activities a on a.id = v.id
    join public.activities dependency on dependency.delivery_id = a.delivery_id
      and dependency.id = any(coalesce(a.dependency_ids, '{}') || array[a.depends_on_activity_id, a.parent_activity_id])
  ) select id from visible;
$$;
revoke all on function private.crm_row_is_mine(uuid, uuid[], text[]) from public, anon;
revoke all on function private.crm_can_mutate_assigned(uuid, uuid[], text[], text, text) from public, anon;
revoke all on function private.crm_visible_activity_ids() from public, anon;
grant execute on function private.crm_row_is_mine(uuid, uuid[], text[]) to authenticated;
grant execute on function private.crm_can_mutate_assigned(uuid, uuid[], text[], text, text) to authenticated;
grant execute on function private.crm_visible_activity_ids() to authenticated;

alter policy authenticated_scoped_select on public.activities using (
  (select private.crm_can_access_delivery(activities.delivery_id))
  and ((select private.crm_current_role()) <> 'collaborator' or id in (select private.crm_visible_activity_ids()))
);
alter policy internal_delete on public.activities using (private.crm_can_mutate_assigned(owner_id, assignee_ids, assignee_job_titles, 'activities', 'delete'));
alter policy internal_or_supplier_insert on public.activities with check (
  private.crm_can_mutate_assigned(owner_id, assignee_ids, assignee_job_titles, 'activities', 'create')
  or ((select private.crm_current_role()) = 'supplier' and (select private.crm_can_access_delivery(delivery_id)))
);
alter policy internal_or_supplier_update on public.activities using (
  private.crm_can_mutate_assigned(owner_id, assignee_ids, assignee_job_titles, 'activities', 'edit')
  or ((select private.crm_current_role()) = 'supplier' and (select private.crm_can_access_delivery(delivery_id)))
) with check (
  private.crm_can_mutate_assigned(owner_id, assignee_ids, assignee_job_titles, 'activities', 'edit')
  or ((select private.crm_current_role()) = 'supplier' and (select private.crm_can_access_delivery(delivery_id)))
);

do $$ declare target text; begin
  foreach target in array array['delivery_goals', 'delivery_objectives'] loop
    execute format('alter policy internal_insert on public.%I with check (private.crm_can_mutate_assigned(owner_id, assignee_ids, ''{}'', ''projects'', ''create''))', target);
    execute format('alter policy internal_delete on public.%I using (private.crm_can_mutate_assigned(owner_id, assignee_ids, ''{}'', ''projects'', ''delete''))', target);
    execute format('alter policy internal_update on public.%I using (private.crm_can_mutate_assigned(owner_id, assignee_ids, ''{}'', ''projects'', ''edit'')) with check (private.crm_can_mutate_assigned(owner_id, assignee_ids, ''{}'', ''projects'', ''edit''))', target);
  end loop;
end $$;

alter policy "Active users can read activity comments" on public.activity_comments using (
  (select private.crm_has_active_access()) and exists(select 1 from public.activities a where a.id = activity_comments.activity_id)
);
alter policy "Active users can add their activity comments" on public.activity_comments with check (
  author_id = (select id from public.profiles where auth_user_id = (select auth.uid()) and status = 'active' limit 1)
  and exists(select 1 from public.activities a where a.id = activity_comments.activity_id
    and ((select private.crm_current_role()) <> 'collaborator' or private.crm_row_is_mine(a.owner_id, a.assignee_ids, a.assignee_job_titles)))
);
