import Link from "next/link";
import { allPersonas, resolveAs, validationReport } from "@/lib/snapshot";
import { latestCi } from "@/lib/ci";
import { Can, capabilities } from "@/components/ui";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { key, data } = await resolveAs(searchParams);
  const ci = await latestCi();
  const s = ci.summary;
  const a = data.access as any;
  const caps = capabilities(data);
  const everyone = allPersonas().map((p) => ({ key: p.key, label: p.data.persona.label, caps: capabilities(p.data) }));

  return (
    <>
      <h1>Bubble → Supabase, with the privacy rules proven</h1>
      <p className="lead">
        Bidmarker (fictional) sells federal bid intelligence: research reports on upcoming RFPs, an awarded-contracts database, government contacts
        and a capture CRM. This demo moves it off Bubble: every Bubble privacy rule becomes a Postgres RLS policy or a column-masking view,
        a generated test matrix proves each persona gets exactly what it should, and a 20,620-record export is migrated, re-run and validated.
      </p>

      <div className="grid three">
        <div className="card">
          <div className="stat-label">Allow / deny matrix</div>
          <div className="stat">{s.matrix?.cells ?? "—"}</div>
          <div className="small muted">{s.matrix?.personas} personas × {s.matrix?.probes} probes ({s.matrix?.allow} allow, {s.matrix?.deny} deny), generated from privacy-rules.yaml</div>
        </div>
        <div className="card">
          <div className="stat-label">pgTAP assertions</div>
          <div className="stat">{s.pgtap?.passed}/{s.pgtap?.total}</div>
          <div className="small muted">matrix + controls + coverage + billing rules · {s.pgtap?.mutations_caught}/{s.pgtap?.mutations_total} injected policy bugs caught</div>
        </div>
        <div className="card">
          <div className="stat-label">Attacker suite (supabase-js)</div>
          <div className="stat">{s.attacker?.passed}/{s.attacker?.total}</div>
          <div className="small muted">anon key, other org, escalating member, researcher, lapsed payer · plus {s.db ? s.db.total - (s.attacker?.total ?? 0) : 0} billing / first-login and {s.unit?.total} unit tests</div>
        </div>
        <div className="card">
          <div className="stat-label">Migration validation</div>
          <div className="stat" style={{ color: validationReport.status === "pass" ? "var(--allow)" : "var(--deny)" }}>{String(validationReport.status).toUpperCase()}</div>
          <div className="small muted">{validationReport.bubble_records.toLocaleString("en-US")} Bubble records · counts, checksums, {validationReport.integrity.length} integrity checks, sample diffs · <Link href={`/migration?as=${key}`}>report</Link></div>
        </div>
      </div>

      <h2>Viewing as: {data.persona.label}</h2>
      <div className="grid two">
        <div className="card">
          <p className="muted small" style={{ marginTop: 0 }}>{data.persona.blurb}</p>
          {a ? (
            <div className="row small">
              {a.org_name && <span className="badge">{a.org_name}</span>}
              {a.role && <span className="badge">{a.role}</span>}
              {a.is_researcher && <span className="badge tier">researcher</span>}
              {a.tier && <span className="badge tier">{a.tier}</span>}
              {a.status && <span className={`badge ${a.good_standing ? "allow" : "deny"}`}>{a.status}{a.good_standing ? " · good standing" : " · access limited"}</span>}
              {(a.agencies as string[] | null)?.map((g) => <span key={g} className="badge">{g}</span>)}
            </div>
          ) : (
            <span className="badge deny">no session</span>
          )}
          {a && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              Entitlements RLS sees right now: <code>{(a.features as string[]).length ? (a.features as string[]).join(", ") : "none"}</code>
            </p>
          )}
        </div>
        <div className="card">
          <ul className="can">
            {caps.map((c) => <Can key={c.label} ok={c.ok}>{c.label}</Can>)}
          </ul>
        </div>
      </div>

      <h2>Every persona side by side</h2>
      <p className="small muted">Each cell is the result of querying the database as that persona (signed in via magic link, through PostgREST) when the snapshot was exported.</p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              {everyone.map((p) => <th key={p.key}><Link href={`/?as=${p.key}`}>{p.key}</Link></th>)}
            </tr>
          </thead>
          <tbody>
            {caps.map((c, i) => (
              <tr key={c.label}>
                <td>{c.label.replace(/ \(.*\)$/, "")}</td>
                {everyone.map((p) => <td key={p.key}><span className={`cell ${p.caps[i].ok ? "a" : "d"}`}>{p.caps[i].ok ? "✓" : "✕"}</span></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
