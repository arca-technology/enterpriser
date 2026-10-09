alter table public.delivery_goals add column if not exists schedule_manual boolean not null default false;
alter table public.delivery_objectives add column if not exists schedule_manual boolean not null default false;
comment on column public.delivery_goals.schedule_manual is 'Manual delivery deadline override; automatic deadlines follow the product template.';
comment on column public.delivery_objectives.schedule_manual is 'Manual delivery deadline override; automatic deadlines follow the product template.';
