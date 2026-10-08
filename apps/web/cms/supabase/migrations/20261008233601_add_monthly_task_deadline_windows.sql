alter table public.product_activity_templates
  add column if not exists deadline_window text not null default 'date'
  check (deadline_window in ('date', 'month', 'week1', 'week2', 'week3', 'week4'));

alter table public.activities
  add column if not exists deadline_window text not null default 'date'
  check (deadline_window in ('date', 'month', 'week1', 'week2', 'week3', 'week4'));

comment on column public.activities.deadline_window is
  'Monthly execution window: whole month or days 1-7, 8-14, 15-21, 22-month end; date preserves fixed deadlines.';
