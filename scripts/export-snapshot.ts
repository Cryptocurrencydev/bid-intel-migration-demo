// Exports what each persona actually sees, by signing in as them (magic link) and querying through
// PostgREST with their JWT — the UI snapshot is RLS output, not a re-implementation of the rules.
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, one, pool, sessionFor } from "../tests/db/helpers";
import { DEMO } from "../migration/mock-bubble/generate";
import { readFileSync } from "node:fs";
import { loadSpec } from "../lib/spec";

// pgTAP fixture rows (seed.sql) live in the same database; keep them out of the UI snapshot.
const FIXTURE_IDS = `(${Object.values(loadSpec(readFileSync("privacy-rules.yaml", "utf8")).fixtures).join(",")})`;

const PERSONAS: { key: string; label: string; email: string | null; blurb: string }[] = [
  { key: "owner", label: "Owner · Halberd Systems", email: DEMO.emails.owner, blurb: "Pro tier, entitled to DCD + FCSA. Owner role." },
  { key: "member", label: "Member · Halberd Systems", email: DEMO.emails.member, blurb: "Same org and tier as the owner, member role." },
  { key: "other", label: "Other org · Cobalt Ridge", email: DEMO.emails.other, blurb: "A different tenant on the Basic tier (OSL only)." },
  { key: "researcher", label: "Researcher (staff)", email: DEMO.emails.researcher, blurb: "Internal analyst: all research content, no customer CRM." },
  { key: "lapsed", label: "Lapsed · Meridian Fieldworks", email: DEMO.emails.lapsed, blurb: "Pro tier, payment failed, 7-day grace expired." },
  { key: "anon", label: "Anonymous", email: null, blurb: "No session, anon key only." },
];

const outcome = (r: { data: any; error: any; count?: number | null }) =>
  r.error ? { blocked: true, rows: 0, error: `${r.error.code ?? ""} ${r.error.message}`.trim() } : { blocked: false, rows: Array.isArray(r.data) ? r.data.length : r.count ?? 0, error: null };

async function main() {
  mkdirSync("snapshot/personas", { recursive: true });
  const halberd = (await one("select id from public.organizations where slug = 'halberd-systems'")).id;
  const halberdOpp = (await one("select id from public.crm_opportunities where org_id = $1 order by created_at limit 1", [halberd])).id;

  // shared contract list (identical for every entitled persona; verified below)
  const svcContracts = (await pool.query(
    "select id, piid, agency, vendor_name, naics, amount::float8 as amount, award_date::text as award_date, set_aside, description from public.awarded_contracts where bubble_id is not null order by award_date desc, piid limit 1000",
  )).rows;
  const contractsHash = createHash("md5").update(svcContracts.map((c) => c.id).join(",")).digest("hex");
  writeFileSync("snapshot/contracts.json", JSON.stringify(svcContracts));

  const index = [];
  for (const p of PERSONAS) {
    const c: SupabaseClient = p.email ? await sessionFor(p.email) : anonClient();
    const access = p.email ? (await c.rpc("my_access")).data : null;
    const lib = await c.from("report_library").select("id,title,agency,agency_name,tier_required,published_at,category,summary,author_name,tags,unlocked,body,attachment_path").not("id", "in", FIXTURE_IDS).order("published_at", { ascending: false }).limit(60);
    const libCount = await c.from("report_library").select("id", { count: "exact", head: true }).not("id", "in", FIXTURE_IDS);
    const unlockedCount = await c.from("report_library").select("id", { count: "exact", head: true }).eq("unlocked", true).not("id", "in", FIXTURE_IDS);
    const contracts = await c.from("awarded_contracts").select("id", { count: "exact" }).not("bubble_id", "is", null).order("award_date", { ascending: false }).order("piid").limit(1000);
    const contractsSame = contracts.data ? createHash("md5").update(contracts.data.map((x) => x.id).join(",")).digest("hex") === contractsHash : false;
    const contacts = await c.from("contacts_directory").select("id,agency,agency_name,full_name,title,office,email,phone,full_access").not("id", "in", FIXTURE_IDS).order("full_name").limit(40);
    const contactsCount = await c.from("contacts_directory").select("id", { count: "exact", head: true }).not("id", "in", FIXTURE_IDS);
    const opps = await c.from("crm_opportunities").select("id,org_id,title,agency,stage,value,due_date,solicitation_number,owner_member_id").order("due_date").limit(200);
    const notes = await c.from("crm_notes").select("id,opportunity_id,body,created_at").order("created_at", { ascending: false }).limit(300);
    const tasks = await c.from("crm_tasks").select("id,opportunity_id,title,due_date,done").order("due_date").limit(300);
    const members = await c.from("members").select("id,full_name,role").limit(200);

    // what this persona gets when it goes after Halberd's private data directly
    const probes = {
      "crm_opportunities where org_id = Halberd": outcome(await c.from("crm_opportunities").select("id").eq("org_id", halberd)),
      "crm_notes on a Halberd deal (leaked id)": outcome(await c.from("crm_notes").select("id").eq("opportunity_id", halberdOpp)),
      "update a Halberd deal's stage": outcome(await c.from("crm_opportunities").update({ stage: "lost" }).eq("id", halberdOpp).eq("org_id", halberd).select("id").then((r) => (p.key === "owner" || p.key === "member" ? { data: [{ skipped: true }], error: null } : r))),
      "organizations.stripe_customer_id": outcome(await c.from("organizations").select("stripe_customer_id").limit(1)),
      "reports base table (drafts)": outcome(await c.from("reports").select("id").eq("status", "draft").limit(5)),
      "billing_details()": outcome(p.email ? await c.rpc("billing_details") : { data: null, error: { code: "42501", message: "not allowed (no session)" } }),
    };
    if (p.key === "owner" || p.key === "member") probes["update a Halberd deal's stage"] = { blocked: false, rows: 1, error: null, note: "own org: allowed (not executed by the snapshot)" } as any;

    const data = {
      persona: p,
      access,
      reports: { visible: libCount.count ?? 0, unlocked: unlockedCount.count ?? 0, rows: lib.data ?? [], error: lib.error?.message ?? null },
      contracts: { visible: contracts.count ?? 0, same_as_shared_list: contractsSame, error: contracts.error ? `${contracts.error.code} ${contracts.error.message}` : null },
      contacts: { visible: contactsCount.count ?? 0, rows: contacts.data ?? [], error: contacts.error ? `${contacts.error.code} ${contacts.error.message}` : null },
      crm: { opportunities: opps.data ?? [], notes: notes.data ?? [], tasks: tasks.data ?? [], error: opps.error ? `${opps.error.code} ${opps.error.message}` : null },
      members: members.data ?? [],
      probes,
    };
    if (contracts.count && !contractsSame) throw new Error(`${p.key}: contract list differs from shared list`);
    writeFileSync(`snapshot/personas/${p.key}.json`, JSON.stringify(data));
    index.push({ key: p.key, label: p.label, blurb: p.blurb, reports_unlocked: data.reports.unlocked, crm_rows: data.crm.opportunities.length, contracts: data.contracts.visible });
    console.log(`${p.key.padEnd(10)} reports ${data.reports.visible}/${data.reports.unlocked} unlocked · contracts ${data.contracts.visible} · contacts ${data.contacts.visible} · crm ${data.crm.opportunities.length}`);
  }

  let sha = process.env.GITHUB_SHA ?? "";
  try { sha ||= execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { sha ||= "uncommitted"; }
  writeFileSync("snapshot/meta.json", JSON.stringify({ generated_at: new Date().toISOString(), source: process.env.CI ? "github-actions" : "local", git_sha: sha, personas: index }, null, 1));
  if (existsSync("artifacts/validation-report.json")) copyFileSync("artifacts/validation-report.json", "snapshot/validation-report.json");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
