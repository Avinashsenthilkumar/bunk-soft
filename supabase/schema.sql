-- ============================================================================
--  BunkSoft — Petrol Bunk Management
--  Subsel Tech Solutions Pvt Ltd
--
--  Full database schema for Supabase (PostgreSQL 15+).
--  Run once in the Supabase SQL editor on a fresh project.
--
--  Every table is scoped to a bunk and protected by row-level security, so a
--  signed-in user can only ever read or write rows belonging to a bunk they
--  are a member of. Tank stock is maintained by database triggers rather than
--  by the client, so two people entering shifts at once cannot corrupt it.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- roles ----
do $$ begin
  create type public.member_role as enum ('owner','manager','operator');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.txn_kind as enum ('opening','sale','payment');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------- profiles ----
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  phone       text,
  created_at  timestamptz not null default now()
);

-- A row in profiles for every new auth user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- bunks ----
create table if not exists public.bunks (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  brand          text,
  place          text,
  shift_names    text[] not null default array['Morning','Evening'],
  expense_heads  text[] not null default array['Salaries','Electricity','Maintenance','Bank / POS charges','Transport','Misc'],
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create table if not exists public.memberships (
  bunk_id    uuid not null references public.bunks(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.member_role not null default 'operator',
  created_at timestamptz not null default now(),
  primary key (bunk_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships(user_id);

-- Security-definer helpers. These deliberately bypass RLS so that policies on
-- memberships cannot recurse into themselves.
create or replace function public.user_bunks()
returns setof uuid language sql stable security definer set search_path = public as $$
  select bunk_id from public.memberships where user_id = auth.uid();
$$;

create or replace function public.has_bunk_role(b uuid, roles public.member_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.bunk_id = b and m.user_id = auth.uid() and m.role = any(roles)
  );
$$;

create or replace function public.is_bunk_member(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.bunk_id = b and m.user_id = auth.uid());
$$;

-- ------------------------------------------------------- reference data ----
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  bunk_id    uuid not null references public.bunks(id) on delete cascade,
  code       text not null,                       -- ms, hsd, xp
  name       text not null,                       -- Petrol
  short_name text not null,                       -- MS
  sell_rate  numeric(10,3) not null default 0,    -- standing retail rate
  buy_rate   numeric(10,3) not null default 0,    -- standing purchase cost
  sort_order int not null default 0,
  archived   boolean not null default false,
  unique (bunk_id, code)
);
create index if not exists products_bunk_idx on public.products(bunk_id);

create table if not exists public.tanks (
  id            uuid primary key default gen_random_uuid(),
  bunk_id       uuid not null references public.bunks(id) on delete cascade,
  name          text not null,
  product_id    uuid references public.products(id) on delete set null,
  capacity      numeric(12,2) not null default 0,
  current_stock numeric(12,2) not null default 0,   -- maintained by triggers
  min_level     numeric(12,2) not null default 0,
  sort_order    int not null default 0,
  archived      boolean not null default false
);
create index if not exists tanks_bunk_idx on public.tanks(bunk_id);

create table if not exists public.nozzles (
  id         uuid primary key default gen_random_uuid(),
  bunk_id    uuid not null references public.bunks(id) on delete cascade,
  name       text not null,                       -- DU-1 / N1
  product_id uuid references public.products(id) on delete set null,
  tank_id    uuid references public.tanks(id) on delete set null,
  sort_order int not null default 0,
  archived   boolean not null default false
);
create index if not exists nozzles_bunk_idx on public.nozzles(bunk_id);

-- ------------------------------------------------------- business days -----
create table if not exists public.business_days (
  bunk_id      uuid not null references public.bunks(id) on delete cascade,
  day          date not null,
  rates        jsonb not null default '{}'::jsonb,  -- {product_id: {sell, buy}}
  opening_cash numeric(14,2) not null default 0,
  cash_counted numeric(14,2),                        -- null = not counted yet
  updated_at   timestamptz not null default now(),
  primary key (bunk_id, day)
);

-- --------------------------------------------------------------- shifts ----
create table if not exists public.shifts (
  id           uuid primary key default gen_random_uuid(),
  bunk_id      uuid not null references public.bunks(id) on delete cascade,
  day          date not null,
  name         text not null,                     -- Morning / Evening
  operator     text,
  closed       boolean not null default false,
  closed_at    timestamptz,
  cash         numeric(14,2) not null default 0,
  card         numeric(14,2) not null default 0,
  upi          numeric(14,2) not null default 0,
  bank         numeric(14,2) not null default 0,
  other_amount numeric(14,2) not null default 0,  -- lubes etc.
  other_cost   numeric(14,2) not null default 0,
  other_note   text,
  created_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  unique (bunk_id, day, name)
);
create index if not exists shifts_bunk_day_idx on public.shifts(bunk_id, day);

create table if not exists public.readings (
  id          uuid primary key default gen_random_uuid(),
  bunk_id     uuid not null references public.bunks(id) on delete cascade,
  shift_id    uuid not null references public.shifts(id) on delete cascade,
  nozzle_id   uuid not null references public.nozzles(id) on delete cascade,
  tank_id     uuid references public.tanks(id) on delete set null,
  opening_reading numeric(14,2) not null default 0,
  closing_reading numeric(14,2) not null default 0,
  test_litres     numeric(12,2) not null default 0,
  unique (shift_id, nozzle_id)
);
create index if not exists readings_bunk_idx on public.readings(bunk_id);
create index if not exists readings_shift_idx on public.readings(shift_id);

-- Litres actually sold on a reading row.
create or replace function public.reading_sold(r public.readings)
returns numeric language sql immutable as $$
  select greatest(0, r.closing_reading - r.opening_reading - r.test_litres);
$$;

-- --------------------------------------------------------------- credit ----
create table if not exists public.credit_customers (
  id              uuid primary key default gen_random_uuid(),
  bunk_id         uuid not null references public.bunks(id) on delete cascade,
  name            text not null,
  phone           text,
  vehicle         text,
  credit_limit    numeric(14,2) not null default 0,
  opening_balance numeric(14,2) not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists credit_customers_bunk_idx on public.credit_customers(bunk_id);

create table if not exists public.credit_txns (
  id          uuid primary key default gen_random_uuid(),
  bunk_id     uuid not null references public.bunks(id) on delete cascade,
  customer_id uuid not null references public.credit_customers(id) on delete cascade,
  day         date not null,
  kind        public.txn_kind not null,
  amount      numeric(14,2) not null,
  mode        text,                                 -- Cash / UPI / Bank transfer / Cheque
  shift_id    uuid references public.shifts(id) on delete set null,
  product_id  uuid references public.products(id) on delete set null,
  qty         numeric(12,2),
  vehicle     text,
  slip_no     text,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists credit_txns_customer_idx on public.credit_txns(customer_id);
create index if not exists credit_txns_bunk_day_idx on public.credit_txns(bunk_id, day);

-- Outstanding per customer, derived — never a stored balance that can drift.
create or replace view public.customer_balances
with (security_invoker = on) as
select
  c.id           as customer_id,
  c.bunk_id,
  c.name,
  c.phone,
  c.vehicle,
  c.credit_limit,
  c.opening_balance,
  c.archived,
  c.opening_balance + coalesce(sum(
    case t.kind when 'sale' then t.amount when 'payment' then -t.amount else 0 end
  ), 0) as balance,
  max(t.day) as last_txn_day
from public.credit_customers c
left join public.credit_txns t on t.customer_id = c.id
group by c.id;

-- ---------------------------------------------------------------- stock ----
create table if not exists public.fuel_receipts (
  id         uuid primary key default gen_random_uuid(),
  bunk_id    uuid not null references public.bunks(id) on delete cascade,
  day        date not null,
  tank_id    uuid not null references public.tanks(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  qty        numeric(12,2) not null,
  rate       numeric(10,3) not null default 0,
  invoice_no text,
  tanker_no  text,
  received_at timestamptz not null default now()
);
create index if not exists fuel_receipts_bunk_day_idx on public.fuel_receipts(bunk_id, day);

create table if not exists public.dip_readings (
  id         uuid primary key default gen_random_uuid(),
  bunk_id    uuid not null references public.bunks(id) on delete cascade,
  day        date not null,
  tank_id    uuid not null references public.tanks(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  book_qty   numeric(12,2) not null,
  dip_qty    numeric(12,2) not null,
  taken_at   timestamptz not null default now()
);
create index if not exists dip_readings_bunk_day_idx on public.dip_readings(bunk_id, day);

-- ------------------------------------------------------ money in and out ---
create table if not exists public.expenses (
  id      uuid primary key default gen_random_uuid(),
  bunk_id uuid not null references public.bunks(id) on delete cascade,
  day     date not null,
  head    text not null,
  mode    text not null default 'Cash',
  amount  numeric(14,2) not null,
  note    text,
  created_at timestamptz not null default now()
);
create index if not exists expenses_bunk_day_idx on public.expenses(bunk_id, day);

create table if not exists public.cash_deposits (
  id      uuid primary key default gen_random_uuid(),
  bunk_id uuid not null references public.bunks(id) on delete cascade,
  day     date not null,
  amount  numeric(14,2) not null,
  bank    text,
  ref     text,
  deposited_at timestamptz not null default now()
);
create index if not exists cash_deposits_bunk_day_idx on public.cash_deposits(bunk_id, day);

-- ============================================================================
--  Tank stock, maintained by the database
--  The client never writes current_stock. Sales reduce it, decantation raises
--  it, a dip sets it outright. Doing this in triggers keeps it correct even
--  when two operators save shifts at the same moment.
-- ============================================================================
create or replace function public.trg_reading_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_sold numeric := 0;
  new_sold numeric := 0;
  t_old uuid; t_new uuid;
begin
  if tg_op in ('UPDATE','DELETE') then
    old_sold := greatest(0, old.closing_reading - old.opening_reading - old.test_litres);
    t_old := coalesce(old.tank_id, (select tank_id from public.nozzles where id = old.nozzle_id));
  end if;
  if tg_op in ('UPDATE','INSERT') then
    new_sold := greatest(0, new.closing_reading - new.opening_reading - new.test_litres);
    t_new := coalesce(new.tank_id, (select tank_id from public.nozzles where id = new.nozzle_id));
  end if;

  if t_old is not null and old_sold <> 0 then
    update public.tanks set current_stock = current_stock + old_sold where id = t_old;
  end if;
  if t_new is not null and new_sold <> 0 then
    update public.tanks set current_stock = current_stock - new_sold where id = t_new;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists readings_stock on public.readings;
create trigger readings_stock
  after insert or update or delete on public.readings
  for each row execute function public.trg_reading_stock();

create or replace function public.trg_receipt_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    update public.tanks set current_stock = current_stock - old.qty where id = old.tank_id;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    update public.tanks set current_stock = current_stock + new.qty where id = new.tank_id;
    -- an invoice also restates what the fuel costs us from here on
    if new.rate > 0 and new.product_id is not null then
      update public.products set buy_rate = new.rate where id = new.product_id;
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists receipts_stock on public.fuel_receipts;
create trigger receipts_stock
  after insert or update or delete on public.fuel_receipts
  for each row execute function public.trg_receipt_stock();

create or replace function public.trg_dip_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.tanks set current_stock = new.dip_qty where id = new.tank_id;
  return new;
end $$;

drop trigger if exists dips_stock on public.dip_readings;
create trigger dips_stock
  after insert on public.dip_readings
  for each row execute function public.trg_dip_stock();

-- keep updated_at honest
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists shifts_touch on public.shifts;
create trigger shifts_touch before update on public.shifts
  for each row execute function public.touch_updated_at();

-- ============================================================================
--  Onboarding: create a bunk, make the caller its owner, seed sensible
--  defaults. Security definer so the very first insert is possible before any
--  membership row exists.
-- ============================================================================
create or replace function public.create_bunk(
  p_name text, p_brand text default null, p_place text default null, p_seed boolean default true
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  b uuid; p_ms uuid; p_hsd uuid; p_xp uuid; t1 uuid; t2 uuid; t3 uuid;
begin
  if auth.uid() is null then
    raise exception 'must be signed in to create a bunk';
  end if;
  if coalesce(trim(p_name),'') = '' then
    raise exception 'bunk name is required';
  end if;

  insert into public.bunks (name, brand, place, created_by)
  values (trim(p_name), nullif(trim(coalesce(p_brand,'')),''), nullif(trim(coalesce(p_place,'')),''), auth.uid())
  returning id into b;

  insert into public.memberships (bunk_id, user_id, role) values (b, auth.uid(), 'owner');

  if p_seed then
    insert into public.products (bunk_id, code, name, short_name, sell_rate, buy_rate, sort_order)
    values (b,'ms','Petrol','MS',0,0,1) returning id into p_ms;
    insert into public.products (bunk_id, code, name, short_name, sell_rate, buy_rate, sort_order)
    values (b,'hsd','Diesel','HSD',0,0,2) returning id into p_hsd;
    insert into public.products (bunk_id, code, name, short_name, sell_rate, buy_rate, sort_order)
    values (b,'xp','XP-95 Premium','XP95',0,0,3) returning id into p_xp;

    insert into public.tanks (bunk_id, name, product_id, capacity, current_stock, min_level, sort_order)
    values (b,'Tank 1',p_ms,12000,0,1500,1) returning id into t1;
    insert into public.tanks (bunk_id, name, product_id, capacity, current_stock, min_level, sort_order)
    values (b,'Tank 2',p_hsd,20000,0,2500,2) returning id into t2;
    insert into public.tanks (bunk_id, name, product_id, capacity, current_stock, min_level, sort_order)
    values (b,'Tank 3',p_xp,6000,0,800,3) returning id into t3;

    insert into public.nozzles (bunk_id, name, product_id, tank_id, sort_order) values
      (b,'DU-1 / N1',p_ms,t1,1),
      (b,'DU-1 / N2',p_hsd,t2,2),
      (b,'DU-2 / N3',p_ms,t1,3),
      (b,'DU-2 / N4',p_hsd,t2,4),
      (b,'DU-3 / N5',p_xp,t3,5);
  end if;

  return b;
end $$;

-- Add a colleague by email. Only owners and managers may call it.
create or replace function public.add_member(p_bunk uuid, p_email text, p_role public.member_role)
returns boolean language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if not public.has_bunk_role(p_bunk, array['owner','manager']::public.member_role[]) then
    raise exception 'only an owner or manager can add staff';
  end if;
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is null then
    raise exception 'no BunkSoft account for %. Ask them to sign up first, then add them.', p_email;
  end if;
  if p_role = 'owner' and not public.has_bunk_role(p_bunk, array['owner']::public.member_role[]) then
    raise exception 'only an owner can appoint another owner';
  end if;
  insert into public.memberships (bunk_id, user_id, role) values (p_bunk, u, p_role)
  on conflict (bunk_id, user_id) do update set role = excluded.role;
  return true;
end $$;

-- The bunks a user belongs to, with their role — one call on sign-in.
create or replace function public.my_bunks()
returns table (id uuid, name text, brand text, place text, role public.member_role)
language sql stable security definer set search_path = public as $$
  select b.id, b.name, b.brand, b.place, m.role
  from public.bunks b
  join public.memberships m on m.bunk_id = b.id
  where m.user_id = auth.uid()
  order by b.created_at;
$$;

-- ============================================================================
--  Row level security
--  Read: any member of the bunk.
--  Write on operational tables: any member (operators run the forecourt).
--  Write on configuration: owner or manager only.
-- ============================================================================
alter table public.profiles         enable row level security;
alter table public.bunks            enable row level security;
alter table public.memberships      enable row level security;
alter table public.products         enable row level security;
alter table public.tanks            enable row level security;
alter table public.nozzles          enable row level security;
alter table public.business_days    enable row level security;
alter table public.shifts           enable row level security;
alter table public.readings         enable row level security;
alter table public.credit_customers enable row level security;
alter table public.credit_txns      enable row level security;
alter table public.fuel_receipts    enable row level security;
alter table public.dip_readings     enable row level security;
alter table public.expenses         enable row level security;
alter table public.cash_deposits    enable row level security;

-- profiles: you see and edit your own
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- bunks
drop policy if exists bunks_read on public.bunks;
create policy bunks_read on public.bunks
  for select using (public.is_bunk_member(id));
drop policy if exists bunks_update on public.bunks;
create policy bunks_update on public.bunks
  for update using (public.has_bunk_role(id, array['owner','manager']::public.member_role[]))
  with check (public.has_bunk_role(id, array['owner','manager']::public.member_role[]));
drop policy if exists bunks_delete on public.bunks;
create policy bunks_delete on public.bunks
  for delete using (public.has_bunk_role(id, array['owner']::public.member_role[]));

-- memberships: members can see the team; owners/managers change it
drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships
  for select using (public.is_bunk_member(bunk_id));
drop policy if exists memberships_write on public.memberships;
create policy memberships_write on public.memberships
  for all using (public.has_bunk_role(bunk_id, array['owner','manager']::public.member_role[]))
  with check (public.has_bunk_role(bunk_id, array['owner','manager']::public.member_role[]));

-- configuration tables — owner / manager write
do $$
declare t text;
begin
  foreach t in array array['products','tanks','nozzles'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (public.is_bunk_member(bunk_id))', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format($f$create policy %I_write on public.%I for all
      using (public.has_bunk_role(bunk_id, array['owner','manager']::public.member_role[]))
      with check (public.has_bunk_role(bunk_id, array['owner','manager']::public.member_role[]))$f$, t, t);
  end loop;
end $$;

-- operational tables — any member of the bunk
do $$
declare t text;
begin
  foreach t in array array['business_days','shifts','readings','credit_customers','credit_txns',
                           'fuel_receipts','dip_readings','expenses','cash_deposits'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (public.is_bunk_member(bunk_id))', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all
      using (public.is_bunk_member(bunk_id)) with check (public.is_bunk_member(bunk_id))', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- grants ---
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.customer_balances to authenticated;
grant execute on all functions in schema public to authenticated;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;

-- Anonymous visitors get nothing at all.
revoke all on all tables in schema public from anon;
