alter table public.product_activity_templates add column if not exists category text;
alter table public.activities add column if not exists category text;

notify pgrst, 'reload schema';
