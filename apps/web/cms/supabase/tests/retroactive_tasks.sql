begin;

do $test$
declare
  delivery_id uuid := gen_random_uuid();
  template_id uuid := gen_random_uuid();
  product_id uuid;
begin
  select id into strict product_id from public.products limit 1;
  insert into public.deliveries (id, name, product_id, start_date, end_date, retroactive_enabled, retroactive_start_date)
  values (delivery_id, 'Retroactive validation fixture', product_id, '2026-10-01', '2026-12-31', true, '2026-01-01');

  begin
    update public.deliveries set retroactive_start_date = '2026-10-01' where id = delivery_id;
    raise exception 'Expected rejection of a non-historical date';
  exception when check_violation then null;
  end;

  begin
    update public.deliveries set retroactive_start_date = null where id = delivery_id;
    raise exception 'Expected rejection of an enabled period with no date';
  exception when check_violation then null;
  end;

  insert into public.product_activity_templates (id, product_id, activity, recurrence, requires_retroactive)
  values (template_id, product_id, 'Historical validation fixture', 'monthly', true);

  insert into public.activities (delivery_id, source_template_id, title, recurrence, occurrence_index,
    requires_retroactive, retroactive_reference_date, planned_start_date, due_date)
  values (delivery_id, template_id, 'Historical validation fixture', 'monthly', -202601,
    true, '2026-01-01', '2026-01-01', '2026-01-31');

  begin
    insert into public.activities (delivery_id, source_template_id, title, occurrence_index,
      requires_retroactive, retroactive_reference_date)
    values (delivery_id, template_id, 'Repeated fixture', -202601, true, '2026-01-01');
    raise exception 'Expected rejection of a duplicate historical occurrence';
  exception when unique_violation then null;
  end;

  begin
    insert into public.activities (delivery_id, title, occurrence_index, retroactive_reference_date)
    values (delivery_id, 'Invalid reference fixture', 0, '2026-01-01');
    raise exception 'Expected rejection of a regular task with a historical reference';
  exception when check_violation then null;
  end;

  if exists (select 1 from public.activities where source_template_id = template_id
    and (status <> 'todo' or due_date <> '2026-01-31')) then
    raise exception 'Historical task status or service period changed unexpectedly';
  end if;
end;
$test$;

rollback;
select 'Historical dates, opt-in validation and occurrence uniqueness passed; fixtures rolled back.' as result;
