-- Setups da entrega: Empresa (informativo) e Contas financeiras (bancos e gateways).
alter table public.deliveries add column if not exists company_setup text;
alter table public.deliveries add column if not exists financial_accounts text[] not null default '{}'::text[];
