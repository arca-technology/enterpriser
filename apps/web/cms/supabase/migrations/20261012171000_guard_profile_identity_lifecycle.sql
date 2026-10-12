-- User administration continues through the service-role Edge Function.
revoke insert, delete, truncate, references, trigger on public.profiles from authenticated, anon;

-- Clearing a login must not leave an avatar tied to a different auth identity.
create function private.clear_profile_avatar_on_auth_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.auth_user_id is distinct from old.auth_user_id then
    new.avatar_path := null;
  end if;
  return new;
end;
$$;
revoke all on function private.clear_profile_avatar_on_auth_change() from public, anon, authenticated;
create trigger clear_profile_avatar_on_auth_change
  before update of auth_user_id on public.profiles
  for each row execute function private.clear_profile_avatar_on_auth_change();
