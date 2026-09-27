alter table public.company_documents
  add column if not exists system_name text not null default 'ENTERPRISER CRM',
  add column if not exists module_name text,
  add column if not exists document_type text not null default 'documentation';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'company_documents_document_type_check'
      and conrelid = 'public.company_documents'::regclass
  ) then
    alter table public.company_documents
      add constraint company_documents_document_type_check
      check (document_type in ('documentation', 'procedure', 'specification'));
  end if;
end $$;

comment on column public.company_documents.system_name is
  'Sistema ou produto identificado no cabeçalho da documentação.';

comment on column public.company_documents.module_name is
  'Módulo funcional identificado no cabeçalho da documentação.';

comment on column public.company_documents.document_type is
  'Tipo estrutural: documentação, procedimento ou especificação.';
