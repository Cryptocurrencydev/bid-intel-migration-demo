// Bubble records → Postgres rows. Pure functions (no I/O) so they are unit-tested directly.
import { createHash } from "node:crypto";
import { OPTION_SETS, type BubbleData, type BubbleRecord, type StripeCustomer } from "./mock-bubble/generate";

// Fixed namespace: bubble id → uuid v5 is deterministic, so re-runs land on the same rows.
const NAMESPACE = "6f3c2a7e-9b1d-4c52-8e0a-b1d1ce5a7a11";

export function bubbleUuid(bubbleId: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(bubbleId).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const BUBBLE_ID_RE = /^\d{13}x\d{18}$/;

type OptionSet = keyof typeof OPTION_SETS;
export function opt<S extends OptionSet>(set: S, display: unknown): string {
  const map = OPTION_SETS[set] as Record<string, string>;
  const v = map[String(display)];
  if (!v) throw new Error(`option set ${set}: unknown display value ${JSON.stringify(display)}`);
  return v;
}

// Bubble rich text is BBCode.
export function bbcodeToMarkdown(s: string): string {
  return s
    .replace(/\[b\](.*?)\[\/b\]/gs, "**$1**")
    .replace(/\[i\](.*?)\[\/i\]/gs, "_$1_")
    .replace(/\[u\](.*?)\[\/u\]/gs, "$1")
    .replace(/\[url=(.*?)\](.*?)\[\/url\]/gs, "[$2]($1)")
    .replace(/\[ul\]/g, "\n")
    .replace(/\[\/ul\]/g, "")
    .replace(/\[li\](.*?)\[\/li\]/gs, "- $1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "//s3.amazonaws.com/appforest_uf/f169.../brief.pdf" → path on the CDN + file name
export function parseBubbleFileUrl(url: string): { cdnPath: string; fileName: string } {
  const m = url.match(/^(?:https?:)?\/\/s3\.amazonaws\.com(\/appforest_uf\/f[^/]+\/(.+))$/);
  if (!m) throw new Error(`not a Bubble file url: ${url}`);
  return { cdnPath: m[1], fileName: m[2] };
}

const isoDate = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const ts = (v: unknown) => (v ? String(v) : null);

export type Issue = { severity: "info" | "warning"; kind: string; bubble_type: string; bubble_id: string; detail: string };
export type FileJob = { bubble_url: string; cdn_path: string; bucket: string; path: string };
export type Rows = Record<string, Record<string, unknown>[]>;

export function transformAll(data: BubbleData, stripeCustomers: StripeCustomer[]) {
  const issues: Issue[] = [];
  const idmap: { bubble_id: string; bubble_type: string; target_table: string; uuid: string }[] = [];
  const files: FileJob[] = [];
  const rows: Rows = {
    organizations: [], auth_users: [], members: [], researchers: [], subscriptions: [], subscription_agencies: [],
    reports: [], report_tags: [], awarded_contracts: [], contacts: [], crm_opportunities: [],
    crm_opportunity_reports: [], crm_notes: [], crm_tasks: [],
  };
  const map = (rec: BubbleRecord, type: string, table: string) => {
    if (!BUBBLE_ID_RE.test(rec._id)) throw new Error(`${type}: malformed bubble id ${rec._id}`);
    const id = bubbleUuid(rec._id);
    idmap.push({ bubble_id: rec._id, bubble_type: type, target_table: table, uuid: id });
    return id;
  };

  // organizations (+ stripe customer backfill from the Stripe export)
  const stripeByOrg = new Map(stripeCustomers.filter((c) => c.metadata.bubble_org_id).map((c) => [c.metadata.bubble_org_id!, c.id]));
  const orgIds = new Set<string>();
  for (const o of data.organization) {
    const id = map(o, "organization", "organizations");
    orgIds.add(o._id);
    let stripe = (o.stripe_customer_id as string | undefined) ?? null;
    if (!stripe && stripeByOrg.has(o._id)) {
      stripe = stripeByOrg.get(o._id)!;
      issues.push({ severity: "info", kind: "stripe_customer_backfilled", bubble_type: "organization", bubble_id: o._id, detail: `stripe_customer_id missing in Bubble; matched ${stripe} via Stripe metadata.bubble_org_id` });
    }
    let logo: string | null = null;
    if (o.logo) {
      const { cdnPath, fileName } = parseBubbleFileUrl(String(o.logo));
      logo = `${id}/${fileName}`;
      files.push({ bubble_url: String(o.logo), cdn_path: cdnPath, bucket: "org-logos", path: logo });
    }
    rows.organizations.push({ id, bubble_id: o._id, name: o.name, slug: o.slug, stripe_customer_id: stripe, logo_path: logo, created_at: o["Created Date"] });
  }

  // users → auth.users (passwordless) + members / researchers
  const userOrg = new Map<string, string>(); // bubble user id → bubble org id
  const seenEmail = new Map<string, string>();
  const users = [...data.user].sort((a, b) => a["Created Date"].localeCompare(b["Created Date"]));
  for (const u of users) {
    const isResearcher = u.staff_role !== undefined && opt("StaffRole", u.staff_role) === "researcher";
    const table = isResearcher ? "researchers" : "members";
    const id = map(u, "user", table);
    const auth = u.authentication as { email?: { email: string; email_confirmed: boolean } } | undefined;
    const rawEmail = auth?.email?.email ?? null;
    const email = rawEmail ? rawEmail.trim().toLowerCase() : null;
    let userId: string | null = null;
    if (!email) {
      issues.push({ severity: "warning", kind: "user_without_email", bubble_type: "user", bubble_id: u._id, detail: `${u.first_name} ${u.last_name}: migrated as a member without a login; needs manual outreach` });
    } else if (seenEmail.has(email)) {
      issues.push({ severity: "warning", kind: "duplicate_email", bubble_type: "user", bubble_id: u._id, detail: `email ${email} already belongs to ${seenEmail.get(email)}; kept as member without login pending merge` });
    } else {
      seenEmail.set(email, u._id);
      userId = id;
      rows.auth_users.push({
        id, email, created_at: u["Created Date"],
        email_confirmed_at: auth?.email?.email_confirmed ? u["Created Date"] : null,
        raw_user_meta_data: { full_name: `${u.first_name} ${u.last_name}`, bubble_id: u._id, migrated_from: "bubble" },
      });
    }
    const fullName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
    if (isResearcher) {
      rows.researchers.push({ id, bubble_id: u._id, user_id: userId, email, full_name: fullName, created_at: u["Created Date"] });
    } else {
      const org = u.organization as string | undefined;
      if (!org || !orgIds.has(org)) throw new Error(`user ${u._id} has no organization`);
      userOrg.set(u._id, org);
      rows.members.push({ id, bubble_id: u._id, org_id: bubbleUuid(org), user_id: userId, email, full_name: fullName, role: opt("OrgRole", u.role), created_at: u["Created Date"] });
    }
  }
  const sameOrgMember = (userBubbleId: unknown, orgBubbleId: string, type: string, recId: string, field: string): string | null => {
    if (!userBubbleId) return null;
    const uOrg = userOrg.get(String(userBubbleId));
    if (!uOrg) {
      issues.push({ severity: "warning", kind: "dangling_reference", bubble_type: type, bubble_id: recId, detail: `${field} → ${userBubbleId} does not exist in Bubble; set to null` });
      return null;
    }
    if (uOrg !== orgBubbleId) {
      issues.push({ severity: "warning", kind: "cross_tenant_reference", bubble_type: type, bubble_id: recId, detail: `${field} → user from another organization; set to null (Bubble did not enforce this)` });
      return null;
    }
    return bubbleUuid(String(userBubbleId));
  };

  for (const s of data.subscription) {
    const id = map(s, "subscription", "subscriptions");
    rows.subscriptions.push({
      id, bubble_id: s._id, org_id: bubbleUuid(String(s.organization)), tier: opt("Tier", s.tier), status: opt("SubscriptionStatus", s.status),
      stripe_subscription_id: s.stripe_subscription_id ?? null, current_period_end: ts(s.current_period_end), grace_until: ts(s.grace_until), created_at: s["Created Date"],
    });
    for (const a of (s.agencies as string[]) ?? []) rows.subscription_agencies.push({ subscription_id: id, agency: opt("Agency", a) });
  }

  const researcherIds = new Set(rows.researchers.map((r) => r.bubble_id as string));
  const reportIds = new Set<string>();
  for (const r of data.report) {
    const id = map(r, "report", "reports");
    reportIds.add(r._id);
    let attachment: string | null = null;
    if (r.attachment) {
      const { cdnPath, fileName } = parseBubbleFileUrl(String(r.attachment));
      attachment = `${id}/${fileName}`;
      files.push({ bubble_url: String(r.attachment), cdn_path: cdnPath, bucket: "report-files", path: attachment });
    }
    rows.reports.push({
      id, bubble_id: r._id, title: r.title, agency: opt("Agency", r.agency), category: opt("ReportCategory", r.category),
      summary: r.summary ?? null, body: r.body ? bbcodeToMarkdown(String(r.body)) : null, attachment_path: attachment,
      tier_required: opt("Tier", r.tier_required), status: r.published ? "published" : "draft",
      author_id: r.author && researcherIds.has(String(r.author)) ? bubbleUuid(String(r.author)) : null,
      published_at: ts(r.published_date), created_at: r["Created Date"],
    });
    for (const t of [...new Set((r.tags as string[]) ?? [])]) rows.report_tags.push({ report_id: id, tag: t });
  }

  for (const c of data.awarded_contract) {
    const id = map(c, "awarded_contract", "awarded_contracts");
    rows.awarded_contracts.push({
      id, bubble_id: c._id, piid: c.piid, agency: opt("Agency", c.agency), vendor_name: c.vendor, naics: c.naics ?? null,
      amount: Number(c.amount).toFixed(2), award_date: isoDate(c.award_date), set_aside: opt("SetAside", c.set_aside), description: c.description ?? null, created_at: c["Created Date"],
    });
  }

  for (const c of data.contact) {
    const id = map(c, "contact", "contacts");
    rows.contacts.push({
      id, bubble_id: c._id, agency: opt("Agency", c.agency), full_name: c.name, title: c.title ?? null, office: c.office ?? null,
      email: c.email ? String(c.email).toLowerCase() : null, phone: c.phone ?? null, notes: c.notes ?? null, created_at: c["Created Date"],
    });
  }

  const oppOrg = new Map<string, string>();
  for (const o of data.opportunity) {
    const id = map(o, "opportunity", "crm_opportunities");
    const org = String(o.organization);
    oppOrg.set(o._id, org);
    rows.crm_opportunities.push({
      id, bubble_id: o._id, org_id: bubbleUuid(org), title: o.title, agency: opt("Agency", o.agency), stage: opt("OpportunityStage", o.stage),
      value: o.value ?? null, due_date: isoDate(o.due_date), owner_member_id: sameOrgMember(o.owner, org, "opportunity", o._id, "owner"),
      solicitation_number: o.solicitation_number ?? null, created_at: o["Created Date"],
    });
    for (const rep of [...new Set((o.linked_reports as string[]) ?? [])]) {
      if (!reportIds.has(rep)) {
        issues.push({ severity: "warning", kind: "dangling_reference", bubble_type: "opportunity", bubble_id: o._id, detail: `linked_reports → ${rep} missing` });
        continue;
      }
      rows.crm_opportunity_reports.push({ opportunity_id: id, org_id: bubbleUuid(org), report_id: bubbleUuid(rep) });
    }
  }

  for (const n of data.note) {
    const id = map(n, "note", "crm_notes");
    const org = oppOrg.get(String(n.opportunity));
    if (!org) throw new Error(`note ${n._id} references missing opportunity`);
    rows.crm_notes.push({
      id, bubble_id: n._id, org_id: bubbleUuid(org), opportunity_id: bubbleUuid(String(n.opportunity)),
      author_member_id: sameOrgMember(n.author, org, "note", n._id, "author"), body: n.body, created_at: n["Created Date"],
    });
  }

  for (const t of data.task) {
    const id = map(t, "task", "crm_tasks");
    const org = oppOrg.get(String(t.opportunity));
    if (!org) throw new Error(`task ${t._id} references missing opportunity`);
    rows.crm_tasks.push({
      id, bubble_id: t._id, org_id: bubbleUuid(org), opportunity_id: bubbleUuid(String(t.opportunity)),
      assignee_member_id: sameOrgMember(t.assignee, org, "task", t._id, "assignee"), title: t.title, due_date: isoDate(t.due_date),
      done: Boolean(t.done), created_at: t["Created Date"],
    });
  }

  return { rows, idmap, files, issues };
}
