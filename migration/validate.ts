// Post-migration validation. Re-extracts from the Bubble Data API on its own (does not trust the
// migrator's extract) and compares against Supabase. Writes artifacts/validation-report.{json,md}.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { loadLocalEnv } from "../lib/local-env";
import { extractType, fetchJson } from "./bubble-client";
import { bubbleUuid, opt } from "./transform";
import { COUNTS, type BubbleData, type BubbleRecord, type StripeCustomer } from "./mock-bubble/generate";

loadLocalEnv();
const BUBBLE_ROOT = process.env.BUBBLE_ROOT ?? "http://127.0.0.1:8787";
const TOKEN = process.env.BUBBLE_API_TOKEN ?? "mock-bubble-admin-token";

const md5 = (lines: string[]) => createHash("md5").update(lines.sort().join("\n")).digest("hex");
const n = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const day = (v: unknown) => (v ? String(v).slice(0, 10) : "");
const money = (v: unknown) => (v === null || v === undefined || v === "" ? "" : Number(v).toFixed(2));
const email = (u: BubbleRecord) => n((u.authentication as any)?.email?.email).trim().toLowerCase();

// Key fields per type: [label, bubble-side value, sql expression on the target row]
type KeySpec = { table: string; where?: string; fields: [string, (r: BubbleRecord) => string, string][] };
const KEYS: Record<string, KeySpec> = {
  organization: { table: "public.organizations", fields: [["name", (r) => n(r.name), "name"], ["slug", (r) => n(r.slug), "slug"], ["created", (r) => n(r["Created Date"]).slice(0, 19), "to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')"]] },
  user: {
    table: "(select bubble_id, email::text as email, full_name, role::text as role from public.members union all select bubble_id, email::text, full_name, 'researcher' from public.researchers) u",
    fields: [["email", email, "coalesce(email, '')"], ["full_name", (r) => `${n(r.first_name)} ${n(r.last_name)}`.trim(), "full_name"], ["role", (r) => (r.staff_role ? "researcher" : opt("OrgRole", r.role)), "role"]],
  },
  subscription: { table: "public.subscriptions", fields: [["tier", (r) => opt("Tier", r.tier), "tier::text"], ["status", (r) => opt("SubscriptionStatus", r.status), "status::text"], ["stripe_subscription_id", (r) => n(r.stripe_subscription_id), "coalesce(stripe_subscription_id, '')"]] },
  report: { table: "public.reports", fields: [["title", (r) => n(r.title), "title"], ["agency", (r) => opt("Agency", r.agency), "agency::text"], ["tier_required", (r) => opt("Tier", r.tier_required), "tier_required::text"], ["status", (r) => (r.published ? "published" : "draft"), "status::text"]] },
  awarded_contract: { table: "public.awarded_contracts", fields: [["piid", (r) => n(r.piid), "piid"], ["amount", (r) => money(r.amount), "to_char(amount, 'FM9999999999990.00')"], ["award_date", (r) => day(r.award_date), "award_date::text"], ["vendor", (r) => n(r.vendor), "vendor_name"]] },
  contact: { table: "public.contacts", fields: [["name", (r) => n(r.name), "full_name"], ["email", (r) => n(r.email).toLowerCase(), "coalesce(email::text, '')"], ["agency", (r) => opt("Agency", r.agency), "agency::text"]] },
  opportunity: { table: "public.crm_opportunities", fields: [["title", (r) => n(r.title), "title"], ["stage", (r) => opt("OpportunityStage", r.stage), "stage::text"], ["value", (r) => money(r.value), "coalesce(to_char(value, 'FM9999999999990.00'), '')"], ["org", (r) => bubbleUuid(n(r.organization)), "org_id::text"]] },
  note: { table: "public.crm_notes", fields: [["body", (r) => n(r.body), "body"], ["opportunity", (r) => bubbleUuid(n(r.opportunity)), "opportunity_id::text"]] },
  task: { table: "public.crm_tasks", fields: [["title", (r) => n(r.title), "title"], ["done", (r) => String(Boolean(r.done)), "done::text"], ["opportunity", (r) => bubbleUuid(n(r.opportunity)), "opportunity_id::text"]] },
};

const RI_CHECKS: [string, string][] = [
  ["members without an organization", "select count(*) from public.members m left join public.organizations o on o.id = m.org_id where o.id is null"],
  ["members.user_id without an auth user", "select count(*) from public.members m where m.user_id is not null and not exists (select 1 from auth.users u where u.id = m.user_id)"],
  ["auth users without an email identity", "select count(*) from auth.users u where u.email not like '%@fixture.test' and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email')"],
  ["auth users with a password (should be none: magic link first login)", "select count(*) from auth.users u where u.raw_user_meta_data ->> 'migrated_from' = 'bubble' and coalesce(u.encrypted_password, '') <> ''"],
  ["opportunities owned by a member of another org", "select count(*) from public.crm_opportunities o join public.members m on m.id = o.owner_member_id where m.org_id <> o.org_id"],
  ["notes whose org differs from their opportunity's org", "select count(*) from public.crm_notes n join public.crm_opportunities o on o.id = n.opportunity_id where o.org_id <> n.org_id"],
  ["tasks whose org differs from their opportunity's org", "select count(*) from public.crm_tasks t join public.crm_opportunities o on o.id = t.opportunity_id where o.org_id <> t.org_id"],
  ["notes authored by a member of another org", "select count(*) from public.crm_notes n join public.members m on m.id = n.author_member_id where m.org_id <> n.org_id"],
  ["opportunity → report links to missing reports", "select count(*) from public.crm_opportunity_reports x left join public.reports r on r.id = x.report_id where r.id is null"],
  ["subscriptions whose entitlements don't match their tier", "select count(*) from public.subscriptions s where s.bubble_id is not null and (select coalesce(array_agg(feature order by feature), '{}') from public.entitlements e where e.org_id = s.org_id) <> (select coalesce(array_agg(f order by f), '{}') from unnest(private.tier_features(s.tier)) f)"],
  ["id_map entries whose target row is missing", `select count(*) from migration.id_map m where not exists (
      select 1 from public.organizations where id = m.uuid union all select 1 from public.members where id = m.uuid
      union all select 1 from public.researchers where id = m.uuid union all select 1 from public.subscriptions where id = m.uuid
      union all select 1 from public.reports where id = m.uuid union all select 1 from public.awarded_contracts where id = m.uuid
      union all select 1 from public.contacts where id = m.uuid union all select 1 from public.crm_opportunities where id = m.uuid
      union all select 1 from public.crm_notes where id = m.uuid union all select 1 from public.crm_tasks where id = m.uuid)
      and m.bubble_id <> '1698765432123x100000000000000001'`],
  ["report attachments missing from storage", "select count(*) from public.reports r where r.attachment_path is not null and r.bubble_id is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'report-files' and o.name = r.attachment_path)"],
  ["org logos missing from storage", "select count(*) from public.organizations g where g.logo_path is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'org-logos' and o.name = g.logo_path)"],
];

// seeded sampler so the report is reproducible
function sampler(seed: number) {
  let s = seed;
  return (max: number) => ((s = (s * 1103515245 + 12345) % 2147483648), s % max);
}

async function main() {
  const t0 = Date.now();
  let mock: { close: () => void } | undefined;
  if (process.argv.includes("--start-mock")) {
    const { startMockBubble } = await import("./mock-bubble/server");
    mock = await startMockBubble(8787);
  }
  const pool = new pg.Pool({ connectionString: process.env.DB_URL, max: 4 });
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

  const data: BubbleData = {};
  for (const type of Object.keys(COUNTS)) data[type] = (await extractType(type, { baseUrl: `${BUBBLE_ROOT}/api/1.1`, token: TOKEN })).records;
  const stripe: StripeCustomer[] = (await fetchJson(`${BUBBLE_ROOT}/stripe/customers.json`, TOKEN)).data;

  // Row counts --------------------------------------------------------------------------------
  const counts = [];
  for (const [type, spec] of Object.entries(KEYS)) {
    const target = Number((await q(`select count(*) from ${spec.table} where bubble_id is not null`))[0].count);
    counts.push({ type, bubble: data[type].length, supabase: target, match: target === data[type].length });
  }
  const listCounts = [
    { type: "subscription.agencies → subscription_agencies", bubble: data.subscription.reduce((a, s) => a + ((s.agencies as string[]) ?? []).length, 0), supabase: Number((await q("select count(*) from public.subscription_agencies sa join public.subscriptions s on s.id = sa.subscription_id where s.bubble_id is not null"))[0].count) },
    { type: "report.tags → report_tags", bubble: data.report.reduce((a, r) => a + new Set((r.tags as string[]) ?? []).size, 0), supabase: Number((await q("select count(*) from public.report_tags t join public.reports r on r.id = t.report_id where r.bubble_id is not null"))[0].count) },
    { type: "opportunity.linked_reports → crm_opportunity_reports", bubble: data.opportunity.reduce((a, o) => a + new Set((o.linked_reports as string[]) ?? []).size, 0), supabase: Number((await q("select count(*) from public.crm_opportunity_reports x join public.crm_opportunities o on o.id = x.opportunity_id where o.bubble_id is not null"))[0].count) },
    { type: "files (report attachments + org logos) → storage", bubble: data.report.filter((r) => r.attachment).length + data.organization.filter((o) => o.logo).length, supabase: Number((await q("select count(*) from migration.files"))[0].count) },
  ].map((c) => ({ ...c, match: c.bubble === c.supabase }));

  // List-field contents (not just counts): parent bubble id | item
  const agencyCode = (d: string) => opt("Agency", d);
  const listSums: [string, string[], string][] = [
    ["subscription.agencies", data.subscription.flatMap((s) => ((s.agencies as string[]) ?? []).map((a) => `${s._id}|${agencyCode(a)}`)),
      "select s.bubble_id || '|' || sa.agency as l from public.subscription_agencies sa join public.subscriptions s on s.id = sa.subscription_id where s.bubble_id is not null"],
    ["report.tags", data.report.flatMap((r) => [...new Set((r.tags as string[]) ?? [])].map((t) => `${r._id}|${t}`)),
      "select r.bubble_id || '|' || t.tag as l from public.report_tags t join public.reports r on r.id = t.report_id where r.bubble_id is not null"],
    ["opportunity.linked_reports", data.opportunity.flatMap((o) => [...new Set((o.linked_reports as string[]) ?? [])].map((x) => `${o._id}|${x}`)),
      "select o.bubble_id || '|' || r.bubble_id as l from public.crm_opportunity_reports x join public.crm_opportunities o on o.id = x.opportunity_id join public.reports r on r.id = x.report_id where o.bubble_id is not null"],
  ];
  const listChecksums = [];
  for (const [type, bubbleLines, sql] of listSums) {
    const target = (await q(sql)).map((r) => r.l as string);
    const b = md5([...bubbleLines]);
    const t = md5([...target]);
    listChecksums.push({ type, fields: ["parent", "item"], bubble_md5: b, supabase_md5: t, match: b === t, mismatched_rows: b === t ? 0 : bubbleLines.filter((l) => !new Set(target).has(l)).length });
  }

  // Checksums on key fields ---------------------------------------------------------------------
  const checksums = [];
  const targetRows: Record<string, Map<string, Record<string, string>>> = {};
  for (const [type, spec] of Object.entries(KEYS)) {
    const rows = await q(`select bubble_id, ${spec.fields.map(([label, , sql]) => `${sql} as "${label}"`).join(", ")} from ${spec.table} where bubble_id is not null`);
    targetRows[type] = new Map(rows.map((r) => [r.bubble_id, r]));
    const bubbleLines = data[type].map((rec) => [rec._id, ...spec.fields.map(([, f]) => f(rec))].join("|"));
    const targetLines = rows.map((r) => [r.bubble_id, ...spec.fields.map(([label]) => n(r[label]))].join("|"));
    const b = md5(bubbleLines);
    const t = md5(targetLines);
    let mismatched = 0;
    if (b !== t) {
      const tl = new Set(targetLines);
      mismatched = bubbleLines.filter((l) => !tl.has(l)).length;
    }
    checksums.push({ type, fields: spec.fields.map((f) => f[0]), bubble_md5: b, supabase_md5: t, match: b === t, mismatched_rows: mismatched });
  }

  // Random sample diffs: Bubble record vs Supabase row, side by side ----------------------------------
  const rand = sampler(424242);
  const samples = [];
  for (const [type, spec] of Object.entries(KEYS)) {
    for (let i = 0; i < 3; i++) {
      const rec = data[type][rand(data[type].length)];
      const row = targetRows[type].get(rec._id);
      const fields = spec.fields.map(([label, f]) => {
        const bubble = f(rec);
        const supabase = row ? n(row[label]) : "(missing)";
        return { field: label, bubble, supabase, match: bubble === supabase };
      });
      samples.push({ type, bubble_id: rec._id, uuid: bubbleUuid(rec._id), match: fields.every((f) => f.match), fields });
    }
  }

  // Referential integrity ---------------------------------------------------------------------------
  const integrity = [];
  for (const [label, sql] of RI_CHECKS) {
    const v = Number((await q(sql))[0].count);
    integrity.push({ check: label, violations: v, ok: v === 0 });
  }

  // Users without email / duplicates (expected anomalies, surfaced for follow-up) ---------------------
  const noEmail = data.user.filter((u) => !email(u)).map((u) => ({ bubble_id: u._id, name: `${n(u.first_name)} ${n(u.last_name)}`, member_id: bubbleUuid(u._id) }));
  const issuesRows = await q("select kind, bubble_type, bubble_id, detail from migration.issues where run_id = (select max(id) from migration.runs where finished_at is not null) order by kind, bubble_id");

  // Stripe customer ids ↔ orgs ------------------------------------------------------------------------
  const orgs = await q("select bubble_id, name, stripe_customer_id from public.organizations where bubble_id is not null");
  const subscribedOrgs = new Set(data.subscription.map((s) => s.organization as string));
  const custById = new Map(stripe.map((c) => [c.id, c]));
  const orgByCust = new Map(orgs.filter((o) => o.stripe_customer_id).map((o) => [o.stripe_customer_id, o]));
  const matched = orgs.filter((o) => o.stripe_customer_id && custById.get(o.stripe_customer_id)?.metadata.bubble_org_id === o.bubble_id).length;
  const backfilled = issuesRows.filter((i) => i.kind === "stripe_customer_backfilled").length;
  const subscribedWithoutCustomer = orgs.filter((o) => subscribedOrgs.has(o.bubble_id) && !o.stripe_customer_id).map((o) => o.bubble_id);
  const metadataMismatch = orgs.filter((o) => o.stripe_customer_id && custById.has(o.stripe_customer_id) && custById.get(o.stripe_customer_id)!.metadata.bubble_org_id !== o.bubble_id).map((o) => o.bubble_id);
  const orphanCustomers = stripe.filter((c) => !orgByCust.has(c.id)).map((c) => ({ id: c.id, bubble_org_id: c.metadata.bubble_org_id ?? null }));

  // Idempotency: compare the last two runs ------------------------------------------------------------
  const runs = await q("select id, stats from migration.runs where finished_at is not null order by id desc limit 2");
  const idempotency = runs.length === 2 ? {
    first_run: runs[1].id, second_run: runs[0].id,
    second_run_inserted: runs[0].stats.totals.inserted, second_run_updated: runs[0].stats.totals.updated,
    second_run_files_uploaded: runs[0].stats.files.uploaded, ok: runs[0].stats.totals.inserted === 0 && runs[0].stats.totals.updated === 0 && runs[0].stats.files.uploaded === 0,
  } : { ok: false, note: "run the migration twice to check idempotency" };

  const pass = counts.every((c) => c.match) && listCounts.every((c) => c.match) && checksums.every((c) => c.match) && listChecksums.every((c) => c.match)
    && samples.every((s) => s.match) && integrity.every((i) => i.ok) && subscribedWithoutCustomer.length === 0 && metadataMismatch.length === 0 && idempotency.ok;

  const report = {
    generated_at: new Date().toISOString(),
    status: pass ? "pass" : "fail",
    duration_ms: Date.now() - t0,
    bubble_records: Object.values(data).reduce((a, l) => a + l.length, 0),
    counts, list_fields_and_files: listCounts, checksums: [...checksums, ...listChecksums], samples, integrity,
    users_without_email: { count: noEmail.length, users: noEmail },
    issues: issuesRows,
    stripe: { customers_in_export: stripe.length, orgs_with_customer_id: orgs.filter((o) => o.stripe_customer_id).length, matched_by_id_and_metadata: matched, backfilled_from_stripe_metadata: backfilled, subscribed_orgs_without_customer: subscribedWithoutCustomer, metadata_mismatch: metadataMismatch, stripe_customers_without_org: orphanCustomers },
    idempotency,
    last_run: runs[0]?.stats ?? null,
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/validation-report.json", JSON.stringify(report, null, 1));
  writeFileSync("artifacts/validation-report.md", toMarkdown(report));
  console.log(toMarkdown(report).split("\n## Sample")[0]);
  await pool.end();
  mock?.close();
  if (!pass) process.exit(1);
}

function toMarkdown(r: any): string {
  const yes = (b: boolean) => (b ? "✅" : "❌");
  return [
    `# Migration validation — ${r.status.toUpperCase()}`,
    `Generated ${r.generated_at} · ${r.bubble_records} Bubble records · ${r.duration_ms} ms`,
    "", "## Row counts", "| type | Bubble | Supabase | |", "|---|---:|---:|---|",
    ...r.counts.map((c: any) => `| ${c.type} | ${c.bubble} | ${c.supabase} | ${yes(c.match)} |`),
    ...r.list_fields_and_files.map((c: any) => `| ${c.type} | ${c.bubble} | ${c.supabase} | ${yes(c.match)} |`),
    "", "## Key-field checksums (md5)", "| type | fields | Bubble | Supabase | |", "|---|---|---|---|---|",
    ...r.checksums.map((c: any) => `| ${c.type} | ${c.fields.join(", ")} | \`${c.bubble_md5.slice(0, 12)}\` | \`${c.supabase_md5.slice(0, 12)}\` | ${yes(c.match)} |`),
    "", "## Referential integrity", "| check | violations | |", "|---|---:|---|",
    ...r.integrity.map((i: any) => `| ${i.check} | ${i.violations} | ${yes(i.ok)} |`),
    "", "## Stripe customers ↔ organizations",
    `- ${r.stripe.customers_in_export} customers in the Stripe export; ${r.stripe.matched_by_id_and_metadata} orgs matched by id and metadata.bubble_org_id`,
    `- ${r.stripe.backfilled_from_stripe_metadata} customer ids missing in Bubble, backfilled from Stripe metadata`,
    `- ${r.stripe.subscribed_orgs_without_customer.length} subscribed orgs without a customer; ${r.stripe.metadata_mismatch.length} metadata mismatches`,
    `- ${r.stripe.stripe_customers_without_org.length} Stripe customers with no org (deleted in Bubble): ${r.stripe.stripe_customers_without_org.map((c: any) => c.id).join(", ")}`,
    "", "## Users without email", `${r.users_without_email.count} users (migrated as members without a login; need outreach)`,
    "", "## Idempotency", r.idempotency.ok ? `Run #${r.idempotency.second_run} after #${r.idempotency.first_run}: 0 inserted, 0 updated, 0 files uploaded ✅` : `❌ ${JSON.stringify(r.idempotency)}`,
    "", "## Issues carried forward", "| kind | type | Bubble id | detail |", "|---|---|---|---|",
    ...r.issues.map((i: any) => `| ${i.kind} | ${i.bubble_type} | ${i.bubble_id} | ${i.detail} |`),
    "", "## Sample diffs", ...r.samples.map((s: any) => `- ${yes(s.match)} ${s.type} ${s.bubble_id} → ${s.uuid}: ${s.fields.map((f: any) => `${f.field}=${JSON.stringify(f.bubble)}`).join(", ")}`),
    "",
  ].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
