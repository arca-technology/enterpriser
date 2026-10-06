-- Estrutura Categoria | Canal | Módulo | Submódulo em Documentação e Processos.
-- Canal reutiliza a coluna system_name que já existe nas duas tabelas.
alter table public.company_documents add column if not exists submodule_name text;
alter table public.training_processes add column if not exists module_name text;
alter table public.training_processes add column if not exists submodule_name text;
