alter table public.product_objective_templates
  add column if not exists default_assignee_ids uuid[] not null default '{}'::uuid[],
  add column if not exists assign_to_client boolean not null default false;

alter table public.product_goal_templates
  add column if not exists default_assignee_ids uuid[] not null default '{}'::uuid[],
  add column if not exists assign_to_client boolean not null default false;

alter table public.delivery_objectives
  add column if not exists assignee_ids uuid[] not null default '{}'::uuid[],
  add column if not exists assign_to_client boolean not null default false;

alter table public.delivery_goals
  add column if not exists assignee_ids uuid[] not null default '{}'::uuid[],
  add column if not exists assign_to_client boolean not null default false;

alter table public.product_activity_templates
  add column if not exists assign_to_client boolean not null default false;

alter table public.activities
  add column if not exists assign_to_client boolean not null default false;

update public.product_objective_templates
set default_assignee_ids = array[default_owner_id]
where default_owner_id is not null
  and cardinality(default_assignee_ids) = 0;

update public.product_goal_templates
set default_assignee_ids = array[default_owner_id]
where default_owner_id is not null
  and cardinality(default_assignee_ids) = 0;

update public.delivery_objectives
set assignee_ids = array[owner_id]
where owner_id is not null
  and cardinality(assignee_ids) = 0;

update public.delivery_goals
set assignee_ids = array[owner_id]
where owner_id is not null
  and cardinality(assignee_ids) = 0;
