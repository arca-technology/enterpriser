-- Empresas importadas por planilha entram só com o CNPJ e ficam marcadas
-- como desatualizadas até o CMS buscar os dados na Receita em segundo plano.
alter table public.companies
  add column if not exists registry_pending boolean not null default false,
  add column if not exists registry_checked_at timestamptz,
  add column if not exists registry_error text;
