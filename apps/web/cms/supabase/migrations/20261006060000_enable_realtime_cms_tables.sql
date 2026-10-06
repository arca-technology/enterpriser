-- Tempo real do CMS: publica as mudanças das tabelas operacionais para o
-- Supabase Realtime. Cada usuário só recebe linhas que as políticas de RLS
-- já permitem ler.
alter publication supabase_realtime add table
  public.activities,
  public.activity_comments,
  public.deliveries,
  public.negotiations,
  public.contacts,
  public.companies,
  public.delivery_objectives,
  public.delivery_goals;
