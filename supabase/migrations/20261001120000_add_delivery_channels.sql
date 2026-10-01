alter table public.deliveries
  add column if not exists erp_platform text,
  add column if not exists marketplace_channels text[] not null default '{}',
  add column if not exists store_platform text,
  add column if not exists freight_channels text[] not null default '{}';

alter table public.deliveries
  drop constraint if exists deliveries_erp_platform_check,
  add constraint deliveries_erp_platform_check
    check (erp_platform is null or erp_platform = any (array['BLING', 'OLIST'])),
  drop constraint if exists deliveries_marketplace_channels_check,
  add constraint deliveries_marketplace_channels_check
    check (marketplace_channels <@ array['AMAZON', 'MAGAZINE LUIZA', 'MERCADO LIVRE', 'SHEIN', 'SHOPEE', 'TIKTOKSHOP']::text[]),
  drop constraint if exists deliveries_store_platform_check,
  add constraint deliveries_store_platform_check
    check (store_platform is null or store_platform = any (array['BAGY', 'NUVEM SHOP', 'SHOPIFY', 'TRAY', 'VTEX', 'WAKE', 'WOOCOMMERCE'])),
  drop constraint if exists deliveries_freight_channels_check,
  add constraint deliveries_freight_channels_check
    check (freight_channels <@ array['CORREIOS', 'FRENET', 'JADLOG', 'LOGI', 'MELHOR ENVIO', 'TOTAL EXPRESS']::text[]);

comment on column public.deliveries.erp_platform is
  'ERP contratado para a entrega. Depois de ativado, não pode ser removido ou substituído.';
comment on column public.deliveries.marketplace_channels is
  'Marketplaces ativados para a entrega. Depois de ativados, só podem receber novos itens.';
comment on column public.deliveries.store_platform is
  'Plataforma de loja contratada para a entrega. Depois de ativada, não pode ser removida ou substituída.';
comment on column public.deliveries.freight_channels is
  'Integrações de frete ativadas para a entrega. Depois de ativadas, só podem receber novos itens.';

create or replace function public.prevent_delivery_channel_deactivation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.erp_platform is not null and new.erp_platform is distinct from old.erp_platform then
    raise exception 'O ERP ativado não pode ser removido ou substituído.';
  end if;

  if old.store_platform is not null and new.store_platform is distinct from old.store_platform then
    raise exception 'A loja ativada não pode ser removida ou substituída.';
  end if;

  if not coalesce(old.marketplace_channels, '{}'::text[]) <@ coalesce(new.marketplace_channels, '{}'::text[]) then
    raise exception 'Marketplaces ativados não podem ser removidos.';
  end if;

  if not coalesce(old.freight_channels, '{}'::text[]) <@ coalesce(new.freight_channels, '{}'::text[]) then
    raise exception 'Canais de frete ativados não podem ser removidos.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_delivery_channel_deactivation on public.deliveries;
create trigger prevent_delivery_channel_deactivation
before update of erp_platform, marketplace_channels, store_platform, freight_channels
on public.deliveries
for each row
execute function public.prevent_delivery_channel_deactivation();
