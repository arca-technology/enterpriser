alter table public.deliveries drop constraint deliveries_freight_channels_check;
alter table public.deliveries add constraint deliveries_freight_channels_check check (
  freight_channels <@ array['CORREIOS','DBA','FBA','FBM','FRENET','JADLOG','LOGI','LOGÍSTICA SHOPEE',
    'MAGALU ENTREGAS','MELHOR ENVIO','MERCADO ENVIOS','MERCADO ENVIOS COLETAS','MERCADO ENVIOS FLEX',
    'MERCADO ENVIOS FULL','MERCADO ENVIOS PLACES','NUVEM ENVIO','SHOPEE EXPRESS','TOTAL EXPRESS']::text[]
);
alter table public.deliveries add constraint deliveries_logistics_exclusive_check check (
  not (array['LOGÍSTICA SHOPEE','SHOPEE EXPRESS']::text[] <@ freight_channels)
  and (case when 'MERCADO ENVIOS'=any(freight_channels) then 1 else 0 end
    + case when 'MERCADO ENVIOS PLACES'=any(freight_channels) then 1 else 0 end
    + case when 'MERCADO ENVIOS COLETAS'=any(freight_channels) then 1 else 0 end) <= 1
);

create or replace function public.prevent_delivery_channel_deactivation()
returns trigger language plpgsql set search_path = '' as $$
declare removed text;
begin
  if old.erp_platform is not null and new.erp_platform is distinct from old.erp_platform then
    raise exception 'O ERP ativado não pode ser removido ou substituído.';
  end if;
  if old.store_platform is not null and new.store_platform is distinct from old.store_platform then
    raise exception 'A loja ativada não pode ser removida ou substituída.';
  end if;
  if not coalesce(old.marketplace_channels,'{}'::text[]) <@ coalesce(new.marketplace_channels,'{}'::text[]) then
    raise exception 'Marketplaces ativados não podem ser removidos.';
  end if;
  for removed in select value from unnest(coalesce(old.freight_channels,'{}'::text[])) as item(value)
    where not (value=any(coalesce(new.freight_channels,'{}'::text[])))
  loop
    if removed=any(array['LOGÍSTICA SHOPEE','SHOPEE EXPRESS'])
      and new.freight_channels && array['LOGÍSTICA SHOPEE','SHOPEE EXPRESS']::text[] then continue;
    end if;
    if removed=any(array['MERCADO ENVIOS','MERCADO ENVIOS PLACES','MERCADO ENVIOS COLETAS'])
      and new.freight_channels && array['MERCADO ENVIOS','MERCADO ENVIOS PLACES','MERCADO ENVIOS COLETAS']::text[] then continue;
    end if;
    raise exception 'Logística ativada não pode ser removida; as modalidades exclusivas podem ser substituídas dentro do mesmo grupo.';
  end loop;
  return new;
end;
$$;
comment on column public.deliveries.freight_channels is
  'Logística ativada. Shopee padrão/Express e Mercado Envios/Places/Coletas admitem substituição dentro do grupo; Full e Flex coexistem.';
