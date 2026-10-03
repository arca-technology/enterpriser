alter table public.profiles
  add column if not exists nickname text
  check (nickname is null or char_length(trim(nickname)) between 1 and 80);

comment on column public.profiles.nickname is
  'Nome curto exibido em responsáveis, seletores e atribuições do CRM.';
