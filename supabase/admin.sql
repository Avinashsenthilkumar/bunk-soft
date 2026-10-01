-- ============================================================================
--  BunkSoft — Platform administration layer
--  Subsel Tech Solutions Pvt Ltd
--
--  Run this ONCE, in the Supabase SQL editor, AFTER supabase/schema.sql.
--  Safe to run again: every statement is idempotent.
--
--  What it adds
--  ------------
--  Self sign-up is gone. Nobody creates their own BunkSoft login any more.
--  A platform administrator — you, at Subsel — creates the account for each
--  bunk that buys the software, hands over the credentials, and can reset a
--  password or suspend an account later.
--
--  Why this is SQL and not a server
--  --------------------------------
--  Creating a login is normally done with Supabase's `service_role` key, which
--  bypasses every security policy. That key must never reach a browser, so the
--  admin console cannot hold it. Instead the work happens here, inside the
--  database, in `security definer` functions that check `is_platform_admin()`
--  before they do anything. The admin console stays a static page with no
--  secret in it, and an ordinary signed-in bunk owner calling these functions
--  by hand gets an exception, not an account.
--
--  What an administrator can and cannot see
--  ----------------------------------------
--  Deliberately, being a platform admin does NOT grant read access to any
--  bunk's sales, cash, credit or expense rows. Row-level security still keeps
--  every tenant sealed. The admin functions below expose only what running the
--  business of selling the software needs: who the customers are, who their
--  staff are, when they last used it and how much they use it.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
--  1. Who is an administrator
-- ============================================================================
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

comment on table public.platform_admins is
  'Subsel staff who may create and manage bunk accounts. Membership is only ever changed through admin_grant_admin / admin_revoke_admin, or from the SQL editor.';

-- Bypasses RLS on purpose: policies must be able to ask this question without
-- recursing into the table they are protecting.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- ============================================================================
--  2. Audit trail
--  Every administrative action is recorded. Nothing here can be edited or
--  deleted through the API — the table has no write policy at all, and only
--  the security-definer functions below can append to it.
-- ============================================================================
create table if not exists public.admin_audit (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      uuid references auth.users(id) on delete set null,
  actor_email text,
  action     text not null,
  target     text,
  detail     jsonb not null default '{}'::jsonb
);
create index if not exists admin_audit_at_idx on public.admin_audit(at desc);

create or replace function public.admin_log(p_action text, p_target text, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  insert into public.admin_audit (actor, actor_email, action, target, detail)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), p_action, p_target, coalesce(p_detail,'{}'::jsonb));
end $$;

-- ============================================================================
--  3. Helpers
-- ============================================================================

-- pgcrypto lives in `extensions` on Supabase and in `public` on a plain
-- Postgres, so this resolves either way. Cost 10 matches what Supabase's own
-- auth service uses — pgcrypto's default of 6 would be weaker than the
-- passwords GoTrue writes.
create or replace function public.bunksoft_hash(p_password text)
returns text language plpgsql immutable
set search_path = public, extensions, pg_temp as $$
begin
  return crypt(p_password, gen_salt('bf', 10));
end $$;

create or replace function public.bunksoft_check_password(p_password text)
returns void language plpgsql immutable set search_path = pg_temp as $$
begin
  if p_password is null or length(p_password) < 10 then
    raise exception 'Password must be at least 10 characters.';
  end if;
  if p_password !~ '[A-Za-z]' or p_password !~ '[0-9]' then
    raise exception 'Password must contain both letters and digits.';
  end if;
  if lower(p_password) in ('password12','bunksoft12','1234567890','qwerty1234') then
    raise exception 'That password is too easy to guess.';
  end if;
end $$;

create or replace function public.bunksoft_check_email(p_email text)
returns text language plpgsql immutable set search_path = pg_temp as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  if e !~ '^[^@\s]+@[^@\s.]+\.[^@\s]+$' then
    raise exception 'That is not a valid email address.';
  end if;
  return e;
end $$;

create or replace function public.require_platform_admin()
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if not public.is_platform_admin() then
    raise exception 'Administrator access required.';
  end if;
end $$;

-- ============================================================================
--  4. Creating a login
--  Writes straight into auth.users, the same table Supabase's auth service
--  reads, so the new account signs in with an ordinary email and password.
--  The account is created already confirmed — there is no signup email to
--  click, because an administrator vouched for it.
-- ============================================================================
create or replace function public.admin_create_login(
  p_email text, p_password text, p_full_name text default null, p_phone text default null
) returns uuid language plpgsql security definer
set search_path = public, auth, extensions, pg_temp as $$
declare
  v_id    uuid := gen_random_uuid();
  v_email text;
  v_meta  jsonb;
  v_has_provider_id boolean;
begin
  perform public.require_platform_admin();
  v_email := public.bunksoft_check_email(p_email);
  perform public.bunksoft_check_password(p_password);

  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'An account already exists for %.', v_email;
  end if;

  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'full_name', nullif(trim(coalesce(p_full_name,'')),''),
    'phone',     nullif(trim(coalesce(p_phone,'')),''),
    'created_by_admin', true
  ));

  -- Tells the optional signup lock in lock_signups.sql that this insert is
  -- ours. Scoped to the transaction, so it cannot leak to another statement.
  perform set_config('bunksoft.provisioning', 'on', true);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, public.bunksoft_hash(p_password),
    now(), now(), now(), null,
    '{"provider":"email","providers":["email"]}'::jsonb, v_meta,
    '', '', '', ''
  );

  -- The identities row shape changed between GoTrue versions; support both.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id'
  ) into v_has_provider_id;

  if v_has_provider_id then
    execute 'insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
             values (gen_random_uuid(), $1, $2, $3, ''email'', now(), now())'
      using v_id::text, v_id,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false);
  else
    execute 'insert into auth.identities (id, user_id, identity_data, provider, created_at, updated_at)
             values ($1, $2, $3, ''email'', now(), now())'
      using v_id::text, v_id,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false);
  end if;

  -- schema.sql's on_auth_user_created trigger writes public.profiles, but be
  -- explicit in case that trigger is ever dropped.
  insert into public.profiles (id, full_name, phone)
  values (v_id, coalesce(nullif(trim(coalesce(p_full_name,'')),''), split_part(v_email,'@',1)),
          nullif(trim(coalesce(p_phone,'')),''))
  on conflict (id) do update set
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    phone     = coalesce(excluded.phone, public.profiles.phone);

  perform public.admin_log('create_login', v_email, jsonb_build_object('user_id', v_id, 'name', p_full_name));
  return v_id;
end $$;

-- ============================================================================
--  5. Creating a business
--  One call: the owner's login, their bunk, and the seeded tanks and nozzles.
--  This is what "add a customer" means in the admin console.
-- ============================================================================
create or replace function public.admin_create_business(
  p_bunk_name  text,
  p_email      text,
  p_password   text,
  p_owner_name text default null,
  p_brand      text default null,
  p_place      text default null,
  p_phone      text default null,
  p_seed       boolean default true
) returns jsonb language plpgsql security definer
set search_path = public, auth, pg_temp as $$
declare
  v_user uuid; v_bunk uuid;
  p_ms uuid; p_hsd uuid; p_xp uuid; t1 uuid; t2 uuid; t3 uuid;
begin
  perform public.require_platform_admin();
  if coalesce(trim(p_bunk_name),'') = '' then
    raise exception 'The bunk needs a name.';
  end if;

  v_user := public.admin_create_login(p_email, p_password, p_owner_name, p_phone);

  insert into public.bunks (name, brand, place, created_by)
  values (trim(p_bunk_name),
          nullif(trim(coalesce(p_brand,'')),''),
          nullif(trim(coalesce(p_place,'')),''),
          v_user)
  returning id into v_bunk;

  insert into public.memberships (bunk_id, user_id, role) values (v_bunk, v_user, 'owner');

  if p_seed then
    insert into public.products (bunk_id, code, name, short_name, sell_rate, buy_rate, sort_order)
    values (v_bunk,'ms','Petrol','MS',0,0,1) returning id into p_ms;
    insert into public.products (bunk_id, code, name, short_name, sell_rate, buy_rate, sort_order)
    values (v_bunk,'hsd','Diesel','HSD',0,0,2) returning id into p_hsd;
    insert into public.products (bunk_id, code, name, short_name, sell_rate, buy_rate, sort_order)
    values (v_bunk,'xp','XP-95 Premium','XP95',0,0,3) returning id into p_xp;

    insert into public.tanks (bunk_id, name, product_id, capacity, current_stock, min_level, sort_order)
    values (v_bunk,'Tank 1',p_ms,12000,0,1500,1) returning id into t1;
    insert into public.tanks (bunk_id, name, product_id, capacity, current_stock, min_level, sort_order)
    values (v_bunk,'Tank 2',p_hsd,20000,0,2500,2) returning id into t2;
    insert into public.tanks (bunk_id, name, product_id, capacity, current_stock, min_level, sort_order)
    values (v_bunk,'Tank 3',p_xp,6000,0,800,3) returning id into t3;

    insert into public.nozzles (bunk_id, name, product_id, tank_id, sort_order) values
      (v_bunk,'DU-1 / N1',p_ms,t1,1),
      (v_bunk,'DU-1 / N2',p_hsd,t2,2),
      (v_bunk,'DU-2 / N3',p_ms,t1,3),
      (v_bunk,'DU-2 / N4',p_hsd,t2,4),
      (v_bunk,'DU-3 / N5',p_xp,t3,5);
  end if;

  perform public.admin_log('create_business', trim(p_bunk_name),
    jsonb_build_object('bunk_id', v_bunk, 'owner', lower(trim(p_email)), 'user_id', v_user));

  return jsonb_build_object('user_id', v_user, 'bunk_id', v_bunk,
                            'email', lower(trim(p_email)), 'bunk', trim(p_bunk_name));
end $$;

-- Add a staff login to an existing bunk, in one step.
create or replace function public.admin_create_staff(
  p_bunk uuid, p_email text, p_password text, p_role public.member_role,
  p_full_name text default null, p_phone text default null
) returns jsonb language plpgsql security definer
set search_path = public, auth, pg_temp as $$
declare v_user uuid; v_name text;
begin
  perform public.require_platform_admin();
  select name into v_name from public.bunks where id = p_bunk;
  if v_name is null then raise exception 'No such bunk.'; end if;

  v_user := public.admin_create_login(p_email, p_password, p_full_name, p_phone);
  insert into public.memberships (bunk_id, user_id, role) values (p_bunk, v_user, p_role)
  on conflict (bunk_id, user_id) do update set role = excluded.role;

  perform public.admin_log('create_staff', lower(trim(p_email)),
    jsonb_build_object('bunk_id', p_bunk, 'bunk', v_name, 'role', p_role, 'user_id', v_user));
  return jsonb_build_object('user_id', v_user, 'email', lower(trim(p_email)), 'bunk', v_name, 'role', p_role);
end $$;

-- ============================================================================
--  6. Managing accounts that already exist
-- ============================================================================
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns boolean language plpgsql security definer
set search_path = public, auth, extensions, pg_temp as $$
declare v_email text;
begin
  perform public.require_platform_admin();
  perform public.bunksoft_check_password(p_password);
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'No such account.'; end if;
  if exists (select 1 from public.platform_admins where user_id = p_user) and p_user <> auth.uid() then
    raise exception 'Another administrator must change their own password.';
  end if;

  update auth.users
     set encrypted_password = public.bunksoft_hash(p_password),
         updated_at = now()
   where id = p_user;

  perform public.admin_log('set_password', v_email, jsonb_build_object('user_id', p_user));
  return true;
end $$;

-- Suspending an account leaves every record intact and blocks the login.
-- Supabase's auth service refuses a sign-in while banned_until is in the future.
create or replace function public.admin_set_suspended(p_user uuid, p_suspended boolean)
returns boolean language plpgsql security definer
set search_path = public, auth, pg_temp as $$
declare v_email text;
begin
  perform public.require_platform_admin();
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'No such account.'; end if;
  if p_user = auth.uid() then raise exception 'You cannot suspend your own account.'; end if;
  if p_suspended and exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'Remove administrator access before suspending that account.';
  end if;

  update auth.users
     set banned_until = case when p_suspended then 'infinity'::timestamptz else null end,
         updated_at = now()
   where id = p_user;

  perform public.admin_log(case when p_suspended then 'suspend' else 'reactivate' end,
                       v_email, jsonb_build_object('user_id', p_user));
  return true;
end $$;

-- Deleting the login removes their access. Bunk records survive, because
-- memberships cascade but bunks do not — an owner can be replaced.
create or replace function public.admin_delete_account(p_user uuid, p_confirm_email text)
returns boolean language plpgsql security definer
set search_path = public, auth, pg_temp as $$
declare v_email text;
begin
  perform public.require_platform_admin();
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'No such account.'; end if;
  if lower(trim(coalesce(p_confirm_email,''))) <> lower(v_email) then
    raise exception 'Type the account email exactly to confirm deletion.';
  end if;
  if p_user = auth.uid() then raise exception 'You cannot delete your own account.'; end if;
  if exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'Revoke administrator access before deleting that account.';
  end if;

  perform public.admin_log('delete_account', v_email, jsonb_build_object('user_id', p_user));
  delete from auth.users where id = p_user;
  return true;
end $$;

create or replace function public.admin_set_member(p_bunk uuid, p_user uuid, p_role public.member_role)
returns boolean language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_email text; v_bunk text;
begin
  perform public.require_platform_admin();
  select email into v_email from auth.users where id = p_user;
  select name  into v_bunk  from public.bunks where id = p_bunk;
  if v_email is null or v_bunk is null then raise exception 'No such account or bunk.'; end if;

  insert into public.memberships (bunk_id, user_id, role) values (p_bunk, p_user, p_role)
  on conflict (bunk_id, user_id) do update set role = excluded.role;

  perform public.admin_log('set_member', v_email, jsonb_build_object('bunk', v_bunk, 'bunk_id', p_bunk, 'role', p_role));
  return true;
end $$;

create or replace function public.admin_remove_member(p_bunk uuid, p_user uuid)
returns boolean language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_email text; v_bunk text;
begin
  perform public.require_platform_admin();
  select email into v_email from auth.users where id = p_user;
  select name  into v_bunk  from public.bunks where id = p_bunk;
  delete from public.memberships where bunk_id = p_bunk and user_id = p_user;
  perform public.admin_log('remove_member', coalesce(v_email,p_user::text),
                       jsonb_build_object('bunk', v_bunk, 'bunk_id', p_bunk));
  return true;
end $$;

-- Removing a bunk destroys its entire history, so the caller must type the
-- name back. There is no undo.
create or replace function public.admin_delete_bunk(p_bunk uuid, p_confirm_name text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  perform public.require_platform_admin();
  select name into v_name from public.bunks where id = p_bunk;
  if v_name is null then raise exception 'No such bunk.'; end if;
  if lower(trim(coalesce(p_confirm_name,''))) <> lower(v_name) then
    raise exception 'Type the bunk name exactly to confirm deletion.';
  end if;

  perform public.admin_log('delete_bunk', v_name, jsonb_build_object('bunk_id', p_bunk));
  delete from public.bunks where id = p_bunk;
  return true;
end $$;

-- ============================================================================
--  7. What the console shows
--  Usage, not money. An administrator can see that a bunk is active and how
--  heavily it is used, and cannot read a single rupee of its trade.
-- ============================================================================
create or replace function public.admin_businesses()
returns table (
  bunk_id uuid, name text, brand text, place text, created_at timestamptz,
  owner_name text, owner_email text, owner_id uuid, owner_suspended boolean,
  staff_count int, days_recorded int, shifts_recorded int, last_activity timestamptz
) language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    b.id, b.name, b.brand, b.place, b.created_at,
    p.full_name, u.email, u.id,
    coalesce(u.banned_until > now(), false),
    (select count(*)::int from public.memberships m where m.bunk_id = b.id),
    (select count(*)::int from public.business_days d where d.bunk_id = b.id),
    (select count(*)::int from public.shifts s where s.bunk_id = b.id),
    greatest(
      (select max(d.updated_at) from public.business_days d where d.bunk_id = b.id),
      (select max(s.updated_at) from public.shifts s where s.bunk_id = b.id),
      b.created_at
    )
  from public.bunks b
  left join public.memberships om
         on om.bunk_id = b.id and om.role = 'owner'
        and om.created_at = (select min(m2.created_at) from public.memberships m2
                              where m2.bunk_id = b.id and m2.role = 'owner')
  left join auth.users u on u.id = om.user_id
  left join public.profiles p on p.id = om.user_id
  where public.is_platform_admin()
  order by b.created_at desc;
$$;

create or replace function public.admin_accounts()
returns table (
  user_id uuid, email text, full_name text, phone text,
  created_at timestamptz, last_sign_in_at timestamptz,
  confirmed boolean, suspended boolean, is_admin boolean, bunks jsonb
) language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    u.id, u.email, p.full_name, p.phone,
    u.created_at, u.last_sign_in_at,
    u.email_confirmed_at is not null,
    coalesce(u.banned_until > now(), false),
    exists (select 1 from public.platform_admins a where a.user_id = u.id),
    coalesce((
      select jsonb_agg(jsonb_build_object('bunk_id', b.id, 'name', b.name, 'role', m.role)
                       order by b.name)
      from public.memberships m join public.bunks b on b.id = m.bunk_id
      where m.user_id = u.id
    ), '[]'::jsonb)
  from auth.users u
  left join public.profiles p on p.id = u.id
  where public.is_platform_admin()
  order by u.created_at desc;
$$;

create or replace function public.admin_stats()
returns jsonb language sql stable security definer set search_path = public, auth, pg_temp as $$
  select case when not public.is_platform_admin() then null else jsonb_build_object(
    'businesses',        (select count(*) from public.bunks),
    'accounts',          (select count(*) from auth.users),
    'suspended',         (select count(*) from auth.users where banned_until > now()),
    'admins',            (select count(*) from public.platform_admins),
    'active_this_week',  (select count(distinct bunk_id) from public.shifts
                           where updated_at > now() - interval '7 days'),
    'shifts_this_week',  (select count(*) from public.shifts
                           where updated_at > now() - interval '7 days'),
    'signed_up_today',   (select count(*) from auth.users where created_at::date = current_date)
  ) end;
$$;

create or replace function public.admin_audit_log(p_limit int default 200)
returns table (at timestamptz, actor_email text, action text, target text, detail jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.at, a.actor_email, a.action, a.target, a.detail
  from public.admin_audit a
  where public.is_platform_admin()
  order by a.at desc
  limit greatest(1, least(coalesce(p_limit,200), 1000));
$$;

-- ============================================================================
--  8. Administrators managing administrators
-- ============================================================================
create or replace function public.admin_grant_admin(p_email text, p_note text default null)
returns boolean language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_id uuid; v_email text;
begin
  perform public.require_platform_admin();
  v_email := public.bunksoft_check_email(p_email);
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    raise exception 'No BunkSoft account for %. Create the login first, then grant it.', v_email;
  end if;
  insert into public.platform_admins (user_id, note, created_by)
  values (v_id, p_note, auth.uid())
  on conflict (user_id) do update set note = coalesce(excluded.note, public.platform_admins.note);
  perform public.admin_log('grant_admin', v_email, jsonb_build_object('user_id', v_id));
  return true;
end $$;

create or replace function public.admin_revoke_admin(p_user uuid)
returns boolean language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_email text;
begin
  perform public.require_platform_admin();
  if p_user = auth.uid() then
    raise exception 'You cannot revoke your own administrator access. Ask another administrator.';
  end if;
  if (select count(*) from public.platform_admins) <= 1 then
    raise exception 'There must always be at least one administrator.';
  end if;
  select email into v_email from auth.users where id = p_user;
  delete from public.platform_admins where user_id = p_user;
  perform public.admin_log('revoke_admin', coalesce(v_email, p_user::text), jsonb_build_object('user_id', p_user));
  return true;
end $$;

-- Am I an administrator? The console asks this immediately after sign-in, and
-- shows nothing at all unless the answer is yes.
create or replace function public.admin_whoami()
returns jsonb language sql stable security definer set search_path = public, auth, pg_temp as $$
  select jsonb_build_object(
    'user_id',  auth.uid(),
    'email',    (select email from auth.users where id = auth.uid()),
    'name',     (select full_name from public.profiles where id = auth.uid()),
    'is_admin', public.is_platform_admin()
  );
$$;

-- ============================================================================
--  9. Bootstrap — the very first administrator
--  Only callable from the SQL editor (see the grants below), and only while
--  no administrator exists, so it cannot be used to seize the console later.
--
--  Run this once, with your own details:
--
--    select public.bootstrap_platform_admin(
--      'admin@subsel.in', 'ChangeThisNow2026', 'Avinash S');
--
--  Then sign in at /admin/ and change that password immediately.
-- ============================================================================
create or replace function public.bootstrap_platform_admin(
  p_email text, p_password text, p_full_name text default null
) returns uuid language plpgsql security definer
set search_path = public, auth, extensions, pg_temp as $$
declare v_id uuid; v_email text; v_has_provider_id boolean;
begin
  if (select count(*) from public.platform_admins) > 0 then
    raise exception 'An administrator already exists. Use admin_grant_admin instead.';
  end if;
  v_email := public.bunksoft_check_email(p_email);
  perform public.bunksoft_check_password(p_password);

  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    v_id := gen_random_uuid();
    perform set_config('bunksoft.provisioning', 'on', true);
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      v_email, public.bunksoft_hash(p_password), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', coalesce(nullif(trim(coalesce(p_full_name,'')),''), 'Administrator')),
      '', '', '', ''
    );
    select exists (select 1 from information_schema.columns
      where table_schema='auth' and table_name='identities' and column_name='provider_id')
      into v_has_provider_id;
    if v_has_provider_id then
      execute 'insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
               values (gen_random_uuid(), $1, $2, $3, ''email'', now(), now())'
        using v_id::text, v_id,
              jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false);
    else
      execute 'insert into auth.identities (id, user_id, identity_data, provider, created_at, updated_at)
               values ($1, $2, $3, ''email'', now(), now())'
        using v_id::text, v_id,
              jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false);
    end if;
    insert into public.profiles (id, full_name)
    values (v_id, coalesce(nullif(trim(coalesce(p_full_name,'')),''), 'Administrator'))
    on conflict (id) do nothing;
  else
    -- The account exists already: promote it and set the password given here.
    update auth.users set encrypted_password = public.bunksoft_hash(p_password),
                          email_confirmed_at = coalesce(email_confirmed_at, now()),
                          banned_until = null, updated_at = now()
     where id = v_id;
  end if;

  insert into public.platform_admins (user_id, note) values (v_id, 'bootstrap')
  on conflict (user_id) do nothing;

  insert into public.admin_audit (actor, actor_email, action, target, detail)
  values (v_id, v_email, 'bootstrap_admin', v_email, jsonb_build_object('user_id', v_id));

  return v_id;
end $$;

-- ============================================================================
--  10. Row-level security on the new tables
--  Neither table is readable or writable through the API. Everything goes
--  through the functions above, which check who is asking.
-- ============================================================================
alter table public.platform_admins enable row level security;
alter table public.admin_audit     enable row level security;

drop policy if exists platform_admins_none on public.platform_admins;
drop policy if exists admin_audit_none     on public.admin_audit;
-- No policy at all means no row passes. Stated explicitly so a later reader
-- does not mistake the absence for an oversight.
revoke all on public.platform_admins from anon, authenticated;
revoke all on public.admin_audit     from anon, authenticated;
revoke all on sequence public.admin_audit_id_seq from anon, authenticated;

-- ============================================================================
--  11. Function grants
--  Postgres grants EXECUTE on a new function to PUBLIC, which on Supabase
--  includes the anonymous role. Close that, then hand back only what each
--  role actually needs.
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
  end loop;
end $$;

-- Signed-in users get the application's own functions back.
grant execute on function public.my_bunks()                                    to authenticated;
grant execute on function public.add_member(uuid, text, public.member_role)     to authenticated;
grant execute on function public.user_bunks()                                   to authenticated;
grant execute on function public.is_bunk_member(uuid)                           to authenticated;
grant execute on function public.has_bunk_role(uuid, public.member_role[])      to authenticated;

-- create_bunk stays available to the service role only: bunks are now created
-- by an administrator, never by whoever happens to be signed in.
revoke execute on function public.create_bunk(text, text, text, boolean) from authenticated;

-- Administrative functions: callable by any signed-in user, and each one
-- refuses unless the caller is in platform_admins. That is deliberate — the
-- check belongs in the function, where it cannot be bypassed by calling the
-- REST API directly.
grant execute on function public.admin_whoami()                                        to authenticated;
grant execute on function public.is_platform_admin()                                   to authenticated;
grant execute on function public.admin_businesses()                                    to authenticated;
grant execute on function public.admin_accounts()                                      to authenticated;
grant execute on function public.admin_stats()                                         to authenticated;
grant execute on function public.admin_audit_log(int)                                  to authenticated;
grant execute on function public.admin_create_login(text, text, text, text)            to authenticated;
grant execute on function public.admin_create_business(text, text, text, text, text, text, text, boolean) to authenticated;
grant execute on function public.admin_create_staff(uuid, text, text, public.member_role, text, text)     to authenticated;
grant execute on function public.admin_set_password(uuid, text)                        to authenticated;
grant execute on function public.admin_set_suspended(uuid, boolean)                    to authenticated;
grant execute on function public.admin_delete_account(uuid, text)                      to authenticated;
grant execute on function public.admin_set_member(uuid, uuid, public.member_role)      to authenticated;
grant execute on function public.admin_remove_member(uuid, uuid)                       to authenticated;
grant execute on function public.admin_delete_bunk(uuid, text)                         to authenticated;
grant execute on function public.admin_grant_admin(text, text)                         to authenticated;
grant execute on function public.admin_revoke_admin(uuid)                              to authenticated;

-- Internal helpers stay unreachable from the API.
revoke execute on function public.require_platform_admin()                  from authenticated;
revoke execute on function public.admin_log(text, text, jsonb)                  from authenticated;
revoke execute on function public.bunksoft_hash(text)                       from authenticated;
revoke execute on function public.bootstrap_platform_admin(text, text, text) from authenticated;

-- Future functions should not be world-executable either.
alter default privileges in schema public revoke execute on functions from public;

-- ============================================================================
--  12. Hardening the role model
--
--  Three defects found in a later audit of schema.sql, fixed here so an
--  existing deployment only has to re-run this file.
--
--  (a) A member could not see a colleague's name. The profiles policy was
--      `using (id = auth.uid())` for every operation, so Settings → Team
--      showed a dash against everyone and sat on "Loading the team…".
--
--  (b) A MANAGER could promote themselves to owner. add_member() refused it,
--      but the memberships policy granted managers `for all`, so a direct
--      PostgREST call — which is all a browser console needs — went straight
--      through.
--
--  (c) A manager could then delete the owner's membership and lock the owner
--      out of their own bunk. Together, (b) and (c) let a manager take over
--      a bunk completely.
-- ============================================================================

-- --- (a) you may read the profile of someone you share a bunk with ---------
create or replace function public.shares_bunk_with(u uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.memberships m1
    join public.memberships m2 on m1.bunk_id = m2.bunk_id
    where m1.user_id = auth.uid() and m2.user_id = u
  );
$$;

drop policy if exists profiles_self on public.profiles;
drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_write on public.profiles;

-- Read: yourself, and anyone on a bunk you belong to. Nothing wider — a name
-- and a phone number are not public just because two people use the software.
create policy profiles_read on public.profiles
  for select using (id = auth.uid() or public.shares_bunk_with(id));

-- Write: only ever your own row.
create policy profiles_write on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- --- (b) and (c) a manager may not touch an owner --------------------------
drop policy if exists memberships_write on public.memberships;

-- The rule, in one place: an owner may do anything to this bunk's team; a
-- manager may do anything that neither creates nor touches an owner.
create or replace function public.can_manage_membership(b uuid, target_role public.member_role)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_bunk_role(b, array['owner']::public.member_role[])
      or (public.has_bunk_role(b, array['manager']::public.member_role[])
          and target_role <> 'owner');
$$;

create policy memberships_insert on public.memberships
  for insert with check (public.can_manage_membership(bunk_id, role));

-- Both sides are checked: `using` is the row as it stands, `with check` the
-- row as it would become. A manager can therefore neither edit an owner's row
-- nor promote anyone into one.
create policy memberships_update on public.memberships
  for update using (public.can_manage_membership(bunk_id, role))
         with check (public.can_manage_membership(bunk_id, role));

create policy memberships_delete on public.memberships
  for delete using (public.can_manage_membership(bunk_id, role));

-- --- a bunk always keeps at least one owner --------------------------------
create or replace function public.guard_last_owner()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid; others int;
begin
  b := coalesce(old.bunk_id, new.bunk_id);

  -- The bunk itself is being deleted and these rows are cascading with it.
  if not exists (select 1 from public.bunks where id = b) then
    return coalesce(new, old);
  end if;

  -- Only the removal or demotion of an owner can leave a bunk ownerless.
  if old.role <> 'owner' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then return new; end if;

  select count(*) into others
  from public.memberships
  where bunk_id = b and role = 'owner' and user_id <> old.user_id;

  if others = 0 then
    raise exception 'A bunk must always have at least one owner. Appoint another owner first.'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists memberships_keep_owner on public.memberships;
create trigger memberships_keep_owner
  before update or delete on public.memberships
  for each row execute function public.guard_last_owner();

revoke execute on function public.can_manage_membership(uuid, public.member_role) from public, anon;
revoke execute on function public.guard_last_owner() from public, anon, authenticated;
grant execute on function public.shares_bunk_with(uuid) to authenticated;

-- Deleting the only owner of a bunk would strand it, and the trigger above
-- would refuse halfway through. Say so before anything is removed.
create or replace function public.admin_delete_account(p_user uuid, p_confirm_email text)
returns boolean language plpgsql security definer
set search_path = public, auth, pg_temp as $$
declare v_email text; v_stranded text;
begin
  perform public.require_platform_admin();
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'No such account.'; end if;
  if lower(trim(coalesce(p_confirm_email,''))) <> lower(v_email) then
    raise exception 'Type the account email exactly to confirm deletion.';
  end if;
  if p_user = auth.uid() then raise exception 'You cannot delete your own account.'; end if;
  if exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'Revoke administrator access before deleting that account.';
  end if;

  select string_agg(b.name, ', ' order by b.name) into v_stranded
  from public.memberships m
  join public.bunks b on b.id = m.bunk_id
  where m.user_id = p_user and m.role = 'owner'
    and not exists (
      select 1 from public.memberships m2
      where m2.bunk_id = m.bunk_id and m2.role = 'owner' and m2.user_id <> p_user);
  if v_stranded is not null then
    raise exception 'This account is the only owner of: %. Give those bunks another owner first, or remove the bunk.', v_stranded;
  end if;

  perform public.admin_log('delete_account', v_email, jsonb_build_object('user_id', p_user));
  delete from auth.users where id = p_user;
  return true;
end $$;
grant execute on function public.admin_delete_account(uuid, text) to authenticated;

-- ============================================================================
--  13. Final sweep
--  Nothing in BunkSoft is meant to be callable before signing in. Functions
--  added after section 11 keep Postgres's default grant to PUBLIC, so this
--  runs last and shuts the anonymous role out of the whole schema — including
--  anything a future migration adds and forgets to lock down.
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    -- from public as well as anon: the anonymous role reaches a function
    -- through Postgres's default PUBLIC grant, so revoking from anon alone
    -- leaves it wide open. Explicit grants to authenticated survive this.
    execute format('revoke all on function %s from public, anon', r.sig);
  end loop;
end $$;

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke usage on schema public from anon;

-- ============================================================================
--  14. Disabling a business
--
--  Suspending an OWNER blocks one login. Disabling a BUSINESS shuts the whole
--  bunk: nobody on it — owner, manager or operator — can read or write a
--  single row while it is off. Nothing is deleted, and one click puts it back.
--
--  That is what a software vendor actually needs when an invoice goes unpaid,
--  and it is why the console has no "remove the bunk" button. Deleting a bunk
--  destroys its whole trading history; admin_delete_bunk() still exists for
--  the rare case, but it lives in SQL where it cannot be hit by accident.
-- ============================================================================
alter table public.bunks add column if not exists disabled_at timestamptz;
comment on column public.bunks.disabled_at is
  'Null while the bunk is live. Set, and every member loses access to its data until it is cleared.';

-- The access check every data table already goes through. Adding the bunk's
-- own state here means one change disables sales, stock, credit, expenses,
-- cash and settings at once — there is no table to forget.
create or replace function public.is_bunk_member(b uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.memberships m
    join public.bunks bk on bk.id = m.bunk_id
    where m.bunk_id = b and m.user_id = auth.uid() and bk.disabled_at is null
  );
$$;

create or replace function public.has_bunk_role(b uuid, roles public.member_role[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.memberships m
    join public.bunks bk on bk.id = m.bunk_id
    where m.bunk_id = b and m.user_id = auth.uid() and m.role = any(roles)
      and bk.disabled_at is null
  );
$$;

-- The bunk row and the team list stay readable even when disabled, so the app
-- can say plainly what has happened instead of showing an empty screen.
create or replace function public.is_bunk_member_any(b uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m
                  where m.bunk_id = b and m.user_id = auth.uid());
$$;

drop policy if exists bunks_read on public.bunks;
create policy bunks_read on public.bunks
  for select using (public.is_bunk_member_any(id));

drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships
  for select using (public.is_bunk_member_any(bunk_id));

-- my_bunks() gains a flag, so the sign-in screen can explain rather than
-- silently show nothing. Dropped first: the return type changes.
drop function if exists public.my_bunks();
create or replace function public.my_bunks()
returns table (id uuid, name text, brand text, place text,
               role public.member_role, disabled boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.name, b.brand, b.place, m.role, (b.disabled_at is not null)
  from public.bunks b
  join public.memberships m on m.bunk_id = b.id
  where m.user_id = auth.uid()
  order by b.created_at;
$$;

create or replace function public.admin_set_bunk_disabled(p_bunk uuid, p_disabled boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  perform public.require_platform_admin();
  select name into v_name from public.bunks where id = p_bunk;
  if v_name is null then raise exception 'No such bunk.'; end if;

  update public.bunks
     set disabled_at = case when p_disabled then now() else null end
   where id = p_bunk;

  perform public.admin_log(case when p_disabled then 'disable_bunk' else 'enable_bunk' end,
                           v_name, jsonb_build_object('bunk_id', p_bunk));
  return true;
end $$;

-- admin_businesses() reports the state. Dropped first: the return type changes.
drop function if exists public.admin_businesses();
create or replace function public.admin_businesses()
returns table (
  bunk_id uuid, name text, brand text, place text, created_at timestamptz,
  owner_name text, owner_email text, owner_id uuid, owner_suspended boolean,
  disabled boolean, staff_count int, days_recorded int, shifts_recorded int,
  last_activity timestamptz
) language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    b.id, b.name, b.brand, b.place, b.created_at,
    p.full_name, u.email, u.id,
    coalesce(u.banned_until > now(), false),
    (b.disabled_at is not null),
    (select count(*)::int from public.memberships m where m.bunk_id = b.id),
    (select count(*)::int from public.business_days d where d.bunk_id = b.id),
    (select count(*)::int from public.shifts s where s.bunk_id = b.id),
    greatest(
      (select max(d.updated_at) from public.business_days d where d.bunk_id = b.id),
      (select max(s.updated_at) from public.shifts s where s.bunk_id = b.id),
      b.created_at
    )
  from public.bunks b
  left join public.memberships om
         on om.bunk_id = b.id and om.role = 'owner'
        and om.created_at = (select min(m2.created_at) from public.memberships m2
                              where m2.bunk_id = b.id and m2.role = 'owner')
  left join auth.users u on u.id = om.user_id
  left join public.profiles p on p.id = om.user_id
  where public.is_platform_admin()
  order by b.created_at desc;
$$;

create or replace function public.admin_stats()
returns jsonb language sql stable security definer set search_path = public, auth, pg_temp as $$
  select case when not public.is_platform_admin() then null else jsonb_build_object(
    'businesses',        (select count(*) from public.bunks),
    'disabled_bunks',    (select count(*) from public.bunks where disabled_at is not null),
    'accounts',          (select count(*) from auth.users),
    'suspended',         (select count(*) from auth.users where banned_until > now()),
    'admins',            (select count(*) from public.platform_admins),
    'active_this_week',  (select count(distinct bunk_id) from public.shifts
                           where updated_at > now() - interval '7 days'),
    'shifts_this_week',  (select count(*) from public.shifts
                           where updated_at > now() - interval '7 days'),
    'signed_up_today',   (select count(*) from auth.users where created_at::date = current_date)
  ) end;
$$;

grant execute on function public.my_bunks()                              to authenticated;
grant execute on function public.is_bunk_member_any(uuid)                to authenticated;
grant execute on function public.admin_businesses()                      to authenticated;
grant execute on function public.admin_stats()                           to authenticated;
grant execute on function public.admin_set_bunk_disabled(uuid, boolean)  to authenticated;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  loop execute format('revoke all on function %s from public, anon', r.sig); end loop;
end $$;
