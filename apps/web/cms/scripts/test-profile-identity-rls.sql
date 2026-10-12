-- Read-only checks. No customer writes or deletions.
select jsonb_build_object(
  'photo_editable', has_column_privilege('authenticated','public.profiles','avatar_path','UPDATE'),
  'role_protected', not has_column_privilege('authenticated','public.profiles','role','UPDATE'),
  'permissions_protected', not has_column_privilege('authenticated','public.profiles','permissions','UPDATE'),
  'scope_protected', not has_column_privilege('authenticated','public.profiles','company_ids','UPDATE'),
  'auth_identity_protected', not has_column_privilege('authenticated','public.profiles','auth_user_id','UPDATE'),
  'profile_delete_protected', not has_table_privilege('authenticated','public.profiles','DELETE'),
  'private_images', exists(select 1 from storage.buckets where id='crm-identity-assets' and not public and file_size_limit=1048576 and allowed_mime_types=array['image/webp']),
  'workspace_rls', (select relrowsecurity from pg_class where oid='public.crm_workspace_settings'::regclass),
  'auth_removal_guard', exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgname='clear_profile_avatar_on_auth_change'),
  'no_test_users_left', not exists(select 1 from auth.users where id in ('8baeb7cf-168e-4e83-9b70-6f028c124ca1','8baeb7cf-168e-4e83-9b70-6f028c124ca2')),
  'no_test_profiles_left', not exists(select 1 from public.profiles where id in ('a6837409-16df-4309-8e07-fdc5e4ca98c1','a6837409-16df-4309-8e07-fdc5e4ca98c2'))
) as identity_security_checks;
