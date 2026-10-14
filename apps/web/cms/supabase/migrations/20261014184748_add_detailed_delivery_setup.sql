-- Empty defaults keep all existing channel-only task rules unchanged.
alter table public.deliveries
  add column setup_configuration jsonb not null default '{}'::jsonb,
  add column setup_product_types text[] not null default '{}',
  add constraint deliveries_setup_configuration_object check (jsonb_typeof(setup_configuration) = 'object'),
  add constraint deliveries_setup_product_types_valid check (setup_product_types <@ array[
    'own_national', 'own_international', 'third_party_national', 'third_party_international']::text[]);

alter table public.product_activity_templates
  add column required_setup_configuration jsonb not null default '{}'::jsonb,
  add column required_product_types text[] not null default '{}',
  add constraint templates_setup_configuration_object check (jsonb_typeof(required_setup_configuration) = 'object'),
  add constraint templates_setup_product_types_valid check (required_product_types <@ array[
    'own_national', 'own_international', 'third_party_national', 'third_party_international']::text[]);

alter table public.activities
  add column required_setup_configuration jsonb not null default '{}'::jsonb,
  add column required_product_types text[] not null default '{}',
  add constraint activities_setup_configuration_object check (jsonb_typeof(required_setup_configuration) = 'object'),
  add constraint activities_setup_product_types_valid check (required_product_types <@ array[
    'own_national', 'own_international', 'third_party_national', 'third_party_international']::text[]);

comment on column public.deliveries.setup_configuration is
  'Per-channel modules, qualified submodules and per-financial-account emits_boleto boolean; missing means unspecified.';
comment on column public.product_activity_templates.required_setup_configuration is
  'Opt-in per-channel requirements, all selected requirements must be active in the delivery Setup.';
comment on column public.activities.required_setup_configuration is
  'Copy of template requirements or explicit requirements for a day-to-day task.';
