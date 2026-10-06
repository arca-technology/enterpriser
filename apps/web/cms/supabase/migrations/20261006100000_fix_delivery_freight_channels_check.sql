-- O frete automático (Mercado Livre → MERCADO ENVIOS, Nuvem Shop → NUVEM
-- ENVIO) não estava na lista permitida e bloqueava o salvamento da entrega.
alter table public.deliveries drop constraint if exists deliveries_freight_channels_check;
alter table public.deliveries add constraint deliveries_freight_channels_check
  check (freight_channels <@ array['CORREIOS', 'FRENET', 'JADLOG', 'LOGI', 'MELHOR ENVIO', 'MERCADO ENVIOS', 'NUVEM ENVIO', 'TOTAL EXPRESS']::text[]);
