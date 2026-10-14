-- Opt-in fields preserve the existing delivery and task behavior.
alter table public.deliveries
  add column retroactive_enabled boolean not null default false,
  add column retroactive_start_date date;

alter table public.product_activity_templates
  add column requires_retroactive boolean not null default false;

alter table public.activities
  add column requires_retroactive boolean not null default false,
  add column retroactive_reference_date date;

alter table public.deliveries add constraint deliveries_retroactive_period_check check (
  (not retroactive_enabled and retroactive_start_date is null)
  or (retroactive_enabled and retroactive_start_date is not null
    and start_date is not null and retroactive_start_date < start_date)
);

alter table public.activities add constraint activities_retroactive_reference_check check (
  retroactive_reference_date is null
  or (requires_retroactive and occurrence_index < 0)
);

comment on column public.deliveries.retroactive_start_date is 'Start of historical service before the delivery start date; disabled by default.';
comment on column public.product_activity_templates.requires_retroactive is 'Only generate this template for deliveries with a historical service period.';
comment on column public.activities.retroactive_reference_date is 'Historical service date; negative occurrence keys preserve regular task identities.';
