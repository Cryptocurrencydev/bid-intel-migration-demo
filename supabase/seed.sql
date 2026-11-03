-- Fixture personas for the generated pgTAP matrix (privacy-rules.yaml → personas/fixtures).
-- Emails are <persona>@fixture.test. The 20k-record Bubble migration loads separately.

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  p || '@fixture.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
from unnest(array['free_user','basic_member','pro_owner','pro_admin','pro_member','other_org_owner',
                  'grace_member','lapsed_member','researcher']) p;

insert into public.organizations (id, name, slug, stripe_customer_id) values
  ('00000000-0000-4000-a000-00000000000a', 'Fixture Org A', 'fixture-a', 'cus_fixture_a'),
  ('00000000-0000-4000-a000-00000000000b', 'Fixture Org B', 'fixture-b', 'cus_fixture_b'),
  ('00000000-0000-4000-a000-00000000000c', 'Fixture Org C (basic)', 'fixture-c', 'cus_fixture_c'),
  ('00000000-0000-4000-a000-00000000000d', 'Fixture Org D (grace)', 'fixture-d', 'cus_fixture_d'),
  ('00000000-0000-4000-a000-00000000000e', 'Fixture Org E (lapsed)', 'fixture-e', 'cus_fixture_e'),
  ('00000000-0000-4000-a000-00000000000f', 'Fixture Org F (free)', 'fixture-f', null);

insert into public.members (id, org_id, user_id, email, full_name, role)
select v.id::uuid, v.org::uuid, u.id, u.email, v.name, v.role::public.member_role
from (values
  ('00000000-0000-4000-c000-0000000000a1', '00000000-0000-4000-a000-00000000000a', 'pro_owner', 'Ava Owner', 'owner'),
  ('00000000-0000-4000-c000-0000000000a2', '00000000-0000-4000-a000-00000000000a', 'pro_admin', 'Abe Admin', 'admin'),
  ('00000000-0000-4000-c000-0000000000a3', '00000000-0000-4000-a000-00000000000a', 'pro_member', 'Amy Member', 'member'),
  ('00000000-0000-4000-c000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'other_org_owner', 'Bo Other', 'owner'),
  ('00000000-0000-4000-c000-0000000000c1', '00000000-0000-4000-a000-00000000000c', 'basic_member', 'Cy Basic', 'member'),
  ('00000000-0000-4000-c000-0000000000d1', '00000000-0000-4000-a000-00000000000d', 'grace_member', 'Di Grace', 'member'),
  ('00000000-0000-4000-c000-0000000000e1', '00000000-0000-4000-a000-00000000000e', 'lapsed_member', 'Ed Lapsed', 'member'),
  ('00000000-0000-4000-c000-0000000000f1', '00000000-0000-4000-a000-00000000000f', 'free_user', 'Flo Free', 'owner')
) v(id, org, persona, name, role)
join auth.users u on u.email = v.persona || '@fixture.test';

insert into public.researchers (id, user_id, email, full_name, specialty)
select '00000000-0000-4000-9000-000000000001', u.id, u.email, 'Rae Researcher', 'DCD'
from auth.users u where u.email = 'researcher@fixture.test';

insert into public.subscriptions (id, org_id, tier, status, stripe_subscription_id, current_period_end, grace_until) values
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-a000-00000000000a', 'pro', 'active', 'sub_fixture_a', now() + interval '20 days', null),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-4000-a000-00000000000b', 'pro', 'active', 'sub_fixture_b', now() + interval '20 days', null),
  ('00000000-0000-4000-b000-00000000000c', '00000000-0000-4000-a000-00000000000c', 'basic', 'active', 'sub_fixture_c', now() + interval '20 days', null),
  ('00000000-0000-4000-b000-00000000000d', '00000000-0000-4000-a000-00000000000d', 'pro', 'past_due', 'sub_fixture_d', now() - interval '2 days', now() + interval '5 days'),
  ('00000000-0000-4000-b000-00000000000e', '00000000-0000-4000-a000-00000000000e', 'pro', 'past_due', 'sub_fixture_e', now() - interval '9 days', now() - interval '1 day');

insert into public.subscription_agencies (subscription_id, agency) values
  ('00000000-0000-4000-b000-00000000000a', 'DCD'), ('00000000-0000-4000-b000-00000000000a', 'FCSA'),
  ('00000000-0000-4000-b000-00000000000b', 'OSL'),
  ('00000000-0000-4000-b000-00000000000c', 'DCD'),
  ('00000000-0000-4000-b000-00000000000d', 'DCD'),
  ('00000000-0000-4000-b000-00000000000e', 'DCD');

insert into public.reports (id, title, agency, category, summary, body, attachment_path, tier_required, status, author_id, published_at) values
  ('00000000-0000-4000-d000-000000000001', 'Coastal radar sustainment recompete outlook', 'DCD', 'recompete',
   'Fixture summary', 'Fixture pro body', '00000000-0000-4000-d000-000000000001/brief.pdf', 'pro', 'published', '00000000-0000-4000-9000-000000000001', now() - interval '3 days'),
  ('00000000-0000-4000-d000-000000000002', 'DCD FY27 budget brief', 'DCD', 'budget_brief',
   'Fixture summary', 'Fixture basic body', null, 'basic', 'published', '00000000-0000-4000-9000-000000000001', now() - interval '2 days'),
  ('00000000-0000-4000-d000-000000000003', 'Launch range logistics forecast', 'OSL', 'forecast',
   'Fixture summary', 'Fixture OSL body', '00000000-0000-4000-d000-000000000003/brief.pdf', 'pro', 'published', '00000000-0000-4000-9000-000000000001', now() - interval '1 day'),
  ('00000000-0000-4000-d000-000000000004', 'Unreleased draft', 'DCD', 'forecast',
   'Draft summary', 'Draft body', null, 'pro', 'draft', '00000000-0000-4000-9000-000000000001', null);
insert into public.report_tags (report_id, tag) values ('00000000-0000-4000-d000-000000000001', 'radar');

insert into public.contacts (id, agency, full_name, title, office, email, phone, notes) values
  ('00000000-0000-4000-e000-000000000001', 'DCD', 'Jordan Fixture', 'Contracting Officer', 'Coastal Systems Office',
   'jordan.fixture@dcd.example', '+1-555-0100', 'Researcher-only note');

insert into public.awarded_contracts (id, piid, agency, vendor_name, naics, amount, award_date, set_aside, description) values
  ('00000000-0000-4000-e100-000000000001', 'FX-DCD-0001', 'DCD', 'Fixture Vendor LLC', '541330', 1250000, '2026-06-01',
   'small_business', 'Coastal radar sustainment and depot support');

insert into public.crm_opportunities (id, org_id, title, agency, stage, value, owner_member_id) values
  ('00000000-0000-4000-f000-00000000000a', '00000000-0000-4000-a000-00000000000a', 'Org A radar bid', 'DCD', 'capture', 4000000, '00000000-0000-4000-c000-0000000000a1'),
  ('00000000-0000-4000-f000-00000000000b', '00000000-0000-4000-a000-00000000000b', 'Org B launch bid', 'OSL', 'qualifying', 900000, '00000000-0000-4000-c000-0000000000b1');
insert into public.crm_notes (id, org_id, opportunity_id, author_member_id, body) values
  ('00000000-0000-4000-f100-00000000000a', '00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-f000-00000000000a',
   '00000000-0000-4000-c000-0000000000a3', 'Teaming partner call went well');
insert into public.crm_tasks (id, org_id, opportunity_id, assignee_member_id, title) values
  ('00000000-0000-4000-f200-00000000000a', '00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-f000-00000000000a',
   '00000000-0000-4000-c000-0000000000a3', 'Draft compliance matrix');

insert into storage.objects (bucket_id, name, metadata) values
  ('report-files', '00000000-0000-4000-d000-000000000001/brief.pdf', '{"mimetype":"application/pdf"}'),
  ('report-files', '00000000-0000-4000-d000-000000000003/brief.pdf', '{"mimetype":"application/pdf"}');

insert into ops.stripe_events (id, type, stripe_created_at, outcome, payload)
  values ('evt_fixture', 'invoice.paid', now(), 'fixture', '{}');
insert into ops.email_outbox (template, to_email, subject, mode, payload)
  values ('welcome', 'pro_owner@fixture.test', 'Fixture', 'test', '{}');
insert into migration.id_map (bubble_id, bubble_type, target_table, uuid)
  values ('1698765432123x100000000000000001', 'organization', 'organizations', '00000000-0000-4000-a000-00000000000a');
