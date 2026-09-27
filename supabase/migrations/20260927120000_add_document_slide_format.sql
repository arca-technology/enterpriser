alter table public.company_documents
  add column if not exists slide_format text not null default 'widescreen';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'company_documents_slide_format_check'
      and conrelid = 'public.company_documents'::regclass
  ) then
    alter table public.company_documents
      add constraint company_documents_slide_format_check
      check (slide_format in ('widescreen', 'standard'));
  end if;
end $$;
