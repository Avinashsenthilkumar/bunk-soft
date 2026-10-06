-- ============================================================================
--  BunkSoft — domain fixes
--  Subsel Tech Solutions Pvt Ltd
--
--  Run ONCE in the Supabase SQL editor, AFTER schema.sql and admin.sql.
--  Safe to run again.
--
--  These close the forecourt, cash and credit faults found in the October
--  review. They are separate from admin.sql because they are about how a bunk
--  trades, not about who may administer it.
-- ============================================================================

-- ============================================================================
--  1. Meter rollover
--
--  Sold litres were `closing - opening - test`, floored at zero. When an
--  eight-digit totalizer wraps past all nines — opening 99,999,000, closing
--  500 — that arithmetic gives a negative number, the floor turns it into
--  zero, and a real 1,500 L sale disappears from the books with the money
--  still in the drawer.
--
--  rollover_add carries the litres the wrap swallowed: 10^digits, written by
--  the app when the operator confirms the meter turned over. Everything that
--  computes a sale now reads the same formula, including this trigger, so
--  stock and sales cannot disagree.
-- ============================================================================
alter table public.readings
  add column if not exists rollover_add numeric(14,2) not null default 0;

comment on column public.readings.rollover_add is
  'Litres a totalizer wrap swallowed (10^digits), 0 normally. Sold = closing + rollover_add - opening - test.';

-- One definition of a sale, used by the trigger and available to reports.
create or replace function public.reading_sold(r public.readings)
returns numeric language sql immutable as $$
  select greatest(0, r.closing_reading + coalesce(r.rollover_add,0)
                   - r.opening_reading - r.test_litres);
$$;

create or replace function public.trg_reading_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_sold numeric := 0;
  new_sold numeric := 0;
  t_old uuid; t_new uuid;
begin
  if tg_op in ('UPDATE','DELETE') then
    old_sold := greatest(0, old.closing_reading + coalesce(old.rollover_add,0)
                          - old.opening_reading - old.test_litres);
    t_old := coalesce(old.tank_id, (select tank_id from public.nozzles where id = old.nozzle_id));
  end if;
  if tg_op in ('UPDATE','INSERT') then
    new_sold := greatest(0, new.closing_reading + coalesce(new.rollover_add,0)
                          - new.opening_reading - new.test_litres);
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

-- A reading that cannot be true is refused here as well as in the browser:
-- test litres cannot exceed what passed the meter, and a closing below the
-- opening is only possible when the meter wrapped.
create or replace function public.trg_reading_sane()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare moved numeric;
begin
  moved := new.closing_reading + coalesce(new.rollover_add,0) - new.opening_reading;
  if moved < 0 then
    raise exception 'Closing reading is below the opening reading. Correct it, or record a meter rollover.'
      using errcode = 'check_violation';
  end if;
  if coalesce(new.test_litres,0) < 0 then
    raise exception 'Test litres cannot be negative.' using errcode = 'check_violation';
  end if;
  if coalesce(new.test_litres,0) > moved then
    raise exception 'Test litres (%) exceed the % litres that passed this meter.',
      new.test_litres, moved using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists readings_sane on public.readings;
create trigger readings_sane
  before insert or update on public.readings
  for each row execute function public.trg_reading_sane();

-- ============================================================================
--  2. The rate a shift was closed at
--
--  Shift value was recomputed from the day's rates every time it rendered, so
--  revising a rate retroactively restated shifts already closed, signed and
--  handed over. The rates are now frozen onto the shift when it closes; the
--  app shows the frozen set for a closed shift and the live set for an open
--  one.
-- ============================================================================
alter table public.shifts
  add column if not exists rates_at_close jsonb;

comment on column public.shifts.rates_at_close is
  'The rate card as it stood when this shift was closed. Null while the shift is open.';

-- ============================================================================
--  3. Dips are measured server-side
--
--  The app sent book_qty from the tank figure held in that browser. If another
--  device had sold fuel since the page loaded, the logged gain or loss was
--  wrong — and because a dip SETS stock, the error was then baked into the
--  tank. The book figure is now read inside the same statement that writes the
--  dip, so it cannot be stale.
-- ============================================================================
create or replace function public.record_dip(
  p_bunk uuid, p_day date, p_tank uuid, p_dip numeric
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_book numeric; v_product uuid; v_id uuid;
begin
  if not public.is_bunk_member(p_bunk) then
    raise exception 'You do not have permission to do that.';
  end if;
  if p_dip is null or p_dip < 0 then
    raise exception 'Enter the measured quantity.';
  end if;

  -- Locked so a concurrent sale cannot slip between the read and the write.
  select current_stock, product_id into v_book, v_product
    from public.tanks where id = p_tank and bunk_id = p_bunk for update;
  if v_book is null then raise exception 'No such tank.'; end if;

  insert into public.dip_readings (bunk_id, day, tank_id, product_id, book_qty, dip_qty)
  values (p_bunk, p_day, p_tank, v_product, v_book, p_dip)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'book', v_book, 'dip', p_dip,
                            'variation', p_dip - v_book);
end $$;

-- ============================================================================
--  4. The previous closing reading, from the database
--
--  The app worked out a nozzle's opening from whatever days happened to be in
--  memory. Open a date outside the loaded window and it fell back to 0 — and
--  a shift saved that way booked the meter's entire lifetime total as one
--  day's sale. This answers the question from the records instead.
-- ============================================================================
create or replace function public.last_closings(p_bunk uuid, p_before date)
returns table (nozzle_id uuid, closing numeric, day date)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (r.nozzle_id)
         r.nozzle_id, r.closing_reading, s.day
  from public.readings r
  join public.shifts s on s.id = r.shift_id
  where r.bunk_id = p_bunk
    and public.is_bunk_member(p_bunk)
    and s.day < p_before
  -- Latest day first, then the shift touched most recently on that day:
  -- shifts carry no creation time, and closed_at is null while one is open.
  order by r.nozzle_id, s.day desc, s.closed_at desc nulls last, s.updated_at desc;
$$;

-- ============================================================================
--  5. A closed shift is not an operator's to delete
--
--  Clearing a shift cascades its readings away and moves tank stock with
--  them. Any member could do that to a shift already closed, signed and
--  handed over. An open shift stays anyone's to clear.
-- ============================================================================
drop policy if exists shifts_write on public.shifts;

create policy shifts_insert on public.shifts
  for insert with check (public.is_bunk_member(bunk_id));

create policy shifts_update on public.shifts
  for update using (public.is_bunk_member(bunk_id))
         with check (public.is_bunk_member(bunk_id));

create policy shifts_delete on public.shifts
  for delete using (
    public.is_bunk_member(bunk_id)
    and (closed = false
         or public.has_bunk_role(bunk_id, array['owner','manager']::public.member_role[]))
  );

-- ============================================================================
--  6. Grants
-- ============================================================================
grant execute on function public.record_dip(uuid, date, uuid, numeric) to authenticated;
grant execute on function public.last_closings(uuid, date)             to authenticated;
grant execute on function public.reading_sold(public.readings)         to authenticated;

-- Shut the anonymous role out of anything added above, the way admin.sql does.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  loop execute format('revoke all on function %s from public, anon', r.sig); end loop;
end $$;
revoke execute on function public.trg_reading_sane() from public, anon, authenticated;
