import type { PersonaData } from "@/lib/snapshot";

export const usd = (n: number | string | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
export const date = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Tiny markdown subset for report bodies (bold, italic, bullets). Input is escaped first.
export function Markdown({ text }: { text: string }) {
  const html = esc(text)
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      const inline = (l: string) => l.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/_(.+?)_/g, "<em>$1</em>");
      const head = lines.filter((l) => !l.startsWith("- "));
      const items = lines.filter((l) => l.startsWith("- "));
      return (head.length ? `<p>${head.map(inline).join("<br/>")}</p>` : "") + (items.length ? `<ul>${items.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>` : "");
    })
    .join("");
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Can({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li>
      <span className={ok ? "y" : "n"} aria-label={ok ? "can" : "cannot"}>{ok ? "✓" : "✕"}</span>
      <span>{children}</span>
    </li>
  );
}

export function capabilities(d: PersonaData) {
  const p = d.probes as Record<string, { blocked: boolean; rows: number }>;
  const withEmail = d.contacts.rows.filter((c: any) => c.email).length;
  return [
    { label: "See the report catalog (titles, agencies)", ok: d.reports.visible > 0 },
    { label: "Read report summaries", ok: d.reports.rows.some((r: any) => r.summary) },
    { label: `Read gated report bodies (${d.reports.unlocked} of ${d.reports.visible})`, ok: d.reports.unlocked > 0 },
    { label: `Search awarded contracts (${d.contracts.visible.toLocaleString("en-US")})`, ok: d.contracts.visible > 0 },
    { label: "See government contacts", ok: d.contacts.visible > 0 },
    { label: "See contact emails and phones", ok: withEmail > 0 },
    { label: `Use its own capture pipeline (${d.crm.opportunities.length} deals)`, ok: d.crm.opportunities.length > 0 },
    { label: "Read Halberd Systems' pipeline", ok: p["crm_opportunities where org_id = Halberd"].rows > 0 },
    { label: "Read draft research", ok: p["reports base table (drafts)"].rows > 0 },
    { label: "Read billing details (Stripe ids)", ok: !p["billing_details()"].blocked && p["billing_details()"].rows > 0 },
    { label: "Read organizations.stripe_customer_id directly", ok: !p["organizations.stripe_customer_id"].blocked },
  ];
}
