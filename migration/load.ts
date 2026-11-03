// Idempotent batch loader: INSERT … ON CONFLICT DO UPDATE … WHERE IS DISTINCT FROM.
// Re-running with the same input inserts nothing and updates nothing.
import type { Pool, PoolClient } from "pg";

export type Col = [name: string, type: string];
export type TableSpec = {
  table: string;
  cols: Col[];
  key: string[];
  /** list-field join tables: rows for these parents that are no longer in Bubble get removed */
  parent?: string;
};

const T = {
  uuid: "uuid", text: "text", ts: "timestamptz", date: "date", num: "numeric", bool: "boolean", json: "jsonb", citext: "extensions.citext",
};

export const SPECS: Record<string, TableSpec> = {
  organizations: { table: "public.organizations", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["name", T.text], ["slug", T.text], ["stripe_customer_id", T.text], ["logo_path", T.text], ["created_at", T.ts]] },
  members: { table: "public.members", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["org_id", T.uuid], ["user_id", T.uuid], ["email", T.citext], ["full_name", T.text], ["role", "public.member_role"], ["created_at", T.ts]] },
  researchers: { table: "public.researchers", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["user_id", T.uuid], ["email", T.citext], ["full_name", T.text], ["created_at", T.ts]] },
  subscriptions: { table: "public.subscriptions", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["org_id", T.uuid], ["tier", "public.tier"], ["status", "public.subscription_status"], ["stripe_subscription_id", T.text], ["current_period_end", T.ts], ["grace_until", T.ts], ["created_at", T.ts]] },
  subscription_agencies: { table: "public.subscription_agencies", key: ["subscription_id", "agency"], parent: "subscription_id", cols: [["subscription_id", T.uuid], ["agency", "public.agency_code"]] },
  reports: { table: "public.reports", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["title", T.text], ["agency", "public.agency_code"], ["category", "public.report_category"], ["summary", T.text], ["body", T.text], ["attachment_path", T.text], ["tier_required", "public.tier"], ["status", "public.report_status"], ["author_id", T.uuid], ["published_at", T.ts], ["created_at", T.ts]] },
  report_tags: { table: "public.report_tags", key: ["report_id", "tag"], parent: "report_id", cols: [["report_id", T.uuid], ["tag", T.text]] },
  awarded_contracts: { table: "public.awarded_contracts", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["piid", T.text], ["agency", "public.agency_code"], ["vendor_name", T.text], ["naics", T.text], ["amount", T.num], ["award_date", T.date], ["set_aside", "public.set_aside"], ["description", T.text], ["created_at", T.ts]] },
  contacts: { table: "public.contacts", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["agency", "public.agency_code"], ["full_name", T.text], ["title", T.text], ["office", T.text], ["email", T.citext], ["phone", T.text], ["notes", T.text], ["created_at", T.ts]] },
  crm_opportunities: { table: "public.crm_opportunities", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["org_id", T.uuid], ["title", T.text], ["agency", "public.agency_code"], ["stage", "public.opportunity_stage"], ["value", T.num], ["due_date", T.date], ["owner_member_id", T.uuid], ["solicitation_number", T.text], ["created_at", T.ts]] },
  crm_opportunity_reports: { table: "public.crm_opportunity_reports", key: ["opportunity_id", "report_id"], parent: "opportunity_id", cols: [["opportunity_id", T.uuid], ["org_id", T.uuid], ["report_id", T.uuid]] },
  crm_notes: { table: "public.crm_notes", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["org_id", T.uuid], ["opportunity_id", T.uuid], ["author_member_id", T.uuid], ["body", T.text], ["created_at", T.ts]] },
  crm_tasks: { table: "public.crm_tasks", key: ["id"], cols: [["id", T.uuid], ["bubble_id", T.text], ["org_id", T.uuid], ["opportunity_id", T.uuid], ["assignee_member_id", T.uuid], ["title", T.text], ["due_date", T.date], ["done", T.bool], ["created_at", T.ts]] },
  id_map: { table: "migration.id_map", key: ["bubble_id"], cols: [["bubble_id", T.text], ["bubble_type", T.text], ["target_table", T.text], ["uuid", T.uuid]] },
};

export type LoadStats = { rows: number; inserted: number; updated: number; unchanged: number; removed: number; batches: number; ms: number };

export async function upsertBatches(pool: Pool, spec: TableSpec, rows: Record<string, unknown>[], batchSize = 500): Promise<LoadStats> {
  const started = Date.now();
  const names = spec.cols.map((c) => c[0]);
  const recordDef = spec.cols.map(([n, t]) => `"${n}" ${t}`).join(", ");
  const updatable = names.filter((n) => !spec.key.includes(n));
  const conflict = updatable.length
    ? `do update set ${updatable.map((n) => `"${n}" = excluded."${n}"`).join(", ")}
       where (${updatable.map((n) => `${spec.table.split(".")[1]}."${n}"`).join(", ")}) is distinct from (${updatable.map((n) => `excluded."${n}"`).join(", ")})`
    : "do nothing";
  const sql = `insert into ${spec.table} (${names.map((n) => `"${n}"`).join(", ")})
    select ${names.map((n) => `"${n}"`).join(", ")} from jsonb_to_recordset($1::jsonb) as x(${recordDef})
    on conflict (${spec.key.join(", ")}) ${conflict}
    returning (xmax = 0) as inserted`;
  const stats: LoadStats = { rows: rows.length, inserted: 0, updated: 0, unchanged: 0, removed: 0, batches: 0, ms: 0 };

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const res = await client.query(sql, [JSON.stringify(batch)]);
      const ins = res.rows.filter((r) => r.inserted).length;
      stats.inserted += ins;
      stats.updated += res.rows.length - ins;
      stats.unchanged += batch.length - res.rows.length;
      await client.query("commit");
      stats.batches++;
    } catch (e) {
      await client.query("rollback");
      throw new Error(`${spec.table} batch ${i / batchSize}: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  // List fields: remove join rows whose item was taken out of the Bubble list since the last run.
  if (spec.parent) {
    const keyExpr = spec.key.map((k) => `t."${k}"`).join(", ");
    const res = await pool.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb) as x(${recordDef}))
       delete from ${spec.table} t
       where t."${spec.parent}" in (select "${spec.parent}" from input)
         and (${keyExpr}) not in (select ${spec.key.map((k) => `"${k}"`).join(", ")} from input)`,
      [JSON.stringify(rows)],
    );
    stats.removed = res.rowCount ?? 0;
  }
  stats.ms = Date.now() - started;
  return stats;
}

// Passwordless auth users. Users sign in with a magic link on first login (see lib/auth/first-login.ts).
export async function upsertAuthUsers(pool: Pool, users: Record<string, unknown>[]): Promise<LoadStats> {
  const started = Date.now();
  const stats: LoadStats = { rows: users.length, inserted: 0, updated: 0, unchanged: 0, removed: 0, batches: 0, ms: 0 };
  for (let i = 0; i < users.length; i += 500) {
    const batch = users.slice(i, i + 500);
    const client: PoolClient = await pool.connect();
    try {
      await client.query("begin");
      const res = await client.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
           confirmation_token, recovery_token, email_change_token_new, email_change)
         select x.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x.email, '', x.email_confirmed_at,
           '{"provider":"email","providers":["email"]}'::jsonb, x.raw_user_meta_data, x.created_at, x.created_at, '', '', '', ''
         from jsonb_to_recordset($1::jsonb) as x(id uuid, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb, created_at timestamptz)
         on conflict (id) do update set email = excluded.email, raw_user_meta_data = auth.users.raw_user_meta_data || excluded.raw_user_meta_data
         where auth.users.email is distinct from excluded.email or not (auth.users.raw_user_meta_data @> excluded.raw_user_meta_data)
         returning (xmax = 0) as inserted`,
        [JSON.stringify(batch)],
      );
      await client.query(
        `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
         select x.id::text, x.id, jsonb_build_object('sub', x.id::text, 'email', x.email, 'email_verified', true), 'email', x.created_at, x.created_at
         from jsonb_to_recordset($1::jsonb) as x(id uuid, email text, created_at timestamptz)
         on conflict (provider_id, provider) do nothing`,
        [JSON.stringify(batch)],
      );
      await client.query("commit");
      const ins = res.rows.filter((r) => r.inserted).length;
      stats.inserted += ins;
      stats.updated += res.rows.length - ins;
      stats.unchanged += batch.length - res.rows.length;
      stats.batches++;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  stats.ms = Date.now() - started;
  return stats;
}
