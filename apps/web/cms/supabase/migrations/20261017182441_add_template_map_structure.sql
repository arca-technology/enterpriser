-- Presentation metadata only. Existing templates remain simple; execution is unchanged.
create function public.normalize_template_map_structure()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare family jsonb;
begin
  if tg_table_schema <> 'public' or tg_table_name not in
    ('product_activity_templates','product_goal_templates','product_objective_templates') then
    raise exception 'Invalid map structure table';
  end if;
  if new.variation_parent_id is not null then
    execute format('select to_jsonb(t) from public.%I t where id=$1', tg_table_name)
      into family using new.variation_parent_id;
    new.structure_type := family->>'structure_type';
    new.structure_group := family->>'structure_group';
    new.structure_order := (family->>'structure_order')::integer;
  end if;
  new.structure_group := btrim(new.structure_group);
  if new.structure_type = 'simple' then
    new.structure_group := ''; new.structure_order := 0;
  elsif new.structure_type = 'alternatives' then
    new.structure_order := 0;
  end if;
  return new;
end $$;
revoke all on function public.normalize_template_map_structure() from public, anon;

do $$
declare template_table text;
begin
  foreach template_table in array array['product_activity_templates','product_goal_templates','product_objective_templates'] loop
    execute format('alter table public.%I
      add column structure_type text not null default ''simple'',
      add column structure_group text not null default '''',
      add column structure_order integer not null default 0,
      add constraint template_map_structure_valid check (
        (structure_type=''simple'' and structure_group='''' and structure_order=0)
        or (structure_type=''alternatives'' and length(btrim(structure_group)) between 1 and 120 and structure_order=0)
        or (structure_type=''progression'' and length(btrim(structure_group)) between 1 and 120 and structure_order between 1 and 10000)
      )', template_table);
    execute format('create trigger zz_normalize_template_map_structure before insert or update on public.%I
      for each row execute function public.normalize_template_map_structure()', template_table);
  end loop;
end $$;
notify pgrst, 'reload schema';
