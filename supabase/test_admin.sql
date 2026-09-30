-- ============================================================================
--  BunkSoft — tests for the platform administration layer
--
--    createdb bunksoft_admin_test
--    psql -d bunksoft_admin_test -f supabase/_local_auth_stub.sql
--    psql -d bunksoft_admin_test -f supabase/schema.sql
--    psql -d bunksoft_admin_test -f supabase/admin.sql
--    psql -d bunksoft_admin_test -f supabase/test_admin.sql
--
--  Every check raises on failure, so a clean run means every claim below held.
-- ============================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS  %', label;
  else raise exception 'FAIL  %', label; end if;
end $$;

-- Acting as a given user, the way PostgREST does it.
create or replace function pg_temp.act_as(u uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text,''), false);
end $$;

-- ---------------------------------------------------------------------------
--  1. Bootstrap
-- ---------------------------------------------------------------------------
do $$
declare v_admin uuid;
begin
  v_admin := public.bootstrap_platform_admin('admin@subsel.in','Subsel2026Admin','Avinash S');
  perform pg_temp.ok(v_admin is not null, 'bootstrap creates the first administrator');
  perform pg_temp.ok(
    (select count(*) from public.platform_admins) = 1,
    'exactly one administrator exists');
  perform pg_temp.ok(
    (select encrypted_password = crypt('Subsel2026Admin', encrypted_password)
       from auth.users where id = v_admin),
    'the administrator password verifies as bcrypt');
  perform pg_temp.ok(
    (select email_confirmed_at is not null from auth.users where id = v_admin),
    'the administrator account is pre-confirmed (no signup email)');
end $$;

-- Bootstrap must refuse a second time, or anyone could seize the console.
do $$
begin
  begin
    perform public.bootstrap_platform_admin('attacker@example.com','Attacker12345','Nope');
    raise exception 'FAIL  bootstrap ran twice';
  exception when others then
    if position('already exists' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  bootstrap refuses once an administrator exists';
  end;
end $$;

-- ---------------------------------------------------------------------------
--  2. An administrator creates a business
-- ---------------------------------------------------------------------------
do $$
declare v_admin uuid; v_res jsonb; v_owner uuid; v_bunk uuid;
begin
  select user_id into v_admin from public.platform_admins limit 1;
  perform pg_temp.act_as(v_admin);
  perform pg_temp.ok(public.is_platform_admin(), 'is_platform_admin() is true for the administrator');

  v_res := public.admin_create_business(
    'Sri Balaji Fuels', 'balaji@example.com', 'Balaji2026Fuel', 'R Balaji',
    'Indian Oil', 'Thanjavur', '9876543210', true);
  v_owner := (v_res->>'user_id')::uuid;
  v_bunk  := (v_res->>'bunk_id')::uuid;

  perform pg_temp.ok(v_owner is not null and v_bunk is not null, 'admin_create_business returns both ids');
  perform pg_temp.ok(
    (select encrypted_password = crypt('Balaji2026Fuel', encrypted_password)
       from auth.users where id = v_owner),
    'the new owner can sign in with the password the administrator set');
  perform pg_temp.ok(
    (select role = 'owner' from public.memberships where bunk_id = v_bunk and user_id = v_owner),
    'the new account owns its bunk');
  perform pg_temp.ok(
    (select count(*) = 3 from public.tanks where bunk_id = v_bunk), 'three tanks were seeded');
  perform pg_temp.ok(
    (select count(*) = 5 from public.nozzles where bunk_id = v_bunk), 'five nozzles were seeded');
  perform pg_temp.ok(
    (select full_name = 'R Balaji' from public.profiles where id = v_owner),
    'the owner profile carries the name the administrator typed');
  perform pg_temp.ok(
    (select count(*) = 1 from auth.identities where user_id = v_owner and provider = 'email'),
    'an email identity row was written alongside the user');

  -- A second business, to prove tenant separation below.
  perform public.admin_create_business(
    'Kaveri Petroleum', 'kaveri@example.com', 'Kaveri2026Pet', 'S Kumar',
    'HPCL', 'Kumbakonam', null, true);

  -- Staff for the first bunk.
  perform public.admin_create_staff(
    v_bunk, 'operator1@example.com', 'Operator2026x', 'operator', 'M Raja');
  perform pg_temp.ok(
    (select role = 'operator' from public.memberships
      where bunk_id = v_bunk and user_id = (select id from auth.users where email='operator1@example.com')),
    'staff accounts are created straight onto a bunk');
end $$;

-- Duplicate emails are refused.
do $$
declare v_admin uuid;
begin
  select user_id into v_admin from public.platform_admins limit 1;
  perform pg_temp.act_as(v_admin);
  begin
    perform public.admin_create_login('balaji@example.com','Another12345','Dup');
    raise exception 'FAIL  duplicate email accepted';
  exception when others then
    if position('already exists' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a second account on the same email is refused';
  end;
end $$;

-- Weak passwords are refused.
do $$
declare v_admin uuid;
begin
  select user_id into v_admin from public.platform_admins limit 1;
  perform pg_temp.act_as(v_admin);
  begin
    perform public.admin_create_login('weak@example.com','short1','Weak');
    raise exception 'FAIL  short password accepted';
  exception when others then
    if position('at least 10' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a password under 10 characters is refused';
  end;
  begin
    perform public.admin_create_login('weak2@example.com','allletterspass','Weak');
    raise exception 'FAIL  letters-only password accepted';
  exception when others then
    if position('letters and digits' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a password with no digits is refused';
  end;
  begin
    perform public.admin_create_login('notanemail','Valid12345678','Weak');
    raise exception 'FAIL  malformed email accepted';
  exception when others then
    if position('valid email' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a malformed email is refused';
  end;
end $$;

-- ---------------------------------------------------------------------------
--  3. A bunk owner is not an administrator
--  This is the check that matters most: an ordinary customer who finds the
--  admin console URL, signs in, and calls the API by hand gets nothing.
-- ---------------------------------------------------------------------------
do $$
declare v_owner uuid;
begin
  select id into v_owner from auth.users where email = 'balaji@example.com';
  perform pg_temp.act_as(v_owner);

  perform pg_temp.ok(not public.is_platform_admin(), 'a bunk owner is not a platform administrator');
  perform pg_temp.ok((public.admin_whoami()->>'is_admin') = 'false',
    'admin_whoami() tells the console to refuse this user');
  perform pg_temp.ok((select count(*) from public.admin_businesses()) = 0,
    'admin_businesses() returns nothing to a non-administrator');
  perform pg_temp.ok((select count(*) from public.admin_accounts()) = 0,
    'admin_accounts() returns nothing to a non-administrator');
  perform pg_temp.ok(public.admin_stats() is null,
    'admin_stats() returns nothing to a non-administrator');
  perform pg_temp.ok((select count(*) from public.admin_audit_log(100)) = 0,
    'the audit log is invisible to a non-administrator');

  begin
    perform public.admin_create_login('selfmade@example.com','Selfmade12345','Self');
    raise exception 'FAIL  a bunk owner created an account';
  exception when others then
    if position('Administrator access required' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a bunk owner cannot create an account';
  end;

  begin
    perform public.admin_create_business('Pirate Fuels','pirate@example.com','Pirate123456','P');
    raise exception 'FAIL  a bunk owner created a business';
  exception when others then
    if position('Administrator access required' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a bunk owner cannot create a business';
  end;

  begin
    perform public.admin_grant_admin('balaji@example.com');
    raise exception 'FAIL  a bunk owner promoted themselves';
  exception when others then
    if position('Administrator access required' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a bunk owner cannot promote themselves to administrator';
  end;

  begin
    perform public.admin_set_password(
      (select id from auth.users where email='admin@subsel.in'), 'Hijacked12345');
    raise exception 'FAIL  a bunk owner reset the administrator password';
  exception when others then
    if position('Administrator access required' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a bunk owner cannot reset anyone''s password';
  end;
end $$;

-- Anonymous — no JWT at all.
do $$
begin
  perform pg_temp.act_as(null);
  perform pg_temp.ok(not public.is_platform_admin(), 'a signed-out visitor is not an administrator');
  begin
    perform public.admin_create_login('anon@example.com','Anonymous1234','A');
    raise exception 'FAIL  anonymous created an account';
  exception when others then
    if position('Sign in first' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  a signed-out visitor cannot create an account';
  end;
end $$;

-- ---------------------------------------------------------------------------
--  4. Tenant isolation still holds, and admin access does not pierce it
-- ---------------------------------------------------------------------------
do $$
declare v_admin uuid; v_b1 uuid; v_b2 uuid;
begin
  select id into v_b1 from public.bunks where name = 'Sri Balaji Fuels';
  select id into v_b2 from public.bunks where name = 'Kaveri Petroleum';
  select user_id into v_admin from public.platform_admins limit 1;

  -- Give bunk 1 a day of trade, written as its own owner.
  perform pg_temp.act_as((select id from auth.users where email='balaji@example.com'));
  insert into public.business_days (bunk_id, day, opening_cash) values (v_b1, current_date, 5000);
  insert into public.expenses (bunk_id, day, head, amount) values (v_b1, current_date, 'Salaries', 3000);

  -- The other tenant sees none of it.
  perform pg_temp.act_as((select id from auth.users where email='kaveri@example.com'));
  set local role authenticated;
  perform pg_temp.ok((select count(*) from public.expenses) = 0,
    'a second bunk sees zero rows of the first bunk''s expenses');
  reset role;

  -- Neither does the administrator: RLS is not waived for them.
  perform pg_temp.act_as(v_admin);
  set local role authenticated;
  perform pg_temp.ok((select count(*) from public.expenses) = 0,
    'an administrator cannot read a customer''s expense rows');
  perform pg_temp.ok((select count(*) from public.business_days) = 0,
    'an administrator cannot read a customer''s cash figures');
  reset role;

  -- What they can see is who the customers are and how much they use it.
  perform pg_temp.ok((select count(*) from public.admin_businesses()) = 2,
    'the console lists both businesses');
  perform pg_temp.ok(
    (select days_recorded = 1 from public.admin_businesses() where name = 'Sri Balaji Fuels'),
    'the console reports usage — one business day recorded');
  perform pg_temp.ok(
    (select staff_count = 2 from public.admin_businesses() where name = 'Sri Balaji Fuels'),
    'the console reports the headcount on each bunk');
  perform pg_temp.ok(
    (select owner_email = 'balaji@example.com' from public.admin_businesses() where name = 'Sri Balaji Fuels'),
    'the console names the owner of each bunk');
end $$;

-- ---------------------------------------------------------------------------
--  5. The administration tables are unreachable through the API
-- ---------------------------------------------------------------------------
do $$
declare v_owner uuid;
begin
  select id into v_owner from auth.users where email = 'balaji@example.com';
  perform pg_temp.act_as(v_owner);
  set local role authenticated;
  begin
    perform count(*) from public.platform_admins;
    reset role;
    raise exception 'FAIL  platform_admins was readable';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  platform_admins is not readable through the API';
  end;
  set local role authenticated;
  begin
    perform count(*) from public.admin_audit;
    reset role;
    raise exception 'FAIL  admin_audit was readable';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  admin_audit is not readable through the API';
  end;
end $$;

-- Self-service bunk creation is gone: create_bunk is no longer granted.
do $$
begin
  perform pg_temp.ok(
    not has_function_privilege('authenticated', 'public.create_bunk(text,text,text,boolean)', 'execute'),
    'signed-in users can no longer call create_bunk()');
  perform pg_temp.ok(
    not has_function_privilege('anon', 'public.my_bunks()', 'execute'),
    'the anonymous role cannot call my_bunks()');
  perform pg_temp.ok(
    not has_function_privilege('anon', 'public.admin_create_business(text,text,text,text,text,text,text,boolean)', 'execute'),
    'the anonymous role cannot call admin_create_business()');
  perform pg_temp.ok(
    not has_function_privilege('authenticated', 'public.bootstrap_platform_admin(text,text,text)', 'execute'),
    'bootstrap_platform_admin() is reachable only from the SQL editor');
  perform pg_temp.ok(
    has_function_privilege('authenticated', 'public.admin_whoami()', 'execute'),
    'admin_whoami() stays callable, so the console can ask who it is talking to');
end $$;

-- ---------------------------------------------------------------------------
--  6. Suspending, resetting, deleting
-- ---------------------------------------------------------------------------
do $$
declare v_admin uuid; v_owner uuid;
begin
  select user_id into v_admin from public.platform_admins limit 1;
  select id into v_owner from auth.users where email = 'kaveri@example.com';
  perform pg_temp.act_as(v_admin);

  perform public.admin_set_suspended(v_owner, true);
  perform pg_temp.ok((select banned_until > now() from auth.users where id = v_owner),
    'suspending an account blocks its sign-in');
  perform pg_temp.ok(
    (select owner_suspended from public.admin_businesses() where name = 'Kaveri Petroleum'),
    'the console shows the business as suspended');
  perform pg_temp.ok((select count(*) from public.bunks where id in
      (select bunk_id from public.memberships where user_id = v_owner)) = 1,
    'suspension leaves the bunk and its records intact');

  perform public.admin_set_suspended(v_owner, false);
  perform pg_temp.ok((select banned_until is null from auth.users where id = v_owner),
    'reactivating clears the block');

  perform public.admin_set_password(v_owner, 'Rotated2026Pw');
  perform pg_temp.ok(
    (select encrypted_password = crypt('Rotated2026Pw', encrypted_password)
       from auth.users where id = v_owner),
    'a password reset takes effect immediately');

  -- An administrator cannot suspend or delete themselves.
  begin
    perform public.admin_set_suspended(v_admin, true);
    raise exception 'FAIL  administrator suspended themselves';
  exception when others then
    if position('your own account' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  an administrator cannot suspend their own account';
  end;

  -- Deletion needs the email typed back.
  begin
    perform public.admin_delete_account(v_owner, 'wrong@example.com');
    raise exception 'FAIL  deleted without confirmation';
  exception when others then
    if position('exactly to confirm' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  deleting an account needs its email typed back';
  end;

  -- Removing a bunk needs its name typed back.
  begin
    perform public.admin_delete_bunk(
      (select id from public.bunks where name='Kaveri Petroleum'), 'Kaveri');
    raise exception 'FAIL  deleted bunk without confirmation';
  exception when others then
    if position('exactly to confirm' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  deleting a bunk needs its name typed back';
  end;
end $$;

-- ---------------------------------------------------------------------------
--  7. Administrators managing administrators
-- ---------------------------------------------------------------------------
do $$
declare v_admin uuid; v_second uuid;
begin
  select user_id into v_admin from public.platform_admins limit 1;
  perform pg_temp.act_as(v_admin);

  v_second := public.admin_create_login('support@subsel.in','Support2026Pw','Support Desk');
  perform public.admin_grant_admin('support@subsel.in','support desk');
  perform pg_temp.ok((select count(*) from public.platform_admins) = 2, 'a second administrator can be granted');

  begin
    perform public.admin_revoke_admin(v_admin);
    raise exception 'FAIL  revoked own access';
  exception when others then
    if position('your own administrator access' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  an administrator cannot revoke their own access';
  end;

  -- One administrator cannot reset another's password.
  begin
    perform public.admin_set_password(v_second, 'Meddling2026');
    raise exception 'FAIL  reset another administrator password';
  exception when others then
    if position('their own password' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  one administrator cannot reset another administrator''s password';
  end;

  perform public.admin_revoke_admin(v_second);
  perform pg_temp.ok((select count(*) from public.platform_admins) = 1, 'administrator access can be revoked');

  -- The last administrator cannot be removed.
  perform public.admin_grant_admin('support@subsel.in');
  perform pg_temp.act_as(v_second);
  begin
    perform public.admin_revoke_admin(v_admin);
    raise notice 'PASS  a second administrator may revoke the first';
  exception when others then raise; end;
  perform pg_temp.ok((select count(*) from public.platform_admins) = 1, 'one administrator remains');
  begin
    perform public.admin_revoke_admin(v_second);
    raise exception 'FAIL  removed the last administrator';
  exception when others then
    if position('at least one administrator' in sqlerrm) = 0
       and position('your own administrator access' in sqlerrm) = 0 then raise; end if;
    raise notice 'PASS  the last administrator cannot be removed';
  end;
  -- put the original back for the audit check
  perform public.admin_grant_admin('admin@subsel.in');
end $$;

-- ---------------------------------------------------------------------------
--  8. The audit trail recorded all of it
-- ---------------------------------------------------------------------------
do $$
declare v_admin uuid; n int;
begin
  select user_id into v_admin from public.platform_admins where user_id =
    (select id from auth.users where email='admin@subsel.in');
  perform pg_temp.act_as(v_admin);
  select count(*) into n from public.admin_audit_log(500);
  perform pg_temp.ok(n >= 10, format('the audit log recorded every action (%s entries)', n));
  perform pg_temp.ok(
    exists (select 1 from public.admin_audit_log(500)
             where action = 'create_business' and target = 'Sri Balaji Fuels'),
    'creating a business is in the audit log');
  perform pg_temp.ok(
    exists (select 1 from public.admin_audit_log(500)
             where action = 'set_password' and target = 'kaveri@example.com'),
    'a password reset is in the audit log, naming who did it');
  perform pg_temp.ok(
    exists (select 1 from public.admin_audit_log(500)
             where action = 'suspend' and target = 'kaveri@example.com'),
    'a suspension is in the audit log');
  perform pg_temp.ok(
    (select actor_email = 'admin@subsel.in' from public.admin_audit_log(500)
      where action = 'create_business' and target = 'Sri Balaji Fuels'),
    'the audit log names the administrator who acted');
end $$;

do $$ begin raise notice ' '; raise notice 'All administration checks passed.'; end $$;
