-- Estrutura das tabelas personalizadas (Categoria, Canal, Módulo, Submódulo e
-- Nome) e opção de usar essa combinação como nome do arquivo. Larguras e
-- colunas congeladas ficam no JSON das abas.
alter table public.custom_tables
  add column if not exists category text,
  add column if not exists system_name text,
  add column if not exists module_name text,
  add column if not exists submodule_name text,
  add column if not exists base_name text,
  add column if not exists use_structured_name boolean not null default false;
