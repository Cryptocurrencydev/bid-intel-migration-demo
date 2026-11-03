-- Bidmarker core schema (target of the Bubble migration).
-- Option sets → enums, list fields → join tables, Bubble ids kept on every row for traceability.

create extension if not exists citext with schema extensions;

create schema if not exists private;   -- helper functions used by RLS (execute-only, not exposed)
create schema if not exists ops;       -- stripe events, email outbox (service role only)
create schema if not exists migration; -- bubble id map, run log (service role only)

-- Option sets ---------------------------------------------------------------
create type public.member_role as enum ('owner', 'admin', 'member');
create type public.tier as enum ('free', 'basic', 'pro', 'enterprise');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'incomplete');
create type public.agency_code as enum ('DCD', 'FHDA', 'OSL', 'NGRO', 'BTS', 'FCSA', 'MSC', 'FEMR');
create type public.report_category as enum ('forecast', 'rfp_analysis', 'recompete', 'budget_brief', 'agency_profile');
create type public.report_status as enum ('draft', 'published');
create type public.opportunity_stage as enum ('identified', 'qualifying', 'capture', 'proposal', 'submitted', 'won', 'lost', 'no_bid');
create type public.set_aside as enum ('full_and_open', 'small_business', '8a', 'hubzone', 'sdvosb', 'wosb');

-- Reference: agencies (fictional) ------------------------------------------
create table public.agencies (
  code public.agency_code primary key,
  name text not null
);
insert into public.agencies (code, name) values
  ('DCD', 'Department of Coastal Defense'),
  ('FHDA', 'Federal Health Data Agency'),
  ('OSL', 'Office of Space Logistics'),
  ('NGRO', 'National Grid Resilience Office'),
  ('BTS', 'Bureau of Transit Security'),
  ('FCSA', 'Federal Cyber Shield Agency'),
  ('MSC', 'Maritime Sustainment Command'),
  ('FEMR', 'Federal Emergency Medical Reserve');

-- Tenancy -------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  name text not null check (length(name) between 1 and 200),
  slug text not null unique,
  stripe_customer_id text unique,
  logo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid unique references auth.users (id) on delete set null,
  email extensions.citext,
  full_name text not null default '',
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create index members_org_idx on public.members (org_id);

create table public.researchers (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  user_id uuid unique references auth.users (id) on delete set null,
  email extensions.citext,
  full_name text not null,
  specialty public.agency_code,
  created_at timestamptz not null default now()
);

-- Billing (Stripe-backed) ----------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  org_id uuid not null unique references public.organizations (id) on delete cascade,
  tier public.tier not null default 'free',
  status public.subscription_status not null default 'active',
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  grace_until timestamptz,
  last_stripe_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bubble list field Subscription.agencies (list of Agency option) → join table
create table public.subscription_agencies (
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  agency public.agency_code not null,
  primary key (subscription_id, agency)
);

-- Derived from tier by trigger; RLS reads these, never the tier.
create table public.entitlements (
  org_id uuid not null references public.organizations (id) on delete cascade,
  feature text not null,
  primary key (org_id, feature)
);

-- Research content ------------------------------------------------------------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  title text not null,
  agency public.agency_code not null,
  category public.report_category not null,
  summary text,
  body text,
  attachment_path text,
  tier_required public.tier not null default 'pro' check (tier_required <> 'free'),
  status public.report_status not null default 'draft',
  author_id uuid references public.researchers (id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reports_published_idx on public.reports (published_at desc) where status = 'published';

-- Bubble list field Report.tags (list of texts) → join table
create table public.report_tags (
  report_id uuid not null references public.reports (id) on delete cascade,
  tag text not null,
  primary key (report_id, tag)
);

create table public.awarded_contracts (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  piid text not null unique,
  agency public.agency_code not null,
  vendor_name text not null,
  naics text,
  amount numeric(14, 2) not null,
  award_date date not null,
  set_aside public.set_aside not null default 'full_and_open',
  description text,
  search tsvector generated always as (
    to_tsvector('english', coalesce(piid, '') || ' ' || coalesce(vendor_name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(naics, ''))
  ) stored,
  created_at timestamptz not null default now()
);
create index awarded_contracts_search_idx on public.awarded_contracts using gin (search);
create index awarded_contracts_agency_date_idx on public.awarded_contracts (agency, award_date desc);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  agency public.agency_code not null,
  full_name text not null,
  title text,
  office text,
  email extensions.citext,
  phone text,
  notes text,
  created_at timestamptz not null default now()
);

-- Capture CRM (strictly tenant-private) ----------------------------------------
create table public.crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  org_id uuid not null references public.organizations (id) on delete cascade,
  title text not null,
  agency public.agency_code not null,
  stage public.opportunity_stage not null default 'identified',
  value numeric(14, 2),
  due_date date,
  owner_member_id uuid,
  solicitation_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  -- the owner must be a member of the same org: composite FK, not just "a member"
  foreign key (owner_member_id, org_id) references public.members (id, org_id) on delete set null (owner_member_id)
);
create index crm_opportunities_org_idx on public.crm_opportunities (org_id, stage);

-- Bubble list field Opportunity.linked_reports → join table
create table public.crm_opportunity_reports (
  opportunity_id uuid not null,
  org_id uuid not null,
  report_id uuid not null references public.reports (id) on delete cascade,
  primary key (opportunity_id, report_id),
  foreign key (opportunity_id, org_id) references public.crm_opportunities (id, org_id) on delete cascade
);

create table public.crm_notes (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  org_id uuid not null,
  opportunity_id uuid not null,
  author_member_id uuid,
  body text not null,
  created_at timestamptz not null default now(),
  foreign key (opportunity_id, org_id) references public.crm_opportunities (id, org_id) on delete cascade,
  foreign key (author_member_id, org_id) references public.members (id, org_id) on delete set null (author_member_id)
);
create index crm_notes_opp_idx on public.crm_notes (org_id, opportunity_id);

create table public.crm_tasks (
  id uuid primary key default gen_random_uuid(),
  bubble_id text unique,
  org_id uuid not null,
  opportunity_id uuid not null,
  assignee_member_id uuid,
  title text not null,
  due_date date,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (opportunity_id, org_id) references public.crm_opportunities (id, org_id) on delete cascade,
  foreign key (assignee_member_id, org_id) references public.members (id, org_id) on delete set null (assignee_member_id)
);
create index crm_tasks_opp_idx on public.crm_tasks (org_id, opportunity_id);

-- Ops (service role only) -------------------------------------------------------
create table ops.stripe_events (
  id text primary key,                 -- evt_... ; the idempotency key
  type text not null,
  stripe_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  outcome text not null,
  payload jsonb not null
);

create table ops.email_outbox (
  id bigint generated always as identity primary key,
  template text not null,
  to_email text not null,
  subject text not null,
  mode text not null check (mode in ('test', 'live')),
  provider_message_id text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Migration bookkeeping ------------------------------------------------------------
create table migration.id_map (
  bubble_id text primary key,
  bubble_type text not null,
  target_table text not null,
  uuid uuid not null unique,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table migration.runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb
);

create table migration.checkpoints (
  bubble_type text primary key,
  cursor integer not null,
  updated_at timestamptz not null default now()
);

-- updated_at ------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger organizations_touch before update on public.organizations for each row execute function private.touch_updated_at();
create trigger members_touch before update on public.members for each row execute function private.touch_updated_at();
create trigger subscriptions_touch before update on public.subscriptions for each row execute function private.touch_updated_at();
create trigger reports_touch before update on public.reports for each row execute function private.touch_updated_at();
create trigger crm_opportunities_touch before update on public.crm_opportunities for each row execute function private.touch_updated_at();
