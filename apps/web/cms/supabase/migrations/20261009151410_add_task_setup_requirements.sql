alter table public.product_activity_templates add column required_setup text[] not null default '{}';
alter table public.activities add column required_setup text[] not null default '{}';

-- Preserve existing channel gating without interpreting task titles.
update public.product_activity_templates as task
set required_setup = array[option.label]
from unnest(array['BLING','OLIST','AMAZON','MAGAZINE LUIZA','MERCADO LIVRE','SHEIN','SHOPEE','TIKTOKSHOP','LOJA FÍSICA','BAGY','NUVEM SHOP','SHOPIFY','TRAY','VTEX','WAKE','WOOCOMMERCE','CORREIOS','FRENET','JADLOG','LOGI','MELHOR ENVIO','MERCADO ENVIOS','NUVEM ENVIO','TOTAL EXPRESS','BANCO DO BRASIL','BRADESCO','BTG PACTUAL','C6 BANK','CAIXA','INTER','ITAÚ','NUBANK','SANTANDER','SICOOB','SICREDI','APPMAX','ASAAS','CIELO','EFÍ','GETNET','MERCADO PAGO','NUVEM PAGO','PAGAR.ME','PAGBANK','PAYPAL','REDE','STONE','STRIPE','VINDI']) as option(label)
where regexp_replace(upper(translate(coalesce(task.channel, ''), 'ÁÀÂÃÉÊÍÓÔÕÚÇ', 'AAAAEEIOOOUC')), '[^A-Z0-9]', '', 'g')
  = regexp_replace(upper(translate(option.label, 'ÁÀÂÃÉÊÍÓÔÕÚÇ', 'AAAAEEIOOOUC')), '[^A-Z0-9]', '', 'g');
update public.activities as task
set required_setup = array[option.label]
from unnest(array['BLING','OLIST','AMAZON','MAGAZINE LUIZA','MERCADO LIVRE','SHEIN','SHOPEE','TIKTOKSHOP','LOJA FÍSICA','BAGY','NUVEM SHOP','SHOPIFY','TRAY','VTEX','WAKE','WOOCOMMERCE','CORREIOS','FRENET','JADLOG','LOGI','MELHOR ENVIO','MERCADO ENVIOS','NUVEM ENVIO','TOTAL EXPRESS','BANCO DO BRASIL','BRADESCO','BTG PACTUAL','C6 BANK','CAIXA','INTER','ITAÚ','NUBANK','SANTANDER','SICOOB','SICREDI','APPMAX','ASAAS','CIELO','EFÍ','GETNET','MERCADO PAGO','NUVEM PAGO','PAGAR.ME','PAGBANK','PAYPAL','REDE','STONE','STRIPE','VINDI']) as option(label)
where regexp_replace(upper(translate(coalesce(task.channel, ''), 'ÁÀÂÃÉÊÍÓÔÕÚÇ', 'AAAAEEIOOOUC')), '[^A-Z0-9]', '', 'g')
  = regexp_replace(upper(translate(option.label, 'ÁÀÂÃÉÊÍÓÔÕÚÇ', 'AAAAEEIOOOUC')), '[^A-Z0-9]', '', 'g');
comment on column public.product_activity_templates.required_setup is 'All listed setup requirements must be active; empty means a general task.';
comment on column public.activities.required_setup is 'Setup requirements copied from the task template or set on manual tasks.';
