-- ============================================================================
--  BunkSoft — regression checks for supabase/fixes.sql
--  Subsel Tech Solutions Pvt Ltd
--
--  Run against a scratch database, never a live one:
--
--    createdb bunksoft_test
--    psql -d bunksoft_test -f supabase/_local_auth_stub.sql   # local only
--    psql -d bunksoft_test -f supabase/schema.sql
--    psql -d bunksoft_test -f supabase/admin.sql
--    psql -d bunksoft_test -f supabase/fixes.sql
--    psql -d bunksoft_test -f supabase/test_fixes.sql
--
--  Every check prints PASS or FAIL. One FAIL line means the fix it names has
--  regressed.
-- ============================================================================
\set QUIET on
set client_min_messages = notice;
set bunksoft.allow_direct_signup = 'on';

create or replace function pg_temp.chk(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '%  %', case when cond then 'PASS ' else 'FAIL ' end, label;
end $$;

-- Does `body` raise an error? Used to prove a refusal.
create or replace function pg_temp.refuses(body text) returns boolean
language plpgsql as $$
begin
  execute body;
  return false;
exception when others then
  return true;
end $$;

do $$
declare
  owner_id uuid := '7f000001-0000-4000-8000-000000000001';
  bunk uuid; t1 uuid; n1 uuid; s1 uuid; prod1 uuid;
  v numeric; j jsonb; cnt int; d date := current_date;
begin
  insert into auth.users(id,email) values (owner_id,'fixowner@subsel.test')
    on conflict do nothing;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  bunk := public.create_bunk('Fixes Test Bunk','Indian Oil','Coimbatore');
  select id, product_id into t1, prod1 from public.tanks where bunk_id = bunk order by sort_order limit 1;
  select id into n1 from public.nozzles where bunk_id = bunk and tank_id = t1 order by sort_order limit 1;
  insert into public.business_days(bunk_id, day) values (bunk, d) on conflict do nothing;
  insert into public.shifts(bunk_id, day, name, operator)
    values (bunk, d, 'Morning', 'Ravi K') returning id into s1;

  -- 1 ------------------------------------------------------------------ roll
  insert into public.readings(bunk_id, shift_id, nozzle_id, tank_id,
      opening_reading, closing_reading, test_litres, rollover_add)
    values (bunk, s1, n1, t1, 99999000, 500, 0, 100000000);
  select public.reading_sold(r.*) into v from public.readings r
    where r.shift_id = s1 and r.nozzle_id = n1;
  perform pg_temp.chk('a totalizer wrap keeps its litres (1500 expected, got '||v||')', v = 1500);

  select current_stock into v from public.tanks where id = t1;
  perform pg_temp.chk('and the same figure moved the tank ('||v||')', v = -1500);

  -- 2 ------------------------------------------------------------- sane rows
  perform pg_temp.chk('a closing below its opening is refused',
    pg_temp.refuses(format($q$insert into public.readings(bunk_id, shift_id, nozzle_id, tank_id,
        opening_reading, closing_reading, test_litres)
      values (%L, %L, %L, %L, 9000, 100, 0)$q$, bunk, s1, n1, t1)));

  perform pg_temp.chk('test litres beyond what passed the meter are refused',
    pg_temp.refuses(format($q$update public.readings set test_litres = 99999999
      where shift_id = %L and nozzle_id = %L$q$, s1, n1)));

  perform pg_temp.chk('negative test litres are refused',
    pg_temp.refuses(format($q$update public.readings set test_litres = -5
      where shift_id = %L and nozzle_id = %L$q$, s1, n1)));

  -- 3 ------------------------------------------------------- frozen rates
  perform pg_temp.chk('a shift can carry the rate card it closed at',
    (select true from information_schema.columns
       where table_schema='public' and table_name='shifts' and column_name='rates_at_close'));
  update public.shifts set closed = true, closed_at = now(),
    rates_at_close = jsonb_build_object(prod1::text, jsonb_build_object('sell',100,'buy',90))
    where id = s1;
  perform pg_temp.chk('and it round-trips',
    (select (rates_at_close -> prod1::text ->> 'sell') = '100' from public.shifts where id = s1));

  -- 4 ---------------------------------------------------------- record_dip
  select current_stock into v from public.tanks where id = t1;
  j := public.record_dip(bunk, d, t1, 7180);
  perform pg_temp.chk('record_dip reads the book figure on the server ('||(j->>'book')||')',
    (j->>'book')::numeric = v);
  perform pg_temp.chk('and reports the variation it computed itself',
    (j->>'variation')::numeric = 7180 - v);
  select current_stock into v from public.tanks where id = t1;
  perform pg_temp.chk('and the dip set the tank', v = 7180);
  perform pg_temp.chk('a negative dip is refused',
    pg_temp.refuses(format('select public.record_dip(%L,%L,%L,-1)', bunk, d, t1)));
  perform pg_temp.chk('a tank in another bunk is refused',
    pg_temp.refuses(format('select public.record_dip(%L,%L,%L,100)',
      bunk, d, '7f000001-0000-4000-8000-0000000000ff')));

  -- 5 -------------------------------------------------------- last_closings
  select count(*) into cnt from public.last_closings(bunk, d);
  perform pg_temp.chk('last_closings ignores the day being entered', cnt = 0);
  select closing into v from public.last_closings(bunk, d + 1) where nozzle_id = n1;
  perform pg_temp.chk('and answers for an earlier day ('||coalesce(v::text,'null')||')', v = 500);

  -- 6 ------------------------------------------------------- shift policies
  perform pg_temp.chk('the blanket shifts_write policy is gone',
    not exists (select 1 from pg_policies where tablename='shifts' and policyname='shifts_write'));
  perform pg_temp.chk('insert, update and delete are governed separately',
    (select count(*) from pg_policies where tablename='shifts'
       and policyname in ('shifts_insert','shifts_update','shifts_delete')) = 3);
end $$;

-- 7 -------------------------------------------------------------- the anon role
-- Nothing added by fixes.sql may be reachable without signing in.
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('record_dip','last_closings','reading_sold','trg_reading_sane')
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  perform pg_temp.chk('the anonymous role can execute none of the new functions'
    || coalesce(' — but it can run '||bad, ''), bad is null);
end $$;

-- 8 ----------------------------------------- an operator cannot clear a closed shift
do $$
declare
  owner_id uuid := '7f000001-0000-4000-8000-000000000001';
  op_id    uuid := '7f000001-0000-4000-8000-000000000002';
  bunk uuid; s_open uuid; s_closed uuid; cnt int; d date := current_date;
begin
  insert into auth.users(id,email) values (op_id,'fixop@subsel.test') on conflict do nothing;
  select id into bunk from public.bunks where name = 'Fixes Test Bunk';
  insert into public.memberships(bunk_id, user_id, role) values (bunk, op_id, 'operator')
    on conflict (bunk_id, user_id) do update set role = 'operator';

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  insert into public.shifts(bunk_id, day, name, closed)
    values (bunk, d, 'Night-open', false) returning id into s_open;
  insert into public.shifts(bunk_id, day, name, closed, closed_at)
    values (bunk, d, 'Night-closed', true, now()) returning id into s_closed;

  perform set_config('request.jwt.claim.sub', op_id::text, true);
  set local role authenticated;

  delete from public.shifts where id = s_closed;
  select count(*) into cnt from public.shifts where id = s_closed;
  reset role;
  perform pg_temp.chk('an operator cannot delete a closed shift', cnt = 1);

  perform set_config('request.jwt.claim.sub', op_id::text, true);
  set local role authenticated;
  delete from public.shifts where id = s_open;
  select count(*) into cnt from public.shifts where id = s_open;
  reset role;
  perform pg_temp.chk('an open shift is still theirs to clear', cnt = 0);

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  set local role authenticated;
  delete from public.shifts where id = s_closed;
  select count(*) into cnt from public.shifts where id = s_closed;
  reset role;
  perform pg_temp.chk('the owner can clear a closed one', cnt = 0);
end $$;

\echo ''
\echo 'Done. Any FAIL line above names a fix that has regressed.'
