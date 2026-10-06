-- Tipo de contato da empresa (Cliente, Fornecedor, Parceiro; vários
-- separados por "; ", vazio quando não definido). Ao salvar a empresa, o CMS
-- replica esses tipos para as pessoas vinculadas.
alter table public.companies add column if not exists contact_type text;
