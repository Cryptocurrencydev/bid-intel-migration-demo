import { describe, expect, it } from "vitest";
import { bubbleUuid, bbcodeToMarkdown, opt, parseBubbleFileUrl, transformAll, BUBBLE_ID_RE } from "../../migration/transform";
import { generate, COUNTS } from "../../migration/mock-bubble/generate";

describe("bubble id → uuid", () => {
  it("is deterministic uuid v5", () => {
    const a = bubbleUuid("1698765432123x987654321987654321");
    expect(a).toBe(bubbleUuid("1698765432123x987654321987654321"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(bubbleUuid("1698765432123x987654321987654322"));
  });
  it("generator emits Bubble-shaped ids", () => {
    const { data } = generate();
    for (const list of Object.values(data)) for (const r of list.slice(0, 50)) expect(r._id).toMatch(BUBBLE_ID_RE);
  });
});

describe("option sets → enums", () => {
  it("maps display values", () => {
    expect(opt("Tier", "Pro")).toBe("pro");
    expect(opt("SetAside", "8(a)")).toBe("8a");
    expect(opt("SubscriptionStatus", "Past due")).toBe("past_due");
  });
  it("fails loudly on unknown values instead of guessing", () => {
    expect(() => opt("Tier", "Platinum")).toThrow(/unknown display value/);
  });
});

describe("rich text and files", () => {
  it("converts Bubble BBCode to markdown", () => {
    expect(bbcodeToMarkdown("[b]Bold[/b] and [i]it[/i][ul][li]one[/li][li]two[/li][/ul]")).toBe("**Bold** and _it_\n- one\n- two");
  });
  it("parses appforest_uf file urls", () => {
    expect(parseBubbleFileUrl("//s3.amazonaws.com/appforest_uf/f1698765432123x111111111111111111/brief.pdf")).toEqual({
      cdnPath: "/appforest_uf/f1698765432123x111111111111111111/brief.pdf", fileName: "brief.pdf",
    });
    expect(() => parseBubbleFileUrl("https://evil.example/x.pdf")).toThrow();
  });
});

describe("transformAll", () => {
  const { data, stripeCustomers } = generate();
  const out = transformAll(data, stripeCustomers);
  it("maps every record exactly once", () => {
    const total = Object.values(COUNTS).reduce((a, b) => a + b, 0);
    expect(out.idmap).toHaveLength(total);
    expect(new Set(out.idmap.map((m) => m.uuid)).size).toBe(total);
  });
  it("turns list fields into join rows", () => {
    expect(out.rows.subscription_agencies.length).toBeGreaterThan(0);
    expect(out.rows.report_tags.length).toBeGreaterThan(0);
    expect(out.rows.crm_opportunity_reports.length).toBeGreaterThan(0);
  });
  it("never emits a cross-tenant author/owner/assignee", () => {
    const memberOrg = new Map(out.rows.members.map((m) => [m.id, m.org_id]));
    for (const t of ["crm_notes", "crm_tasks", "crm_opportunities"] as const)
      for (const r of out.rows[t]) {
        const ref = (r.author_member_id ?? r.assignee_member_id ?? r.owner_member_id) as string | null;
        if (ref) expect(memberOrg.get(ref)).toBe(r.org_id);
      }
    expect(out.issues.filter((i) => i.kind === "cross_tenant_reference")).toHaveLength(2);
  });
  it("creates passwordless logins only for unique emails", () => {
    const emails = out.rows.auth_users.map((u) => u.email);
    expect(new Set(emails).size).toBe(emails.length);
    expect(out.issues.filter((i) => i.kind === "user_without_email")).toHaveLength(6);
    expect(out.issues.filter((i) => i.kind === "duplicate_email")).toHaveLength(1);
  });
  it("backfills lost Stripe customer ids from Stripe metadata", () => {
    expect(out.issues.filter((i) => i.kind === "stripe_customer_backfilled")).toHaveLength(3);
  });
});
