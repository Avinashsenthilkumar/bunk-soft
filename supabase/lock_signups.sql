-- ============================================================================
--  BunkSoft — hard lock on self sign-up  (optional, recommended)
--  Subsel Tech Solutions Pvt Ltd
--
--  Run AFTER schema.sql and admin.sql.
--
--  Removing the "Create an account" button hides self sign-up. Turning off
--  "Allow new users to sign up" in the Supabase dashboard stops it. This file
--  is the third layer: a database trigger that refuses ANY new row in
--  auth.users unless it came from admin_create_login() or
--  bootstrap_platform_admin().
--
--  Why bother, if the dashboard toggle already does the job? Because the
--  toggle is a setting someone can flip back by accident, and the signup
--  endpoint is public — anybody who reads the JavaScript knows the project URL
--  and the anon key. With this trigger in place, a POST to /auth/v1/signup
--  fails at the last possible moment, in the database, whatever the dashboard
--  says.
--
--  What it blocks, so nothing surprises you later:
--    - self sign-up through the app or a hand-made API call    (the point)
--    - "Invite user" and "Add user" in the Supabase dashboard  (use the
--      admin console, or the escape hatch at the bottom of this file)
--    - creating users with the service_role Admin API          (same)
--
--  What it does NOT touch: signing in, password resets, session refresh,
--  changing an email, or anything a bunk does day to day.
--
--  To undo it:  drop trigger bunksoft_block_signup on auth.users;
-- ============================================================================

create or replace function public.bunksoft_guard_signup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- admin_create_login() and bootstrap_platform_admin() set this flag for the
  -- duration of their transaction. Nothing else does.
  if coalesce(current_setting('bunksoft.provisioning', true), '') = 'on' then
    return new;
  end if;

  -- An escape hatch for the SQL editor and for migrations, where you are
  -- already the database superuser and could bypass the trigger anyway.
  if coalesce(current_setting('bunksoft.allow_direct_signup', true), '') = 'on' then
    return new;
  end if;

  raise exception
    'BunkSoft accounts are created by an administrator. Self sign-up is disabled.'
    using errcode = 'check_violation',
          hint = 'Ask Subsel Tech Solutions to create the account, or use the admin console at /admin/.';
end $$;

drop trigger if exists bunksoft_block_signup on auth.users;
create trigger bunksoft_block_signup
  before insert on auth.users
  for each row execute function public.bunksoft_guard_signup();

revoke execute on function public.bunksoft_guard_signup() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
--  Escape hatch — creating a user by hand from the SQL editor
--
--    begin;
--      set local bunksoft.allow_direct_signup = 'on';
--      -- ... your insert into auth.users, or a service_role Admin API call
--      --     made from inside this transaction ...
--    commit;
--
--  For the ordinary case, prefer the admin console, or:
--
--    select public.admin_create_business(
--      'Sri Balaji Fuels', 'owner@example.com', 'ChooseAStrongOne2026',
--      'R Balaji', 'Indian Oil', 'Thanjavur');
-- ----------------------------------------------------------------------------
