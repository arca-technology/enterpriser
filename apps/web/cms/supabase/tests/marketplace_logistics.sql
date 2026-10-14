begin;
do $test$
declare delivery_id uuid:=gen_random_uuid(); product_id uuid;
begin
  select id into strict product_id from public.products limit 1;
  insert into public.deliveries(id,name,product_id,erp_platform,marketplace_channels,freight_channels)
  values(delivery_id,'Logistics fixture',product_id,'BLING',array['MERCADO LIVRE','SHOPEE'],array['MERCADO ENVIOS','LOGÍSTICA SHOPEE','CORREIOS']);
  update public.deliveries set freight_channels=array['MERCADO ENVIOS PLACES','SHOPEE EXPRESS','MERCADO ENVIOS FULL','MERCADO ENVIOS FLEX','CORREIOS'] where id=delivery_id;
  update public.deliveries set freight_channels=array['MERCADO ENVIOS COLETAS','LOGÍSTICA SHOPEE','MERCADO ENVIOS FULL','MERCADO ENVIOS FLEX','CORREIOS','DBA','FBA','FBM','MAGALU ENTREGAS'] where id=delivery_id;
  begin
    update public.deliveries set freight_channels=freight_channels || 'MERCADO ENVIOS'::text where id=delivery_id;
    raise exception 'Expected rejection of incompatible Mercado Envios modalities';
  exception when check_violation then null;
  end;
  begin
    update public.deliveries set freight_channels=freight_channels || 'SHOPEE EXPRESS'::text where id=delivery_id;
    raise exception 'Expected rejection of both Shopee modalities';
  exception when check_violation then null;
  end;
  begin
    update public.deliveries set freight_channels=array_remove(freight_channels,'CORREIOS') where id=delivery_id;
    raise exception 'Expected existing non-exclusive logistics protection';
  exception when raise_exception then
    if sqlerrm not like 'Logística ativada%' then raise; end if;
  end;
  begin
    update public.deliveries set erp_platform='OLIST' where id=delivery_id;
    raise exception 'Expected existing ERP protection';
  exception when raise_exception then
    if sqlerrm not like 'O ERP ativado%' then raise; end if;
  end;
end;
$test$;
rollback;
select 'Logistics options, exclusive replacements, Full/Flex coexistence and existing protections passed; fixtures rolled back.' as result;
