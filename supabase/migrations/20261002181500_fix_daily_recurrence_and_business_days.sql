alter table public.product_activity_templates
  drop constraint if exists product_activity_templates_recurrence_check;

alter table public.product_activity_templates
  add constraint product_activity_templates_recurrence_check
  check (recurrence = any (array[
    'once'::text, 'daily'::text, 'weekly'::text, 'biweekly'::text,
    'monthly'::text, 'bimonthly'::text, 'quarterly'::text,
    'semiannual'::text, 'annual'::text
  ]));

alter table public.activities
  drop constraint if exists activities_recurrence_check;

alter table public.activities
  add constraint activities_recurrence_check
  check (recurrence = any (array[
    'once'::text, 'daily'::text, 'weekly'::text, 'biweekly'::text,
    'monthly'::text, 'bimonthly'::text, 'quarterly'::text,
    'semiannual'::text, 'annual'::text
  ]));

alter table public.product_activity_templates
  add column if not exists consider_business_days boolean not null default false;

alter table public.activities
  add column if not exists consider_business_days boolean not null default false;

comment on column public.product_activity_templates.consider_business_days is
  'Quando verdadeiro, o prazo sugerido e a recorrencia diaria desconsideram sabados e domingos.';

comment on column public.activities.consider_business_days is
  'Indica que o planejamento da tarefa considera apenas dias uteis.';
