import { resolveAs, sharedContracts } from "@/lib/snapshot";
import { usd } from "@/components/ui";

const AGENCIES = ["DCD", "FHDA", "OSL", "NGRO", "BTS", "FCSA", "MSC", "FEMR"];

export default async function Contracts({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { key, data, sp } = await resolveAs(searchParams);
  const q = (typeof sp.q === "string" ? sp.q : "").trim().toLowerCase();
  const agency = typeof sp.agency === "string" && AGENCIES.includes(sp.agency) ? sp.agency : "";
  const can = data.contracts.visible > 0;
  const terms = q.split(/\s+/).filter(Boolean);
  const rows = can
    ? sharedContracts.filter((c) => (!agency || c.agency === agency) && terms.every((t) => `${c.piid} ${c.vendor_name} ${c.description} ${c.naics}`.toLowerCase().includes(t)))
    : [];
  return (
    <>
      <h1>Awarded contracts</h1>
      <p className="lead">
        Any subscriber in good standing can search all 9,000 synthetic awards (Postgres full-text search on a generated <code>tsvector</code> column).
        This snapshot includes the 1,000 most recent.
      </p>
      {!can ? (
        <div className="empty">
          <strong>No access.</strong> RLS returned 0 rows for this persona{data.contracts.error ? ` (${data.contracts.error})` : ""}.
          <div className="small">{key === "lapsed" ? "The subscription is past due and the grace period has ended." : "Contract search needs an active subscription."}</div>
        </div>
      ) : (
        <>
          <form className="search" method="get">
            <input type="hidden" name="as" value={key} />
            <input name="q" defaultValue={q} placeholder="Vendor, PIID, description or NAICS (e.g. radar)" aria-label="Search contracts" />
            <select name="agency" defaultValue={agency} aria-label="Agency">
              <option value="">All agencies</option>
              {AGENCIES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <button type="submit">Search</button>
          </form>
          <p className="small muted">{rows.length} matching awards{rows.length > 100 ? ", showing the first 100" : ""}</p>
          <div className="scroll">
            <table>
              <thead><tr><th>PIID</th><th>Agency</th><th>Vendor</th><th>Description</th><th>Set-aside</th><th className="num">Amount</th><th>Awarded</th></tr></thead>
              <tbody>
                {rows.slice(0, 100).map((c) => (
                  <tr key={c.id}>
                    <td><code>{c.piid}</code></td><td>{c.agency}</td><td>{c.vendor_name}</td><td>{c.description}</td><td>{c.set_aside}</td>
                    <td className="num">{usd(c.amount)}</td><td style={{ whiteSpace: "nowrap" }}>{c.award_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
