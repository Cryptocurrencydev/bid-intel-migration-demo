// Deterministic synthetic Bubble export (~20.6k records). Same seed → same data, locally and in CI.
// Field names, option-set display values, list fields and file URLs follow what Bubble's Data API returns.
import { createHash } from "node:crypto";

export type BubbleRecord = Record<string, unknown> & { _id: string; "Created Date": string; "Modified Date": string };
export type BubbleData = Record<string, BubbleRecord[]>;

export const COUNTS = {
  organization: 300,
  user: 1500,
  subscription: 270,
  report: 650,
  awarded_contract: 9000,
  contact: 2400,
  opportunity: 2600,
  note: 2100,
  task: 1800,
} as const;

// Display values exactly as configured in the Bubble option sets.
export const OPTION_SETS = {
  OrgRole: { Owner: "owner", Admin: "admin", Member: "member" },
  Tier: { Basic: "basic", Pro: "pro", Enterprise: "enterprise" },
  SubscriptionStatus: { Trialing: "trialing", Active: "active", "Past due": "past_due", Canceled: "canceled", Incomplete: "incomplete" },
  Agency: {
    "Department of Coastal Defense": "DCD",
    "Federal Health Data Agency": "FHDA",
    "Office of Space Logistics": "OSL",
    "National Grid Resilience Office": "NGRO",
    "Bureau of Transit Security": "BTS",
    "Federal Cyber Shield Agency": "FCSA",
    "Maritime Sustainment Command": "MSC",
    "Federal Emergency Medical Reserve": "FEMR",
  },
  ReportCategory: { Forecast: "forecast", "RFP analysis": "rfp_analysis", Recompete: "recompete", "Budget brief": "budget_brief", "Agency profile": "agency_profile" },
  OpportunityStage: { Identified: "identified", Qualifying: "qualifying", Capture: "capture", Proposal: "proposal", Submitted: "submitted", Won: "won", Lost: "lost", "No bid": "no_bid" },
  SetAside: { "Full and open": "full_and_open", "Small business": "small_business", "8(a)": "8a", HUBZone: "hubzone", SDVOSB: "sdvosb", WOSB: "wosb" },
  StaffRole: { Researcher: "researcher" },
} as const;

// Named demo tenants used by the UI personas (first records generated).
export const DEMO = {
  orgA: { name: "Halberd Systems", slug: "halberd-systems", tier: "Pro", agencies: ["Department of Coastal Defense", "Federal Cyber Shield Agency"] },
  orgB: { name: "Cobalt Ridge Federal", slug: "cobalt-ridge-federal", tier: "Basic", agencies: ["Office of Space Logistics"] },
  orgLapsed: { name: "Meridian Fieldworks", slug: "meridian-fieldworks", tier: "Pro", agencies: ["Department of Coastal Defense"] },
  emails: {
    owner: "dana.owner@halberd.example",
    member: "sam.member@halberd.example",
    other: "riley.owner@cobaltridge.example",
    lapsed: "jo.member@meridian.example",
    researcher: "morgan.analyst@bidmarker.example",
  },
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(seed = 20261103): { data: BubbleData; stripeCustomers: StripeCustomer[]; anomalies: string[] } {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const sample = <T>(xs: readonly T[], n: number): T[] => {
    const c = [...xs];
    const out: T[] = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(r() * c.length), 1)[0]);
    return out;
  };
  let clock = Date.parse("2021-03-01T09:00:00Z");
  const bubbleId = () => {
    clock += int(5_000, 9_000_000);
    const tail = String(int(100_000_000, 999_999_999)) + String(int(100_000_000, 999_999_999));
    return { id: `${clock}x${tail}`, created: new Date(clock).toISOString() };
  };
  const base = () => {
    const { id, created } = bubbleId();
    const modified = new Date(Date.parse(created) + int(0, 400) * 86_400_000).toISOString();
    return { _id: id, "Created Date": created, "Modified Date": modified < "2026-10-30" ? modified : created };
  };
  const fileUrl = (name: string) => {
    const { id } = bubbleId();
    return `//s3.amazonaws.com/appforest_uf/f${id}/${name}`;
  };

  const agencies = Object.keys(OPTION_SETS.Agency);
  const firsts = ["Dana", "Sam", "Riley", "Jo", "Morgan", "Alex", "Casey", "Jamie", "Avery", "Quinn", "Taylor", "Jordan", "Reese", "Skyler", "Parker", "Rowan", "Emerson", "Hayden", "Logan", "Kai", "Noor", "Priya", "Mateo", "Lena", "Omar", "Ines", "Tariq", "Mei", "Ola", "Femi"];
  const lasts = ["Okafor", "Lindqvist", "Marsh", "Delgado", "Brennan", "Achebe", "Kowalski", "Nakamura", "Haddad", "Ferreira", "Osei", "Calloway", "Duarte", "Whitfield", "Abara", "Sorensen", "Varga", "Ibekwe", "Castell", "Moreau"];
  const orgWords1 = ["Halberd", "Cobalt", "Meridian", "Granite", "Bluewater", "Ironleaf", "Northgate", "Redstone", "Silverline", "Keystone", "Lattice", "Harbor", "Summit", "Beacon", "Anchor", "Vantage", "Sterling", "Cedar", "Falcon", "Orion"];
  const orgWords2 = ["Systems", "Federal", "Fieldworks", "Analytics", "Defense Group", "Solutions", "Logistics", "Engineering", "Technologies", "Partners", "Mission Services", "Labs"];
  const topics = ["radar sustainment", "zero trust architecture", "depot maintenance", "cloud migration", "satellite ground systems", "medical logistics", "cyber range operations", "grid hardening", "transit surveillance", "health data exchange", "port security", "training simulation", "supply chain risk", "C5ISR integration", "facilities support"];
  const anomalies: string[] = [];

  // organizations -----------------------------------------------------------------
  const orgs: BubbleRecord[] = [];
  const usedSlugs = new Set<string>();
  for (let i = 0; i < COUNTS.organization; i++) {
    let name: string, slug: string;
    if (i === 0) ({ name, slug } = DEMO.orgA);
    else if (i === 1) ({ name, slug } = DEMO.orgB);
    else if (i === 2) ({ name, slug } = DEMO.orgLapsed);
    else {
      do {
        name = `${pick(orgWords1)} ${pick(orgWords2)}${r() < 0.3 ? ` ${pick(["LLC", "Inc.", "Corp."])}` : ""}`;
        slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
        if (usedSlugs.has(slug)) slug = `${slug}-${i}`;
      } while (usedSlugs.has(slug));
    }
    usedSlugs.add(slug);
    orgs.push({ ...base(), name, slug, logo: r() < 0.6 || i < 3 ? fileUrl("logo.png") : undefined, members: [] as string[] });
  }

  // users ------------------------------------------------------------------------------
  const users: BubbleRecord[] = [];
  const RESEARCHERS = 12;
  const demoEmails = [DEMO.emails.owner, DEMO.emails.member, DEMO.emails.other, DEMO.emails.lapsed];
  for (let i = 0; i < COUNTS.user; i++) {
    const first = pick(firsts);
    const last = pick(lasts);
    let email: string | undefined;
    let org: BubbleRecord | undefined;
    let role: string | undefined = "Member";
    let staff: string | undefined;
    if (i < RESEARCHERS) {
      staff = "Researcher";
      role = undefined;
      email = i === 0 ? DEMO.emails.researcher : `${first}.${last}.${i}@bidmarker.example`.toLowerCase();
    } else {
      const j = i - RESEARCHERS;
      if (j < 4) {
        org = orgs[[0, 0, 1, 2][j]];
        role = ["Owner", "Member", "Owner", "Member"][j];
        email = demoEmails[j];
      } else {
        org = orgs[j % orgs.length];
        // first user generated per org becomes its owner
        role = (org.members as string[]).length === 0 ? "Owner" : r() < 0.15 ? "Admin" : "Member";
        email = `${first}.${last}.${i}@${String(org.slug).replace(/-/g, "")}.example`.toLowerCase();
      }
    }
    const u: BubbleRecord = {
      ...base(),
      first_name: first,
      last_name: last,
      organization: org?._id,
      role,
      staff_role: staff,
      user_signed_up: true,
      authentication: email ? { email: { email, email_confirmed: i < RESEARCHERS + 4 ? true : r() < 0.93 } } : undefined,
    };
    if (org) (org.members as string[]).push(u._id);
    users.push(u);
  }
  // Anomalies the validation report must surface:
  for (const idx of [301, 517, 733, 902, 1188, 1401]) {
    delete users[idx].authentication; // created by an old CSV import, never had an email
    anomalies.push(`user ${users[idx]._id} has no email`);
  }
  const dupSrc = users[640].authentication as { email: { email: string } };
  const dupTarget = users[1222];
  dupTarget.authentication = { email: { email: dupSrc.email.email.toUpperCase(), email_confirmed: false } };
  anomalies.push(`user ${dupTarget._id} duplicates ${users[640]._id}'s email with different case`);

  const membersByOrg = new Map<string, string[]>();
  for (const o of orgs) membersByOrg.set(o._id, o.members as string[]);

  // subscriptions (30 orgs are on the free plan → no subscription) -------------------------
  const subs: BubbleRecord[] = [];
  const stripeCustomers: StripeCustomer[] = [];
  for (let i = 0; i < COUNTS.subscription; i++) {
    const org = orgs[i];
    const demo = i === 0 ? DEMO.orgA : i === 1 ? DEMO.orgB : i === 2 ? DEMO.orgLapsed : undefined;
    const tier = demo?.tier ?? pick(["Basic", "Basic", "Pro", "Pro", "Pro", "Enterprise"]);
    let status = i === 2 ? "Past due" : r() < 0.9 ? "Active" : pick(["Past due", "Trialing", "Canceled"]);
    if (i < 2) status = "Active";
    const custId = `cus_${createHash("sha1").update(org._id).digest("hex").slice(0, 14)}`;
    const periodEnd = new Date(Date.parse("2026-11-01T00:00:00Z") + int(1, 28) * 86_400_000).toISOString();
    subs.push({
      ...base(),
      organization: org._id,
      tier,
      status,
      stripe_subscription_id: `sub_${createHash("sha1").update(`s${org._id}`).digest("hex").slice(0, 14)}`,
      current_period_end: periodEnd,
      grace_until: status === "Past due" ? (i === 2 ? "2026-10-20T00:00:00.000Z" : new Date(Date.parse("2026-11-08T00:00:00Z") + int(0, 4) * 86_400_000).toISOString()) : undefined,
      agencies: demo?.agencies ?? (tier === "Enterprise" ? [] : sample(agencies, int(1, 3))),
    });
    org.stripe_customer_id = custId;
    stripeCustomers.push({ id: custId, email: `billing@${org.slug}.example`, metadata: { bubble_org_id: org._id } });
  }
  // Bubble lost the customer id for 3 orgs (a known bug in an old checkout workflow); Stripe still has them.
  for (const i of [57, 140, 233]) {
    delete orgs[i].stripe_customer_id;
    anomalies.push(`org ${orgs[i]._id} lost its stripe_customer_id in Bubble`);
  }
  // Two Stripe customers belong to orgs deleted from Bubble long ago.
  stripeCustomers.push({ id: "cus_orphan00000001", email: "billing@defunct-one.example", metadata: { bubble_org_id: "1601000000000x100000000000000001" } });
  stripeCustomers.push({ id: "cus_orphan00000002", email: "billing@defunct-two.example", metadata: {} });

  // reports ---------------------------------------------------------------------------------
  const researcherIds = users.slice(0, RESEARCHERS).map((u) => u._id);
  const reports: BubbleRecord[] = [];
  const cats = Object.keys(OPTION_SETS.ReportCategory);
  for (let i = 0; i < COUNTS.report; i++) {
    const agency = i < 6 ? (["Department of Coastal Defense", "Federal Cyber Shield Agency", "Office of Space Logistics"] as const)[i % 3] : pick(agencies);
    const topic = pick(topics);
    const cat = pick(cats);
    const tier = i % 5 === 0 ? "Basic" : i % 11 === 0 ? "Enterprise" : "Pro";
    const published = i % 13 !== 0;
    const fy = 2026 + int(0, 2);
    const title = `${agency.split(" ").slice(-2).join(" ")}: ${topic} ${cat.toLowerCase()} FY${fy}`;
    reports.push({
      ...base(),
      title: title.charAt(0).toUpperCase() + title.slice(1),
      agency,
      category: cat,
      tier_required: tier,
      summary: `What we expect from the ${agency} on ${topic} in FY${fy}, who holds the incumbent work, and when the solicitation is likely to drop.`,
      body:
        `[b]Bottom line:[/b] the ${agency} is preparing a ${topic} requirement valued at roughly $${int(2, 90)}M over ${int(3, 7)} years.\n\n` +
        `[b]Incumbent:[/b] ${pick(orgWords1)} ${pick(orgWords2)} (synthetic). Period of performance ends Q${int(1, 4)} FY${fy}.\n\n` +
        `[b]Signals:[/b][ul][li]Sources sought notice expected within ${int(2, 10)} weeks[/li][li]Industry day likely; prior event drew ${int(20, 140)} firms[/li][li]Set-aside: ${pick(Object.keys(OPTION_SETS.SetAside))} probable[/li][/ul]\n\n` +
        `[i]Synthetic research note for a demo. Not real procurement data.[/i]`,
      attachment: i % 3 === 0 ? fileUrl(`brief-${i}.pdf`) : undefined,
      published,
      published_date: published ? new Date(Date.parse("2025-06-01T00:00:00Z") + int(0, 520) * 86_400_000).toISOString() : undefined,
      author: pick(researcherIds),
      tags: sample(topics.flatMap((t) => t.split(" ")), int(1, 4)),
    });
  }

  // awarded contracts -----------------------------------------------------------------------
  const contracts: BubbleRecord[] = [];
  const setAsides = Object.keys(OPTION_SETS.SetAside);
  for (let i = 0; i < COUNTS.awarded_contract; i++) {
    const agency = pick(agencies);
    const code = OPTION_SETS.Agency[agency as keyof typeof OPTION_SETS.Agency];
    contracts.push({
      ...base(),
      piid: `${code}-${String(24 + (i % 3)).padStart(2, "0")}-${String(100000 + i).slice(1)}`,
      agency,
      vendor: `${pick(orgWords1)} ${pick(orgWords2)}`,
      naics: pick(["541330", "541512", "541519", "541611", "541715", "336411", "561210", "488190"]),
      amount: Math.round((r() ** 3 * 48_000_000 + 25_000) * 100) / 100,
      award_date: new Date(Date.parse("2019-01-01T00:00:00Z") + int(0, 2830) * 86_400_000).toISOString(),
      set_aside: pick(setAsides),
      description: `${pick(topics).replace(/^./, (c) => c.toUpperCase())} for the ${agency} (synthetic award)`,
    });
  }

  // contacts ----------------------------------------------------------------------------------
  const contacts: BubbleRecord[] = [];
  const titles = ["Contracting Officer", "Contract Specialist", "Program Manager", "Small Business Liaison", "Deputy Program Executive", "Requirements Lead"];
  for (let i = 0; i < COUNTS.contact; i++) {
    const agency = pick(agencies);
    const first = pick(firsts);
    const last = pick(lasts);
    const code = OPTION_SETS.Agency[agency as keyof typeof OPTION_SETS.Agency].toLowerCase();
    contacts.push({
      ...base(),
      name: `${first} ${last}`,
      title: pick(titles),
      agency,
      office: `${pick(["Northern", "Atlantic", "Pacific", "Central", "Joint"])} ${pick(["Acquisition", "Programs", "Sustainment", "Systems"])} Office`,
      email: `${first}.${last}.${i}@${code}.example`.toLowerCase(),
      phone: `+1-555-${String(int(100, 999))}-${String(int(1000, 9999))}`,
      notes: r() < 0.3 ? "Prefers questions through the procurement portal (synthetic)." : undefined,
    });
  }

  // CRM -------------------------------------------------------------------------------------
  const opps: BubbleRecord[] = [];
  const stages = Object.keys(OPTION_SETS.OpportunityStage);
  const publishedReports = reports.filter((x) => x.published);
  for (let i = 0; i < COUNTS.opportunity; i++) {
    const org = i < 14 ? orgs[0] : i < 20 ? orgs[1] : i < 24 ? orgs[2] : orgs[int(0, orgs.length - 1)];
    const members = membersByOrg.get(org._id)!;
    const agency = pick(agencies);
    opps.push({
      ...base(),
      organization: org._id,
      title: `${pick(topics).replace(/^./, (c) => c.toUpperCase())} — ${agency.split(" ").slice(-1)[0]} ${pick(["recompete", "new start", "IDIQ task order", "BPA call", "OTA prototype"])}`,
      agency,
      stage: pick(stages),
      value: Math.round(r() ** 2 * 60_000_000 + 150_000),
      due_date: new Date(Date.parse("2026-11-05T00:00:00Z") + int(-60, 240) * 86_400_000).toISOString(),
      owner: members.length ? pick(members) : undefined,
      solicitation_number: r() < 0.6 ? `${OPTION_SETS.Agency[agency as keyof typeof OPTION_SETS.Agency]}-RFP-${int(26, 27)}-${int(1000, 9999)}` : undefined,
      linked_reports: sample(publishedReports, int(0, 3)).map((x) => x._id),
    });
  }
  opps[901].owner = "1622000000000x999999999999999999"; // user deleted in Bubble; reference dangles
  anomalies.push(`opportunity ${opps[901]._id} owner points to a deleted user`);

  const notes: BubbleRecord[] = [];
  const noteBodies = ["Teaming call with prime went well; they want our past performance on", "CO confirmed draft RFP slips a month. Re-plan color reviews around", "Competitor intel: incumbent is weak on", "Pricing desk needs updated labor categories for", "Customer visit notes: pain points around"];
  for (let i = 0; i < COUNTS.note; i++) {
    const opp = i < 30 ? opps[i % 14] : opps[int(0, opps.length - 1)];
    const members = membersByOrg.get(opp.organization as string)!;
    notes.push({ ...base(), opportunity: opp._id, author: members.length ? pick(members) : undefined, body: `${pick(noteBodies)} ${pick(topics)}.` });
  }
  // Bubble never enforced that a note's author belongs to the deal's org.
  for (const i of [444, 1555]) {
    const foreignOrg = orgs[(orgs.findIndex((o) => o._id === opps.find((op) => op._id === notes[i].opportunity)!.organization) + 7) % orgs.length];
    notes[i].author = (foreignOrg.members as string[])[0];
    anomalies.push(`note ${notes[i]._id} author belongs to another organization`);
  }

  const tasks: BubbleRecord[] = [];
  const taskTitles = ["Draft compliance matrix", "Schedule pink team", "Request past performance refs", "Submit questions to CO", "Update win themes", "Finalize teaming agreement", "Price volume review"];
  for (let i = 0; i < COUNTS.task; i++) {
    const opp = i < 30 ? opps[i % 14] : opps[int(0, opps.length - 1)];
    const members = membersByOrg.get(opp.organization as string)!;
    tasks.push({
      ...base(),
      opportunity: opp._id,
      assignee: members.length ? pick(members) : undefined,
      title: pick(taskTitles),
      due_date: new Date(Date.parse("2026-11-05T00:00:00Z") + int(-20, 90) * 86_400_000).toISOString(),
      done: r() < 0.35,
    });
  }

  return {
    data: { organization: orgs, user: users, subscription: subs, report: reports, awarded_contract: contracts, contact: contacts, opportunity: opps, note: notes, task: tasks },
    stripeCustomers,
    anomalies,
  };
}

export type StripeCustomer = { id: string; email: string; metadata: { bubble_org_id?: string } };

// Deterministic file bytes for a CDN path.
export function fileBytes(path: string): { bytes: Buffer; contentType: string } {
  const digest = createHash("sha256").update(path).digest("hex");
  if (path.endsWith(".png")) {
    // 1x1 PNG with a colour derived from the path
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63" + digest.slice(0, 8) + "0000000049454e44ae426082",
      "hex",
    );
    return { bytes: png, contentType: "image/png" };
  }
  const text = `%PDF-1.4\n% Bidmarker synthetic research brief\n% source ${path}\n% digest ${digest}\n` + "Synthetic content. ".repeat(40) + "\n%%EOF\n";
  return { bytes: Buffer.from(text), contentType: "application/pdf" };
}
