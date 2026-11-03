// Runs every supabase/tests/*.test.sql through psql, parses TAP, writes artifacts/pgtap-results.json.
// Then runs a mutation check: deliberately weakens policies and asserts the matrix notices.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const DB = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:57422/postgres";
const dir = "supabase/tests";
mkdirSync("artifacts", { recursive: true });

function runSql(sql: string): string {
  try {
    return execFileSync("psql", [DB, "-X", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e: any) {
    return String(e.stdout ?? "") + "\nnot ok 0 - psql error: " + String(e.stderr ?? e.message).split("\n")[0];
  }
}

type Result = { file: string; n: number; ok: boolean; desc: string };
function parse(file: string, out: string): Result[] {
  const res: Result[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(not ok|ok) (\d+) - (.*)$/);
    if (m) res.push({ file, n: Number(m[2]), ok: m[1] === "ok", desc: m[3] });
  }
  return res;
}

const started = Date.now();
const results: Result[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".test.sql")).sort()) {
  const sql = readFileSync(`${dir}/${f}`, "utf8");
  const planned = Number(sql.match(/select plan\((\d+)\)/)?.[1] ?? 0);
  const r = parse(f, runSql(sql));
  if (r.length !== planned) r.push({ file: f, n: 0, ok: false, desc: `planned ${planned}, ran ${r.length}` });
  results.push(...r);
  console.log(`${f}: ${r.filter((x) => x.ok).length}/${r.length} ok`);
}

// Mutation check: each mutation must make the matrix fail somewhere, otherwise the tests are blind to it.
const MUTATIONS: { name: string; sql: string }[] = [
  { name: "crm_notes readable by any signed-in user", sql: "drop policy crm_notes_select_member on public.crm_notes; create policy crm_notes_select_member on public.crm_notes for select to authenticated using (true);" },
  { name: "crm_opportunities WITH CHECK (true) and tenant FKs dropped: deals can be moved to another org", sql: "drop policy crm_opportunities_update_member on public.crm_opportunities; create policy crm_opportunities_update_member on public.crm_opportunities for update to authenticated using (private.is_org_member(org_id)) with check (true); alter table public.crm_opportunities drop constraint crm_opportunities_owner_member_id_org_id_fkey; alter table public.crm_notes drop constraint crm_notes_opportunity_id_org_id_fkey; alter table public.crm_tasks drop constraint crm_tasks_opportunity_id_org_id_fkey; alter table public.crm_opportunity_reports drop constraint crm_opportunity_reports_opportunity_id_org_id_fkey;" },
  { name: "grace period ignored (past_due keeps access forever)", sql: "create or replace function private.good_standing(p_status public.subscription_status, p_grace_until timestamptz) returns boolean language sql stable set search_path = '' as $$ select p_status in ('active','trialing','past_due') $$;" },
  { name: "agency entitlement not checked", sql: "create or replace function private.current_agencies() returns public.agency_code[] language sql stable security definer set search_path = '' as $$ select enum_range(null::public.agency_code) $$;" },
  { name: "stripe_customer_id column granted", sql: "grant select (stripe_customer_id) on public.organizations to authenticated;" },
  { name: "member role directly updatable", sql: "grant update (role) on public.members to authenticated;" },
  { name: "researchers can read CRM", sql: "drop policy crm_tasks_select_member on public.crm_tasks; create policy crm_tasks_select_member on public.crm_tasks for select to authenticated using (private.is_org_member(org_id) or private.is_researcher());" },
  { name: "anon granted select on contacts base table", sql: "grant select on public.contacts to anon; create policy contacts_anon on public.contacts for select to anon using (true);" },
];
const matrix = readFileSync(`${dir}/10_privacy_matrix.test.sql`, "utf8");
const mutations = MUTATIONS.map((m) => {
  const out = runSql(matrix.replace(/^begin;\n/m, () => `begin;\n${m.sql}\n`));
  const failed = parse("mutation", out).filter((r) => !r.ok).map((r) => r.desc);
  console.log(`mutation "${m.name}": ${failed.length ? `caught by ${failed.length} assertions` : "NOT CAUGHT"}`);
  return { name: m.name, caught: failed.length > 0, failing_assertions: failed.length, examples: failed.slice(0, 4) };
});

const summary = {
  generated_at: new Date().toISOString(),
  duration_ms: Date.now() - started,
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  mutations_caught: mutations.filter((m) => m.caught).length,
  mutations_total: mutations.length,
};
writeFileSync("artifacts/pgtap-results.json", JSON.stringify({ summary, results, mutations }, null, 1));
console.log(JSON.stringify(summary));
if (summary.failed > 0 || summary.mutations_caught !== summary.mutations_total) process.exit(1);
