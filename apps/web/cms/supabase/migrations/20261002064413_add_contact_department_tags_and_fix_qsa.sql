alter table public.contacts
  add column if not exists department text,
  add column if not exists tags text[] not null default '{}'::text[];

comment on column public.contacts.department is 'Departamento ou area de atuacao da pessoa.';
comment on column public.contacts.tags is 'Marcadores livres associados a pessoa.';

-- Remove somente o marcador Parceiro que as versoes anteriores do gatilho
-- acrescentaram a pessoas encontradas no QSA. Outros tipos sao preservados.
update public.contacts c
   set contact_type = nullif((
         select string_agg(trim(item.value), '; ' order by item.ordinality)
           from regexp_split_to_table(coalesce(c.contact_type, ''), '\s*;\s*')
                with ordinality as item(value, ordinality)
          where lower(trim(item.value)) <> 'parceiro'
            and trim(item.value) <> ''
       ), ''),
       updated_at = now()
 where lower(coalesce(c.contact_type, '')) ~ '(^|;\s*)parceiro(\s*;|$)'
   and exists (
     select 1
       from public.contact_companies cc
       join public.companies company on company.tax_id = cc.company_id
      where cc.contact_id = c.id
        and company.qsa is not null
        and position(
          private.crm_normalize_person_name(c.name)
          in private.crm_normalize_person_name(company.qsa)
        ) > 0
   );

create or replace function private.crm_sync_company_qsa_contacts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  partner_entry text;
  partner_name text;
  partner_qualification text;
  normalized_name text;
  v_contact_id uuid;
  v_match_distance integer;
begin
  if new.qsa is null or trim(new.qsa) = '' then
    return new;
  end if;

  foreach partner_entry in array regexp_split_to_array(new.qsa, '\s*;\s*')
  loop
    partner_name := trim(regexp_replace(
      split_part(partner_entry, '|', 1),
      '^\s*Nome/Nome Empresarial\s*:\s*',
      '',
      'i'
    ));
    partner_qualification := nullif(trim(regexp_replace(
      regexp_replace(split_part(partner_entry, '|', 2), '^\s*Qualificação\s*:\s*', '', 'i'),
      '^\s*[0-9]+\s*-\s*',
      ''
    )), '');

    if partner_name = '' then
      continue;
    end if;

    normalized_name := private.crm_normalize_person_name(partner_name);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(normalized_name, 0));

    select c.id, 0
      into v_contact_id, v_match_distance
      from public.contacts c
     where private.crm_normalize_person_name(c.name) = normalized_name
     order by c.created_at, c.id
     limit 1;

    if v_contact_id is null and array_length(regexp_split_to_array(normalized_name, '\s+'), 1) >= 3 then
      select c.id,
             extensions.levenshtein(private.crm_normalize_person_name(c.name), normalized_name)
        into v_contact_id, v_match_distance
        from public.contact_companies cc
        join public.contacts c on c.id = cc.contact_id
       where cc.company_id = new.tax_id
         and array_length(regexp_split_to_array(private.crm_normalize_person_name(c.name), '\s+'), 1)
             = array_length(regexp_split_to_array(normalized_name, '\s+'), 1)
         and split_part(private.crm_normalize_person_name(c.name), ' ', 1) = split_part(normalized_name, ' ', 1)
         and abs(length(private.crm_normalize_person_name(c.name)) - length(normalized_name)) <= 1
         and extensions.levenshtein(private.crm_normalize_person_name(c.name), normalized_name) <= 1
       order by extensions.levenshtein(private.crm_normalize_person_name(c.name), normalized_name), c.created_at, c.id
       limit 1;
    end if;

    if v_contact_id is null then
      insert into public.contacts (name, company_id, job_title)
      values (partner_name, new.tax_id, partner_qualification)
      returning id into v_contact_id;
    else
      update public.contacts
         set name = case when coalesce(v_match_distance, 0) > 0 then partner_name else name end,
             company_id = coalesce(company_id, new.tax_id),
             job_title = coalesce(nullif(trim(job_title), ''), partner_qualification),
             updated_at = now()
       where id = v_contact_id;
    end if;

    insert into public.contact_companies (contact_id, company_id)
    values (v_contact_id, new.tax_id)
    on conflict (contact_id, company_id) do nothing;

    v_contact_id := null;
    v_match_distance := null;
  end loop;

  return new;
end;
$$;

revoke all on function private.crm_sync_company_qsa_contacts() from public, anon, authenticated;
