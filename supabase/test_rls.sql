\set QUIET on
insert into auth.users(id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('22222222-2222-2222-2222-222222222222','b@t.com'),
 ('33333333-3333-3333-3333-333333333333','op@t.com');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.create_bunk('Sri Balaji Fuels','Indian Oil','Coimbatore') as a \gset
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.create_bunk('Anand Fuel Point','BPCL','Madurai') as b \gset
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\set QUIET off

\echo '--- A writes into B bunk (must fail) ---'
\set ON_ERROR_STOP off
insert into public.expenses(bunk_id,day,head,amount) values (:'b',current_date,'hack',1);
\set ON_ERROR_STOP on

\echo ''
\echo '--- tank stock maintained by triggers ---'
\set QUIET on
select id as t1 from public.tanks where bunk_id=:'a' order by sort_order limit 1 \gset
select id as n1 from public.nozzles where bunk_id=:'a' order by sort_order limit 1 \gset
insert into public.fuel_receipts(bunk_id,day,tank_id,product_id,qty,rate,invoice_no)
  select :'a',current_date,:'t1',product_id,8000,99.35,'IOC/1' from public.tanks where id=:'t1';
\set QUIET off
select current_stock as "1_after_8000L_receipt" from public.tanks where id=:'t1';
\set QUIET on
insert into public.shifts(bunk_id,day,name,operator) values (:'a',current_date,'Morning','Ravi') returning id as s1 \gset
insert into public.readings(bunk_id,shift_id,nozzle_id,tank_id,opening_reading,closing_reading,test_litres)
  values (:'a',:'s1',:'n1',:'t1',100000,100500,5);
\set QUIET off
select current_stock as "2_after_selling_495L" from public.tanks where id=:'t1';
\set QUIET on
update public.readings set closing_reading=100800 where shift_id=:'s1';
\set QUIET off
select current_stock as "3_reading_corrected_to_795L" from public.tanks where id=:'t1';
\set QUIET on
insert into public.dip_readings(bunk_id,day,tank_id,book_qty,dip_qty) values (:'a',current_date,:'t1',7205,7180);
\set QUIET off
select current_stock as "4_after_dip_set_7180" from public.tanks where id=:'t1';

\echo ''
\echo '--- credit outstanding is derived, never stored ---'
\set QUIET on
insert into public.credit_customers(bunk_id,name,vehicle,credit_limit,opening_balance)
  values (:'a','Annai Transports','TN 37 BX 4410',150000,5000) returning id as c1 \gset
insert into public.credit_txns(bunk_id,customer_id,day,kind,amount,slip_no) values (:'a',:'c1',current_date,'sale',16963,'S1284');
insert into public.credit_txns(bunk_id,customer_id,day,kind,amount,mode)    values (:'a',:'c1',current_date,'payment',10000,'Cash');
\set QUIET off
select name, opening_balance as opening, balance as "5000+16963-10000" from public.customer_balances where bunk_id=:'a';

\echo ''
\echo '--- operator role ---'
\set QUIET on
reset role;
insert into public.memberships(bunk_id,user_id,role) values (:'a','33333333-3333-3333-3333-333333333333','operator');
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
\set QUIET off
select count(*) as operator_can_read_products from public.products;
update public.products set sell_rate=999 where bunk_id=:'a';
\echo '   ^ UPDATE 0 means the operator was correctly refused'
insert into public.expenses(bunk_id,day,head,amount) values (:'a',current_date,'Genset diesel',500);
\echo '   ^ INSERT 1 means the operator can run the forecourt'
