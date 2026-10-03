alter table public.activities
  add column if not exists planned_start_date date,
  add column if not exists planned_end_date date,
  add column if not exists actual_start_date date,
  add column if not exists actual_end_date date;

update public.activities
set planned_end_date = due_date
where planned_end_date is null
  and due_date is not null;

update public.activities as activity
set planned_start_date = delivery.start_date
from public.deliveries as delivery
where activity.delivery_id = delivery.id
  and activity.planned_start_date is null
  and delivery.start_date is not null;

alter table public.activities
  drop constraint if exists activities_status_check;

alter table public.activities
  add constraint activities_status_check
  check (status = any (array['todo'::text, 'doing'::text, 'done'::text, 'canceled'::text]));

update public.deliveries
set status = case
  when status in ('planned', 'in_progress') then 'active'
  when status in ('done', 'canceled') then 'closed'
  else status
end;

update public.deliveries
set substatus = case when status = 'closed' then 'closed' else null end;

alter table public.deliveries
  alter column status set default 'active';

alter table public.deliveries
  drop constraint if exists deliveries_status_check;

alter table public.deliveries
  add constraint deliveries_status_check
  check (status = any (array['active'::text, 'inactive'::text, 'closed'::text]));

alter table public.deliveries
  drop constraint if exists deliveries_substatus_check;

alter table public.deliveries
  add constraint deliveries_substatus_check
  check (substatus is null or substatus = any (array['support'::text, 'closed'::text]));
