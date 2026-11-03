-- Bubble privacy rules → Postgres. Source of truth: privacy-rules.yaml.
--
-- Row-level:    RLS policies on every public table, all built from a handful of helpers below.
-- Column-level: RLS cannot hide columns, so restricted fields use either column GRANTs
--               (stripe ids, member role) or security-barrier views that mask with CASE
--               (report summary/body/attachment, contact email/phone). Base tables behind
--               those views are researcher-only.

-- Hardening: nothing in public is reachable unless granted below.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on schema ops, migration from public, anon, authenticated;
grant usage on schema ops, migration to service_role;
grant all on all tables in schema ops, migration to service_role;
grant usage on schema private to anon, authenticated; -- execute-only helpers; schema is not exposed by the API

-- Helpers (security definer: they read membership without recursing through RLS) ------------

create function private.current_member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.members m where m.user_id = (select auth.uid())
$$;

create function private.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.members m where m.user_id = (select auth.uid())
$$;

create function private.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org is not null and exists (
    select 1 from public.members m where m.user_id = (select auth.uid()) and m.org_id = p_org
  )
$$;

create function private.has_org_role(p_org uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org is not null and exists (
    select 1 from public.members m
    where m.user_id = (select auth.uid()) and m.org_id = p_org and m.role = any (p_roles)
  )
$$;

create function private.current_member_role() returns public.member_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.members m where m.user_id = (select auth.uid())
$$;

create function private.is_researcher() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.researchers r where r.user_id = (select auth.uid()))
$$;

-- "in good standing": paid and current, or inside the grace window after a failed invoice.
create function private.good_standing(p_status public.subscription_status, p_grace_until timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select p_status in ('active', 'trialing') or (p_status = 'past_due' and p_grace_until is not null and now() < p_grace_until)
$$;

-- Features the caller's org currently has. Empty when the subscription is not in good standing,
-- so a lapsed payment removes access everywhere without touching a single policy.
create function private.current_features() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(e.feature order by e.feature), '{}')
  from public.entitlements e
  join public.subscriptions s on s.org_id = e.org_id
  where e.org_id = private.current_org_id() and private.good_standing(s.status, s.grace_until)
$$;

create function private.has_entitlement(p_feature text) returns boolean
language sql stable set search_path = '' as $$
  select p_feature = any (private.current_features())
$$;

create function private.current_agencies() returns public.agency_code[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(sa.agency order by sa.agency), '{}')
  from public.subscriptions s
  join public.subscription_agencies sa on sa.subscription_id = s.id
  where s.org_id = private.current_org_id()
$$;

create function private.can_read_report(p_tier public.tier, p_agency public.agency_code) returns boolean
language sql stable set search_path = '' as $$
  select private.is_researcher() or (
    ('reports.read.' || p_tier::text) = any (f.features)
    and (p_agency = any (private.current_agencies()) or 'agencies.all' = any (f.features))
  )
  from (select private.current_features() as features) f
$$;

-- storage object names are "<report uuid>/<file>"; compared as text so junk names can't raise.
create function private.can_read_report_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reports r
    where r.id::text = split_part(p_name, '/', 1)
      and (private.is_researcher() or (r.status = 'published' and private.can_read_report(r.tier_required, r.agency)))
  )
$$;

create function private.can_read_org_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m
    where m.user_id = (select auth.uid()) and m.org_id::text = split_part(p_name, '/', 1)
  )
$$;

-- Tier → entitlement rows (mirrors privacy-rules.yaml `entitlements`).
create function private.tier_features(p_tier public.tier) returns text[]
language sql immutable set search_path = '' as $$
  select case p_tier
    when 'free' then '{}'::text[]
    when 'basic' then array['reports.preview', 'reports.read.basic', 'contracts.search', 'contacts.directory']
    when 'pro' then array['reports.preview', 'reports.read.basic', 'reports.read.pro', 'contracts.search', 'contacts.directory', 'contacts.full']
    when 'enterprise' then array['reports.preview', 'reports.read.basic', 'reports.read.pro', 'reports.read.enterprise', 'contracts.search', 'contacts.directory', 'contacts.full', 'agencies.all']
  end
$$;

create function private.sync_entitlements() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.entitlements e
  where e.org_id = new.org_id and not (e.feature = any (private.tier_features(new.tier)));
  insert into public.entitlements (org_id, feature)
  select new.org_id, f from unnest(private.tier_features(new.tier)) f
  on conflict do nothing;
  return new;
end $$;

create trigger subscriptions_sync_entitlements
after insert or update of tier on public.subscriptions
for each row execute function private.sync_entitlements();

revoke all on all functions in schema private from public;
grant execute on function
  private.current_member_id(), private.current_org_id(), private.current_member_role(), private.is_org_member(uuid),
  private.has_org_role(uuid, public.member_role[]), private.is_researcher(),
  private.good_standing(public.subscription_status, timestamptz), private.current_features(),
  private.has_entitlement(text), private.current_agencies(), private.can_read_report(public.tier, public.agency_code),
  private.can_read_report_file(text), private.can_read_org_file(text)
to anon, authenticated;

-- Defaults so clients never have to (and cannot usefully) send tenant ids for their own rows.
alter table public.crm_opportunities alter column org_id set default private.current_org_id();
alter table public.crm_notes alter column org_id set default private.current_org_id();
alter table public.crm_notes alter column author_member_id set default private.current_member_id();
alter table public.crm_tasks alter column org_id set default private.current_org_id();

-- RLS ----------------------------------------------------------------------------------------
alter table public.agencies enable row level security;
alter table public.organizations enable row level security;
alter table public.members enable row level security;
alter table public.researchers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_agencies enable row level security;
alter table public.entitlements enable row level security;
alter table public.reports enable row level security;
alter table public.report_tags enable row level security;
alter table public.awarded_contracts enable row level security;
alter table public.contacts enable row level security;
alter table public.crm_opportunities enable row level security;
alter table public.crm_opportunity_reports enable row level security;
alter table public.crm_notes enable row level security;
alter table public.crm_tasks enable row level security;
alter table ops.stripe_events enable row level security;
alter table ops.email_outbox enable row level security;
alter table migration.id_map enable row level security;

create policy agencies_select_all on public.agencies for select to anon, authenticated using (true);

-- organization: "Current User's organization is This Organization"
create policy organizations_select_member on public.organizations for select to authenticated
  using (id = (select private.current_org_id()));
create policy organizations_update_manager on public.organizations for update to authenticated
  using ((id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}'))) with check ((id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}')));

-- member
create policy members_select_same_org on public.members for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy members_insert_manager on public.members for insert to authenticated
  with check (
    (org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}'))
    and (role <> 'owner' or (org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner}')))
  );
create policy members_update_self_or_manager on public.members for update to authenticated
  using (user_id = (select auth.uid()) or (org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}')))
  with check (org_id = (select private.current_org_id()));
create policy members_delete_manager on public.members for delete to authenticated
  using ((org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}')) and role <> 'owner');

-- researcher (internal staff)
create policy researchers_select_researcher on public.researchers for select to authenticated
  using ((select private.is_researcher()));

-- subscription / entitlements: readable by the org, writable only by the webhook (service role)
create policy subscriptions_select_member on public.subscriptions for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy subscription_agencies_select_member on public.subscription_agencies for select to authenticated
  using (exists (select 1 from public.subscriptions s where s.id = subscription_id and private.is_org_member(s.org_id)));
create policy entitlements_select_member on public.entitlements for select to authenticated
  using (org_id = (select private.current_org_id()));

-- report base table: researcher workspace only; subscribers read through report_library
create policy reports_select_researcher on public.reports for select to authenticated using ((select private.is_researcher()));
create policy reports_insert_researcher on public.reports for insert to authenticated with check ((select private.is_researcher()));
create policy reports_update_researcher on public.reports for update to authenticated
  using ((select private.is_researcher())) with check ((select private.is_researcher()));
create policy report_tags_select_researcher on public.report_tags for all to authenticated
  using ((select private.is_researcher())) with check ((select private.is_researcher()));

-- awarded contracts: any subscriber in good standing
create policy awarded_contracts_select_subscriber on public.awarded_contracts for select to authenticated
  using ((select private.is_researcher()) or (select private.has_entitlement('contracts.search')));

-- contacts base table: researchers; subscribers read through contacts_directory
create policy contacts_select_researcher on public.contacts for select to authenticated using ((select private.is_researcher()));
create policy contacts_update_researcher on public.contacts for update to authenticated
  using ((select private.is_researcher())) with check ((select private.is_researcher()));

-- capture CRM: strictly the owning org. No researcher clause, no service bypass in the app.
create policy crm_opportunities_select_member on public.crm_opportunities for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy crm_opportunities_insert_member on public.crm_opportunities for insert to authenticated
  with check (org_id = (select private.current_org_id()));
create policy crm_opportunities_update_member on public.crm_opportunities for update to authenticated
  using (org_id = (select private.current_org_id())) with check (org_id = (select private.current_org_id()));
create policy crm_opportunities_delete_manager on public.crm_opportunities for delete to authenticated
  using ((org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}')));

create policy crm_opportunity_reports_member on public.crm_opportunity_reports for all to authenticated
  using (org_id = (select private.current_org_id())) with check (org_id = (select private.current_org_id()));

create policy crm_notes_select_member on public.crm_notes for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy crm_notes_insert_member on public.crm_notes for insert to authenticated
  with check (org_id = (select private.current_org_id()) and author_member_id = (select private.current_member_id()));
create policy crm_notes_update_author on public.crm_notes for update to authenticated
  using (org_id = (select private.current_org_id()) and author_member_id = (select private.current_member_id()))
  with check (org_id = (select private.current_org_id()) and author_member_id = (select private.current_member_id()));
create policy crm_notes_delete_author_or_manager on public.crm_notes for delete to authenticated
  using (org_id = (select private.current_org_id()) and (author_member_id = (select private.current_member_id()) or (org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}'))));

create policy crm_tasks_select_member on public.crm_tasks for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy crm_tasks_insert_member on public.crm_tasks for insert to authenticated
  with check (org_id = (select private.current_org_id()));
create policy crm_tasks_update_member on public.crm_tasks for update to authenticated
  using (org_id = (select private.current_org_id())) with check (org_id = (select private.current_org_id()));
create policy crm_tasks_delete_manager on public.crm_tasks for delete to authenticated
  using ((org_id = (select private.current_org_id()) and (select private.current_member_role()) = any ('{owner,admin}')));

-- Column-level protection: views ----------------------------------------------------------
-- These run with the view owner's rights (deliberately not security_invoker) so they can read
-- the researcher-only base tables, and apply the subscriber rules themselves. security_barrier
-- stops caller-supplied predicates from being evaluated before the view's own filter.

create view public.report_library with (security_barrier = true) as
with ctx as materialized (
  select private.is_researcher() as researcher, private.current_features() as feats, private.current_agencies() as ags
)
select
  r.id,
  r.title,
  r.agency,
  a.name as agency_name,
  r.tier_required,
  r.published_at,
  case when c.subscriber then r.category end as category,
  case when c.subscriber then r.summary end as summary,
  case when c.subscriber then rs.full_name end as author_name,
  case when c.subscriber then (select array_agg(t.tag order by t.tag) from public.report_tags t where t.report_id = r.id) end as tags,
  u.unlocked,
  case when u.unlocked then r.body end as body,
  case when u.unlocked then r.attachment_path end as attachment_path
from public.reports r
join public.agencies a on a.code = r.agency
left join public.researchers rs on rs.id = r.author_id
cross join ctx
cross join lateral (select ctx.researcher or 'reports.preview' = any (ctx.feats) as subscriber) c
cross join lateral (
  select ctx.researcher or (
    ('reports.read.' || r.tier_required::text) = any (ctx.feats)
    and (r.agency = any (ctx.ags) or 'agencies.all' = any (ctx.feats))
  ) as unlocked
) u
where r.status = 'published';

create view public.contacts_directory with (security_barrier = true) as
with ctx as materialized (
  select private.is_researcher() as researcher, private.current_features() as feats
)
select
  c.id,
  c.agency,
  a.name as agency_name,
  c.full_name,
  c.title,
  c.office,
  case when ctx.researcher or 'contacts.full' = any (ctx.feats) then c.email::text end as email,
  case when ctx.researcher or 'contacts.full' = any (ctx.feats) then c.phone end as phone,
  (ctx.researcher or 'contacts.full' = any (ctx.feats)) as full_access
from public.contacts c
join public.agencies a on a.code = c.agency
cross join ctx
where ctx.researcher or 'contacts.directory' = any (ctx.feats);

-- RPCs (the only write paths for restricted fields) ------------------------------------------

create function public.set_member_role(p_member uuid, p_role public.member_role) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.members;
begin
  select * into v_target from public.members where id = p_member;
  -- same error whether the member doesn't exist or belongs to another org: no existence oracle
  if v_target.id is null or not private.has_org_role(v_target.org_id, '{owner}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_target.role = 'owner' and p_role <> 'owner'
     and (select count(*) from public.members where org_id = v_target.org_id and role = 'owner') <= 1 then
    raise exception 'cannot demote the last owner' using errcode = '23514';
  end if;
  update public.members set role = p_role where id = p_member;
  return p_role::text;
end $$;

create function public.billing_details()
returns table (org_id uuid, tier public.tier, status public.subscription_status, stripe_customer_id text,
               stripe_subscription_id text, current_period_end timestamptz, grace_until timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.current_org_id();
begin
  if not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select o.id, s.tier, s.status, o.stripe_customer_id, s.stripe_subscription_id, s.current_period_end, s.grace_until
    from public.organizations o left join public.subscriptions s on s.org_id = o.id
    where o.id = v_org;
end $$;

-- What the caller can do, for the UI's role badge. Only ever describes the caller.
create function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', (select auth.uid()),
    'member_id', m.id,
    'org_id', m.org_id,
    'org_name', o.name,
    'role', m.role,
    'is_researcher', private.is_researcher(),
    'tier', s.tier,
    'status', s.status,
    'grace_until', s.grace_until,
    'good_standing', coalesce(private.good_standing(s.status, s.grace_until), false),
    'features', private.current_features(),
    'agencies', private.current_agencies()
  )
  from (select 1) one
  left join public.members m on m.user_id = (select auth.uid())
  left join public.organizations o on o.id = m.org_id
  left join public.subscriptions s on s.org_id = m.org_id
$$;

revoke all on function public.set_member_role(uuid, public.member_role), public.billing_details(), public.my_access() from public, anon;
grant execute on function public.set_member_role(uuid, public.member_role), public.billing_details(), public.my_access() to authenticated;

-- Grants (column-level where fields are restricted) ----------------------------------------
grant select on public.agencies to anon, authenticated;
grant select on public.report_library, public.contacts_directory to anon, authenticated;

grant select (id, name, slug, logo_path, created_at, updated_at) on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;

grant select (id, org_id, user_id, email, full_name, role, created_at, updated_at) on public.members to authenticated;
grant insert (org_id, email, full_name, role) on public.members to authenticated;
grant update (full_name) on public.members to authenticated;
grant delete on public.members to authenticated;

grant select on public.researchers to authenticated;

grant select (id, org_id, tier, status, current_period_end, grace_until) on public.subscriptions to authenticated;
grant select on public.subscription_agencies, public.entitlements to authenticated;

grant select, insert, update on public.reports to authenticated;
grant select, insert, delete on public.report_tags to authenticated;
grant select on public.awarded_contracts to authenticated;
grant select, update on public.contacts to authenticated;

grant select, insert, update, delete on public.crm_opportunities, public.crm_notes, public.crm_tasks to authenticated;
grant select, insert, delete on public.crm_opportunity_reports to authenticated;

-- Storage --------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values
  ('report-files', 'report-files', false),
  ('org-logos', 'org-logos', false)
on conflict (id) do nothing;

create policy report_files_select_entitled on storage.objects for select to authenticated
  using (bucket_id = 'report-files' and private.can_read_report_file(name));
create policy report_files_insert_researcher on storage.objects for insert to authenticated
  with check (bucket_id = 'report-files' and private.is_researcher());
create policy org_logos_select_member on storage.objects for select to authenticated
  using (bucket_id = 'org-logos' and private.can_read_org_file(name));
