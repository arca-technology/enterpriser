insert into storage.buckets (id, name, public, file_size_limit)
values ('conversation-media', 'conversation-media', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "Internal users can read conversation media" on storage.objects;
create policy "Internal users can read conversation media"
on storage.objects for select
to authenticated
using (
  bucket_id = 'conversation-media'
  and (select private.crm_current_role()) in ('admin', 'collaborator', 'developer')
);

drop policy if exists "Writers can upload conversation media" on storage.objects;
create policy "Writers can upload conversation media"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'conversation-media'
  and (select private.crm_can_write())
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Owners and admins can delete conversation media" on storage.objects;
create policy "Owners and admins can delete conversation media"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'conversation-media'
  and (
    owner_id = (select auth.uid()::text)
    or (select private.crm_current_role()) = 'admin'
  )
);
