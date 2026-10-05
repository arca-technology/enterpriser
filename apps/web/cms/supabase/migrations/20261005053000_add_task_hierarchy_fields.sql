alter table public.product_activity_templates
  add column if not exists subgroup_name text,
  add column if not exists subsector text,
  add column if not exists module_name text,
  add column if not exists submodule_name text;

alter table public.activities
  add column if not exists subgroup_name text,
  add column if not exists subsector text,
  add column if not exists module_name text,
  add column if not exists submodule_name text;

comment on column public.product_activity_templates.subgroup_name is 'Subgrupo operacional dependente do grupo da tarefa-modelo.';
comment on column public.product_activity_templates.subsector is 'Subdivisão livre do setor da tarefa-modelo.';
comment on column public.product_activity_templates.module_name is 'Módulo funcional da tarefa-modelo.';
comment on column public.product_activity_templates.submodule_name is 'Submódulo funcional da tarefa-modelo.';

comment on column public.activities.subgroup_name is 'Subgrupo operacional dependente do grupo da tarefa.';
comment on column public.activities.subsector is 'Subdivisão livre do setor da tarefa.';
comment on column public.activities.module_name is 'Módulo funcional da tarefa.';
comment on column public.activities.submodule_name is 'Submódulo funcional da tarefa.';
