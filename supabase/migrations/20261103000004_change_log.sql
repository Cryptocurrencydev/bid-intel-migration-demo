-- Post-cutover change log for tenant data. If we roll back to Bubble, every write made in the new
-- system after cutover is replayed from here (migration/replay-to-bubble.ts).
create table ops.change_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  op text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  row_id uuid not null,
  org_id uuid,
  actor uuid,
  data jsonb
);
create index change_log_at_idx on ops.change_log (at);
alter table ops.change_log enable row level security;
grant select on ops.change_log to service_role;

create function private.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
begin
  -- the migrator itself writes as postgres without a JWT; only app writes are logged
  if current_setting('request.jwt.claims', true) is null or current_setting('request.jwt.claims', true) = '' then
    return null;
  end if;
  insert into ops.change_log (table_name, op, row_id, org_id, actor, data)
  values (tg_table_name, tg_op, (r ->> 'id')::uuid, (r ->> 'org_id')::uuid, (select auth.uid()), case when tg_op = 'DELETE' then null else r end);
  return null;
end $$;

create trigger crm_opportunities_log after insert or update or delete on public.crm_opportunities for each row execute function private.log_change();
create trigger crm_notes_log after insert or update or delete on public.crm_notes for each row execute function private.log_change();
create trigger crm_tasks_log after insert or update or delete on public.crm_tasks for each row execute function private.log_change();
create trigger members_log after insert or update or delete on public.members for each row execute function private.log_change();
create trigger organizations_log after update on public.organizations for each row execute function private.log_change();
