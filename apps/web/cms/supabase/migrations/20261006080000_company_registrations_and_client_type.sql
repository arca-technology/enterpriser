-- Inscrições da empresa: estaduais por UF (a primeira é a do estado da
-- empresa) e municipal.
alter table public.companies
  add column if not exists state_registrations jsonb not null default '[]'::jsonb,
  add column if not exists municipal_registration text;

-- Empresas com entrega são clientes: recebem o tipo Cliente e o replicam para
-- as pessoas vinculadas (mantendo os outros tipos delas).
with delivery_companies as (
  select c.tax_id
  from public.companies c
  where exists (
    select 1 from public.deliveries d
    where regexp_replace(d.company_id, '\D', '', 'g') = regexp_replace(c.tax_id, '\D', '', 'g')
  )
)
update public.companies c
set contact_type = concat_ws('; ', nullif(trim(c.contact_type), ''), 'Cliente')
from delivery_companies dc
where dc.tax_id = c.tax_id
  and coalesce(c.contact_type, '') !~* '(^|[;,]\s*)cliente\s*($|[;,])';

with client_contacts as (
  select distinct cc.contact_id
  from public.contact_companies cc
  join public.companies c on c.tax_id = cc.company_id
  where coalesce(c.contact_type, '') ~* '(^|[;,]\s*)cliente\s*($|[;,])'
)
update public.contacts ct
set contact_type = concat_ws('; ', nullif(trim(ct.contact_type), ''), 'Cliente')
from client_contacts cl
where cl.contact_id = ct.id
  and coalesce(ct.contact_type, '') !~* '(^|[;,]\s*)cliente\s*($|[;,])';
