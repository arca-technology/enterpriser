alter table public.negotiations
  add column if not exists no_company boolean not null default false;

alter table public.product_activity_templates
  add column if not exists target_days integer;

alter table public.product_activity_templates
  drop constraint if exists product_activity_templates_target_days_check;

alter table public.product_activity_templates
  add constraint product_activity_templates_target_days_check
  check (target_days is null or target_days >= 0);

alter table public.product_goal_templates
  add column if not exists comments text;

alter table public.product_objective_templates
  add column if not exists comments text;

alter table public.delivery_goals
  add column if not exists comments text;

alter table public.delivery_objectives
  add column if not exists comments text;

alter table public.deliveries
  add column if not exists business_metrics jsonb not null default '[]'::jsonb;

alter table public.deliveries
  drop constraint if exists deliveries_business_metrics_array_check;

alter table public.deliveries
  add constraint deliveries_business_metrics_array_check
  check (jsonb_typeof(business_metrics) = 'array');

comment on column public.negotiations.no_company is
  'Indica que a negociacao nao possui empresa vinculada.';

comment on column public.product_activity_templates.target_days is
  'Prazo sugerido em dias a partir do inicio previsto da ocorrencia.';

comment on column public.deliveries.business_metrics is
  'Serie mensal da entrega com faturamento, quantidade de SKUs e empresas fornecedoras.';
