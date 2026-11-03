-- Hand-written checks for the entitlement machinery the matrix depends on.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(12);

create function pg_temp.act_as(p_email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated')::text, true),
         set_config('role', 'authenticated', true);
$$;

select ok(private.good_standing('active', null), 'active is in good standing');
select ok(private.good_standing('past_due', now() + interval '1 day'), 'past_due inside grace is in good standing');
select ok(not private.good_standing('past_due', now() - interval '1 second'), 'past_due after grace is not');
select ok(not private.good_standing('canceled', now() + interval '9 days'), 'canceled is never in good standing');

update public.subscriptions set tier = 'basic' where org_id = '00000000-0000-4000-a000-00000000000a';
select ok(not exists (select 1 from public.entitlements where org_id = '00000000-0000-4000-a000-00000000000a' and feature = 'contacts.full'),
  'downgrade to basic removes contacts.full');
update public.subscriptions set tier = 'enterprise' where org_id = '00000000-0000-4000-a000-00000000000a';
select ok(exists (select 1 from public.entitlements where org_id = '00000000-0000-4000-a000-00000000000a' and feature = 'agencies.all'),
  'upgrade to enterprise adds agencies.all');
update public.subscriptions set tier = 'pro' where org_id = '00000000-0000-4000-a000-00000000000a';

select pg_temp.act_as('pro_owner@fixture.test');
select is((public.my_access() ->> 'org_id'), '00000000-0000-4000-a000-00000000000a', 'my_access describes the caller''s org');
select ok((public.my_access() -> 'features') ? 'reports.read.pro', 'pro owner has reports.read.pro');
select throws_ok($$ select public.set_member_role('00000000-0000-4000-c000-0000000000a1', 'member') $$, '23514', 'cannot demote the last owner', 'last owner is protected');
reset role;

update public.subscriptions set status = 'canceled' where org_id = '00000000-0000-4000-a000-00000000000a';
select pg_temp.act_as('pro_owner@fixture.test');
select is(cardinality(private.current_features()), 0, 'canceled subscription → no features, even though entitlement rows remain');
reset role;

select pg_temp.act_as('pro_member@fixture.test');
select throws_ok($$ select * from public.billing_details() $$, '42501', 'not allowed', 'members cannot read billing details');
reset role;

set local role anon;
select throws_ok($$ select public.my_access() $$, '42501', null, 'anon cannot call my_access');
reset role;

select * from finish();
rollback;
