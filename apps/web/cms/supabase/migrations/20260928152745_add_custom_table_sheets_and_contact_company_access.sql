alter table public.custom_tables
  add column if not exists sheets jsonb not null default '[]'::jsonb
  check (jsonb_typeof(sheets) = 'array');

update public.custom_tables
set sheets = jsonb_build_array(jsonb_build_object(
  'id', gen_random_uuid(),
  'name', 'Planilha 1',
  'columns', column_definitions,
  'rows', row_data
))
where sheets = '[]'::jsonb;

comment on column public.custom_tables.sheets is
  'Abas da tabela, cada uma com colunas e linhas próprias armazenadas em JSON.';

create or replace function public.replace_contact_company_links(
  p_contact_id uuid,
  p_company_ids text[] default '{}'::text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
    or not (select private.crm_has_active_access())
    or not exists (
      select 1
      from public.profiles
      where auth_user_id = (select auth.uid())
        and status = 'active'
        and (role = 'admin' or lower(trim(coalesce(job_title, ''))) = 'comercial')
    ) then
    raise exception 'Apenas administradores ou usuários do cargo Comercial podem alterar empresas de pessoas.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.contacts where id = p_contact_id) then
    raise exception 'Pessoa não encontrada.' using errcode = 'P0002';
  end if;

  delete from public.contact_companies where contact_id = p_contact_id;

  insert into public.contact_companies (contact_id, company_id)
  select p_contact_id, company.tax_id
  from public.companies as company
  where company.tax_id = any(coalesce(p_company_ids, '{}'::text[]))
  on conflict do nothing;
end;
$$;

revoke all on function public.replace_contact_company_links(uuid, text[]) from public, anon;
grant execute on function public.replace_contact_company_links(uuid, text[]) to authenticated;

comment on function public.replace_contact_company_links(uuid, text[]) is
  'Substitui atomicamente as empresas de uma pessoa para administradores ou usuários ativos do cargo Comercial.';
