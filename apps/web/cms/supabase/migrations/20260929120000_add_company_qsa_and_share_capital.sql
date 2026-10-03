alter table public.companies
  add column if not exists qsa text,
  add column if not exists share_capital numeric(18, 2);

comment on column public.companies.qsa is
  'Quadro de Sócios e Administradores. Múltiplos integrantes são separados por ponto e vírgula.';

comment on column public.companies.share_capital is
  'Capital social da empresa em reais.';
