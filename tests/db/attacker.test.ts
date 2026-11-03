// Attacker suite: real PostgREST/Storage/Auth over HTTP with supabase-js, against the migrated data.
// Victim tenant: Halberd Systems. Attackers: anonymous (anon key), Cobalt Ridge (another org),
// a Halberd member (privilege escalation), an internal researcher, and a lapsed subscriber.
// Victim ids are assumed leaked (looked up with the service connection) — RLS must hold anyway.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { anonClient, env, one, pool, sessionFor } from "./helpers";
import { DEMO } from "../../migration/mock-bubble/generate";
import { bubbleUuid } from "../../migration/transform";

let anon: SupabaseClient, other: SupabaseClient, member: SupabaseClient, researcher: SupabaseClient, lapsed: SupabaseClient, owner: SupabaseClient;
const v: Record<string, any> = {};

const blocked = (r: { data: any; error: any }) => r.error !== null || (Array.isArray(r.data) ? r.data.length === 0 : r.data === null);

function forgeJwt(payload: Record<string, unknown>, secret: string, alg = "HS256") {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg, typ: "JWT" });
  const body = b64({ aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...payload });
  const sig = alg === "none" ? "" : createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const withToken = (token: string) =>
  createClient(env.url, env.anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });

beforeAll(async () => {
  anon = anonClient();
  [owner, member, other, researcher, lapsed] = await Promise.all([
    sessionFor(DEMO.emails.owner), sessionFor(DEMO.emails.member), sessionFor(DEMO.emails.other), sessionFor(DEMO.emails.researcher), sessionFor(DEMO.emails.lapsed),
  ]);
  v.halberd = (await one("select id from public.organizations where slug = 'halberd-systems'")).id;
  v.cobalt = (await one("select id from public.organizations where slug = 'cobalt-ridge-federal'")).id;
  v.opp = (await one("select id from public.crm_opportunities where org_id = $1 order by created_at limit 1", [v.halberd])).id;
  v.oppStage = (await one("select stage from public.crm_opportunities where id = $1", [v.opp])).stage;
  v.cobaltOpp = (await one("select id from public.crm_opportunities where org_id = $1 limit 1", [v.cobalt])).id;
  v.halberdOpps = (await one("select count(*)::int n from public.crm_opportunities where org_id = $1", [v.halberd])).n;
  v.cobaltOpps = (await one("select count(*)::int n from public.crm_opportunities where org_id = $1", [v.cobalt])).n;
  v.halberdMember = (await one("select id from public.members where org_id = $1 and role = 'member' limit 1", [v.halberd])).id;
  v.samMember = (await one("select id from public.members where email = $1", [DEMO.emails.member])).id;
  v.ownerUser = (await one("select user_id from public.members where email = $1", [DEMO.emails.owner])).user_id;
  v.proDcdFile = (await one("select attachment_path from public.reports where status = 'published' and tier_required = 'pro' and agency = 'DCD' and attachment_path is not null and bubble_id is not null limit 1")).attachment_path;
  v.draftId = (await one("select id from public.reports where status = 'draft' and bubble_id is not null limit 1")).id;
});
afterAll(async () => {
  await pool.end();
});

describe("anonymous (anon key, no session)", () => {
  for (const t of ["crm_opportunities", "crm_notes", "crm_tasks", "members", "organizations", "subscriptions", "entitlements", "awarded_contracts", "reports", "contacts", "researchers"]) {
    it(`cannot read ${t}`, async () => {
      expect(blocked(await anon.from(t).select("id").limit(5))).toBe(true);
    });
  }
  it("sees report titles but never a summary, body or attachment path", async () => {
    const { data, error } = await anon.from("report_library").select("id,title,summary,body,attachment_path,unlocked").limit(1000);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(500);
    expect(data!.every((r) => r.summary === null && r.body === null && r.attachment_path === null && r.unlocked === false)).toBe(true);
  });
  it("gets zero rows from the contacts directory", async () => {
    const { data } = await anon.from("contacts_directory").select("id,email").limit(10);
    expect(data ?? []).toHaveLength(0);
  });
  it("cannot count CRM rows via Prefer: count=exact", async () => {
    const r = await anon.from("crm_opportunities").select("*", { count: "exact", head: true });
    expect(r.error !== null || r.count === 0).toBe(true);
  });
  it("cannot insert a CRM opportunity", async () => {
    expect((await anon.from("crm_opportunities").insert({ org_id: v.halberd, title: "x", agency: "DCD" })).error).not.toBeNull();
  });
  it("cannot call my_access / billing_details / set_member_role", async () => {
    expect((await anon.rpc("my_access")).error).not.toBeNull();
    expect((await anon.rpc("billing_details")).error).not.toBeNull();
    expect((await anon.rpc("set_member_role", { p_member: v.halberdMember, p_role: "owner" })).error).not.toBeNull();
  });
  it("cannot download a report attachment or list the bucket", async () => {
    expect((await anon.storage.from("report-files").download(v.proDcdFile)).error).not.toBeNull();
    const list = await anon.storage.from("report-files").list("", { limit: 10 });
    expect(list.data ?? []).toHaveLength(0);
  });
  it("cannot reach private / ops / migration schemas through the API", async () => {
    expect((await anon.schema("ops").from("stripe_events").select("id").limit(1)).error).not.toBeNull();
    expect((await anon.schema("migration").from("id_map").select("uuid").limit(1)).error).not.toBeNull();
    expect((await anon.schema("private").rpc("current_features")).error).not.toBeNull();
  });
  it("a JWT signed with the wrong secret is rejected", async () => {
    const forged = withToken(forgeJwt({ sub: v.ownerUser }, "not-the-real-secret-not-the-real-secret"));
    const r = await forged.from("crm_opportunities").select("id").limit(1);
    expect(r.error).not.toBeNull();
  });
  it("an unsigned (alg: none) JWT is rejected", async () => {
    const r = await withToken(forgeJwt({ sub: v.ownerUser }, "", "none")).from("crm_opportunities").select("id").limit(1);
    expect(r.error).not.toBeNull();
  });
  it("password sign-in does not work for migrated users (they have no password)", async () => {
    const r = await anon.auth.signInWithPassword({ email: DEMO.emails.owner, password: "" + "Password123!" });
    expect(r.error).not.toBeNull();
  });
  it("public sign-up is disabled", async () => {
    const r = await anon.auth.signUp({ email: "attacker@evil.example", password: "Sup3r-secret-pass!" });
    expect(r.error).not.toBeNull();
  });
});

describe("another organization (Cobalt Ridge owner) attacking Halberd's CRM", () => {
  it("cannot read Halberd's opportunity by leaked id", async () => {
    expect(blocked(await other.from("crm_opportunities").select("*").eq("id", v.opp))).toBe(true);
  });
  it("cannot read Halberd's notes and tasks by opportunity id", async () => {
    expect(blocked(await other.from("crm_notes").select("*").eq("opportunity_id", v.opp))).toBe(true);
    expect(blocked(await other.from("crm_tasks").select("*").eq("opportunity_id", v.opp))).toBe(true);
  });
  it("enumerating everything returns only its own pipeline", async () => {
    const r = await other.from("crm_opportunities").select("id,org_id", { count: "exact" });
    expect(r.count).toBe(v.cobaltOpps);
    expect(r.data!.every((x) => x.org_id === v.cobalt)).toBe(true);
  });
  it("filtering on Halberd's org_id returns nothing", async () => {
    expect((await other.from("crm_opportunities").select("id").eq("org_id", v.halberd)).data).toHaveLength(0);
  });
  it("or= filter injection does not widen visibility", async () => {
    const r = await other.from("crm_opportunities").select("id,org_id").or(`org_id.eq.${v.halberd},id.not.is.null`);
    expect(r.data!.every((x) => x.org_id === v.cobalt)).toBe(true);
  });
  it("cannot update Halberd's opportunity (0 rows affected, data unchanged)", async () => {
    const r = await other.from("crm_opportunities").update({ stage: "lost" }).eq("id", v.opp).select();
    expect(r.data ?? []).toHaveLength(0);
    expect((await one("select stage from public.crm_opportunities where id = $1", [v.opp])).stage).toBe(v.oppStage);
  });
  it("cannot delete Halberd's opportunity", async () => {
    await other.from("crm_opportunities").delete().eq("id", v.opp);
    expect((await one("select count(*)::int n from public.crm_opportunities where id = $1", [v.opp])).n).toBe(1);
  });
  it("cannot insert an opportunity into Halberd's org", async () => {
    expect((await other.from("crm_opportunities").insert({ org_id: v.halberd, title: "planted", agency: "DCD" })).error).not.toBeNull();
  });
  it("cannot graft a note onto Halberd's deal (tenant FK)", async () => {
    const r = await other.from("crm_notes").insert({ opportunity_id: v.opp, body: "graft" });
    expect(r.error).not.toBeNull();
    expect((await one("select count(*)::int n from public.crm_notes where body = 'graft'")).n).toBe(0);
  });
  it("cannot move its own deal into Halberd's org", async () => {
    const r = await other.from("crm_opportunities").update({ org_id: v.halberd }).eq("id", v.cobaltOpp).select();
    expect(r.error !== null || (r.data ?? []).length === 0).toBe(true);
    expect((await one("select org_id from public.crm_opportunities where id = $1", [v.cobaltOpp])).org_id).toBe(v.cobalt);
  });
  it("forging org/role/researcher in user_metadata grants nothing", async () => {
    await other.auth.updateUser({ data: { org_id: v.halberd, role: "owner", is_researcher: true, staff_role: "researcher" } });
    await other.auth.refreshSession();
    expect((await other.from("crm_opportunities").select("id").eq("org_id", v.halberd)).data).toHaveLength(0);
    expect(((await other.rpc("my_access")).data as any).org_id).toBe(v.cobalt);
    expect(blocked(await other.from("reports").select("id").eq("id", v.draftId))).toBe(true);
  });
  it("Basic tier: every Pro report body stays masked", async () => {
    const { data } = await other.from("report_library").select("tier_required,body").eq("tier_required", "pro").limit(1000);
    expect(data!.length).toBeGreaterThan(100);
    expect(data!.every((r) => r.body === null)).toBe(true);
  });
  it("Basic tier: only bodies for its entitled agency (OSL) unlock", async () => {
    const { data } = await other.from("report_library").select("agency,tier_required,unlocked,body").eq("unlocked", true).limit(1000);
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((r) => r.agency === "OSL" && r.tier_required === "basic" && r.body)).toBe(true);
  });
  it("Basic tier: contact rows visible, emails and phones masked", async () => {
    const { data } = await other.from("contacts_directory").select("full_name,email,phone").limit(500);
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((c) => c.email === null && c.phone === null)).toBe(true);
  });
  it("cannot download a Pro DCD attachment", async () => {
    expect((await other.storage.from("report-files").download(v.proDcdFile)).error).not.toBeNull();
  });
  it("cannot upgrade its own tier or grant itself entitlements", async () => {
    const up = await other.from("subscriptions").update({ tier: "enterprise" }).eq("org_id", v.cobalt).select();
    expect(up.error !== null || (up.data ?? []).length === 0).toBe(true);
    expect((await other.from("entitlements").insert({ org_id: v.cobalt, feature: "agencies.all" })).error).not.toBeNull();
    expect((await other.from("subscription_agencies").insert({ subscription_id: bubbleUuid("x"), agency: "DCD" })).error).not.toBeNull();
    expect((await one("select tier from public.subscriptions where org_id = $1", [v.cobalt])).tier).toBe("basic");
  });
  it("cannot change roles in Halberd", async () => {
    expect((await other.rpc("set_member_role", { p_member: v.halberdMember, p_role: "owner" })).error).not.toBeNull();
  });
  it("billing_details only ever returns its own org", async () => {
    const { data } = await other.rpc("billing_details");
    expect((data as any[]).map((r) => r.org_id)).toEqual([v.cobalt]);
  });
  it("cannot select stripe_customer_id directly", async () => {
    expect((await other.from("organizations").select("stripe_customer_id")).error).not.toBeNull();
  });
  it("sees only its own org's members", async () => {
    const { data } = await other.from("members").select("org_id").limit(1000);
    expect(data!.every((m) => m.org_id === v.cobalt)).toBe(true);
  });
});

describe("Halberd member (privilege escalation inside the tenant)", () => {
  it("cannot promote itself by updating members.role", async () => {
    const r = await member.from("members").update({ role: "owner" }).eq("id", v.samMember).select();
    expect(r.error).not.toBeNull();
    expect((await one("select role from public.members where id = $1", [v.samMember])).role).toBe("member");
  });
  it("cannot use set_member_role (owner only)", async () => {
    expect((await member.rpc("set_member_role", { p_member: v.samMember, p_role: "admin" })).error).not.toBeNull();
  });
  it("cannot read billing details", async () => {
    expect((await member.rpc("billing_details")).error).not.toBeNull();
  });
  it("cannot delete deals (owner/admin only)", async () => {
    await member.from("crm_opportunities").delete().eq("id", v.opp);
    expect((await one("select count(*)::int n from public.crm_opportunities where id = $1", [v.opp])).n).toBe(1);
  });
  it("can still read its own org's full pipeline", async () => {
    const r = await member.from("crm_opportunities").select("id", { count: "exact", head: true });
    expect(r.count).toBe(v.halberdOpps);
  });
});

describe("internal researcher", () => {
  for (const t of ["crm_opportunities", "crm_notes", "crm_tasks"]) {
    it(`sees zero ${t} across all orgs`, async () => {
      const r = await researcher.from(t).select("id", { count: "exact", head: true });
      expect(r.error !== null || r.count === 0).toBe(true);
    });
  }
  it("can read drafts and download any attachment", async () => {
    expect((await researcher.from("reports").select("id").eq("id", v.draftId)).data).toHaveLength(1);
    expect((await researcher.storage.from("report-files").download(v.proDcdFile)).error).toBeNull();
  });
});

describe("lapsed subscriber (payment failed, grace expired)", () => {
  it("loses report bodies, contract search and contacts", async () => {
    const lib = await lapsed.from("report_library").select("body").not("body", "is", null).limit(5);
    expect(lib.data).toHaveLength(0);
    expect((await lapsed.from("awarded_contracts").select("id").limit(5)).data).toHaveLength(0);
    expect((await lapsed.from("contacts_directory").select("id").limit(5)).data).toHaveLength(0);
  });
  it("keeps access to its own capture pipeline", async () => {
    expect((await lapsed.from("crm_opportunities").select("id").limit(5)).data!.length).toBeGreaterThan(0);
  });
});

describe("positive control: Halberd owner (Pro, DCD + FCSA)", () => {
  it("reads its pipeline, entitled bodies, contact emails and attachments", async () => {
    expect((await owner.from("crm_opportunities").select("id", { count: "exact", head: true })).count).toBe(v.halberdOpps);
    const unlocked = await owner.from("report_library").select("agency,body").eq("unlocked", true).limit(1000);
    expect(unlocked.data!.length).toBeGreaterThan(10);
    expect(unlocked.data!.every((r) => ["DCD", "FCSA"].includes(r.agency) && r.body)).toBe(true);
    expect((await owner.from("contacts_directory").select("email").limit(5)).data!.every((c) => c.email)).toBe(true);
    expect((await owner.storage.from("report-files").download(v.proDcdFile)).error).toBeNull();
  });
});
