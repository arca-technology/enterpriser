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
      split_part(partner_entry, '|', 2),
      '^\s*Qualificação\s*:\s*',
      '',
      'i'
    )), '');

    if partner_name = '' then
      continue;
    end if;

    normalized_name := private.crm_normalize_person_name(partner_name);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(normalized_name, 0));

    select c.id
      into v_contact_id
      from public.contacts c
     where private.crm_normalize_person_name(c.name) = normalized_name
     order by c.created_at, c.id
     limit 1;

    if v_contact_id is null then
      insert into public.contacts (name, company_id, contact_type, channel, job_title)
      values (partner_name, new.tax_id, 'Sócio', 'QSA', partner_qualification)
      returning id into v_contact_id;
    else
      update public.contacts
         set company_id = coalesce(company_id, new.tax_id),
             contact_type = coalesce(nullif(trim(contact_type), ''), 'Sócio'),
             channel = coalesce(nullif(trim(channel), ''), 'QSA'),
             job_title = coalesce(nullif(trim(job_title), ''), partner_qualification),
             updated_at = now()
       where id = v_contact_id;
    end if;

    insert into public.contact_companies (contact_id, company_id)
    values (v_contact_id, new.tax_id)
    on conflict (contact_id, company_id) do nothing;

    v_contact_id := null;
  end loop;

  return new;
end;
$$;

revoke all on function private.crm_sync_company_qsa_contacts() from public, anon, authenticated;
