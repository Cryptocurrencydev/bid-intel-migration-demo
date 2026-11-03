import { latestCi } from "@/lib/ci";
import { matrixManifest as M } from "@/lib/snapshot";

export const revalidate = 300;

const PERSONA_ORDER = ["anon", "free_user", "basic_member", "pro_owner", "pro_admin", "pro_member", "other_org_owner", "grace_member", "lapsed_member", "researcher"];
const SHORT: Record<string, string> = { anon: "anon", free_user: "free", basic_member: "basic", pro_owner: "owner", pro_admin: "admin", pro_member: "member", other_org_owner: "other org", grace_member: "grace", lapsed_member: "lapsed", researcher: "research" };

function fields(v: unknown) {
  if (v === "all") return "all fields";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "nothing";
  return "—";
}

export default async function Security() {
  const ci = await latestCi();
  const results = new Map<string, boolean>((ci.pgtap?.results ?? []).map(([ok, desc]: any) => [desc as string, ok === 1]));
  const policyByName = new Map((ci.policies as any[]).map((p) => [p.name, p]));
  const s = ci.summary as any;
  const attacker = (ci.vitest.db as any[]).filter((t) => t.file.includes("attacker"));
  const otherDb = (ci.vitest.db as any[]).filter((t) => !t.file.includes("attacker"));
  const suites = [...new Set(attacker.map((t) => t.suite))];

  return (
    <>
      <h1>Security: every policy and the tests that prove it</h1>
      <p className="lead">
        Bubble privacy rules (left of each card) are translated into RLS policies, column grants and masking views (right). Each data type has
        probes. Every probe runs as all 10 fixture personas inside a rolled-back subtransaction, and any persona the spec doesn't allow must be denied.
        Control assertions run every probe with RLS bypassed too, so a deny can't pass just because a row is missing.
      </p>
      <div className="card small" style={{ marginBottom: "1rem" }}>
        {ci.run?.url ? (
          <>Results from <a href={ci.run.url}>GitHub Actions run #{ci.run.number}</a> · commit <code>{String(ci.run.sha).slice(0, 7)}</code> · {ci.generated_at.slice(0, 16).replace("T", " ")} UTC · loaded from the {ci.source === "release" ? "latest CI release asset" : "committed snapshot"}</>
        ) : (
          <>Results from a local run at {ci.generated_at.slice(0, 16).replace("T", " ")} UTC (committed snapshot). CI publishes newer results on every push to main.</>
        )}
      </div>

      <div className="grid three">
        <div className="card"><div className="stat-label">Matrix cells</div><div className="stat">{s.matrix.cells}</div><div className="small muted">{s.matrix.personas} personas × {s.matrix.probes} probes · {s.matrix.allow} allow / {s.matrix.deny} deny · +{s.matrix.controls} controls</div></div>
        <div className="card"><div className="stat-label">pgTAP</div><div className="stat">{s.pgtap.passed}/{s.pgtap.total}</div><div className="small muted">incl. policy coverage (database ⇔ YAML), RLS-on-every-table, pinned search_path, billing rules</div></div>
        <div className="card"><div className="stat-label">Attacker suite</div><div className="stat">{s.attacker.passed}/{s.attacker.total}</div><div className="small muted">supabase-js over HTTP: anon key, other org, member escalation, forged JWTs, metadata spoofing</div></div>
        <div className="card"><div className="stat-label">Mutation check</div><div className="stat">{s.pgtap.mutations_caught}/{s.pgtap.mutations_total}</div><div className="small muted">policy bugs injected on purpose; the matrix has to fail for each one</div></div>
      </div>

      <h2>Mutation check</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>Injected bug</th><th>Caught</th><th className="num">Failing assertions</th><th>Example</th></tr></thead>
          <tbody>
            {(ci.pgtap?.mutations ?? []).map((m: any) => (
              <tr key={m.name}><td>{m.name}</td><td><span className={`badge ${m.caught ? "allow" : "deny"}`}>{m.caught ? "caught" : "missed"}</span></td><td className="num">{m.failing_assertions}</td><td className="small"><code>{m.examples[0]}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {Object.entries(M.data_types as Record<string, any>).map(([type, dt]) => {
        const probes = Object.entries(dt.probes as Record<string, any>);
        const table = String(dt.table).replace("public.", "");
        const grants = (ci.column_grants as any[]).filter((g) => g.table === table);
        const passed = probes.reduce((acc, [pn]) => acc + PERSONA_ORDER.filter((p) => results.get(`[${type}.${pn}] ${p} → ${(dt.probes[pn].allow as string[]).includes(p) ? "allow" : "deny"}`)).length, 0);
        return (
          <section key={type} id={type}>
            <h2>{type} <span className="small muted">· {dt.table}{dt.view ? ` + ${dt.view}` : ""}</span></h2>
            <div className="grid two">
              <div className="card">
                <h3>Bubble privacy rules</h3>
                {(dt.bubble_rules as any[]).map((r) => (
                  <div key={r.name} style={{ marginBottom: ".6rem" }}>
                    <div><strong>{r.name}</strong></div>
                    <div className="small muted">When: {r.when}</div>
                    <div className="small">View: {fields(r.view_fields)}{r.find_in_searches ? " · find in searches" : ""}{r.view_attached_files ? " · view files" : ""}{r.auto_binding ? ` · auto-binding: ${r.auto_binding === "all" ? "all" : Object.keys(r.auto_binding).join(", ")}` : ""}</div>
                  </div>
                ))}
                {Object.keys(dt.restricted_fields).length > 0 && (
                  <>
                    <h3>Field-level restrictions</h3>
                    <ul className="small" style={{ paddingLeft: "1.1rem", margin: 0 }}>
                      {Object.entries(dt.restricted_fields as Record<string, string>).map(([f, d]) => <li key={f}><code>{f}</code>: {d}</li>)}
                    </ul>
                  </>
                )}
              </div>
              <div className="card">
                <h3>Postgres</h3>
                {(dt.postgres.policies as string[] | undefined)?.map((name) => {
                  const p = policyByName.get(name);
                  return (
                    <details key={name} style={{ marginBottom: ".35rem" }}>
                      <summary className="small"><code>{name}</code> {p ? <span className="badge">{p.cmd}</span> : <span className="badge deny">missing</span>} {p && <span className="muted">{(p.roles as string[]).join(", ")}</span>}</summary>
                      {p?.using && <pre>USING {p.using}</pre>}
                      {p?.with_check && <pre>WITH CHECK {p.with_check}</pre>}
                    </details>
                  );
                })}
                {dt.postgres.column_grants && <p className="small"><strong>Grants:</strong> {dt.postgres.column_grants}</p>}
                {dt.postgres.view && <p className="small"><strong>View:</strong> {dt.postgres.view}</p>}
                {dt.postgres.integrity && <p className="small"><strong>Integrity:</strong> {dt.postgres.integrity}</p>}
                {dt.postgres.rpc && <p className="small"><strong>RPC:</strong> {(dt.postgres.rpc as string[]).join(", ")}</p>}
                {grants.length > 0 && (
                  <details>
                    <summary className="small">Live column privileges ({grants.length})</summary>
                    <ul className="small" style={{ paddingLeft: "1.1rem" }}>
                      {grants.map((g) => <li key={`${g.grantee}${g.privilege}`}><code>{g.grantee}</code> {g.privilege}: {(g.columns as string[]).join(", ")}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            </div>
            <p className="small muted" style={{ margin: ".75rem 0 .35rem" }}>Matrix for {type}: {passed}/{probes.length * PERSONA_ORDER.length} cells passing in CI. ✓ allowed, ✕ denied; a black outline marks a failing cell.</p>
            <div className="scroll">
              <table className="matrix">
                <thead><tr><th>probe</th>{PERSONA_ORDER.map((p) => <th key={p}><span className="vhead">{SHORT[p]}</span></th>)}</tr></thead>
                <tbody>
                  {probes.map(([pn, pr]) => (
                    <tr key={pn}>
                      <td title={pr.sql}><code>{pn}</code></td>
                      {PERSONA_ORDER.map((p) => {
                        const allow = (pr.allow as string[]).includes(p);
                        const ok = results.get(`[${type}.${pn}] ${p} → ${allow ? "allow" : "deny"}`);
                        return <td key={p}><span className={`cell ${allow ? "a" : "d"}${ok === false || ok === undefined ? " fail" : ""}`} title={ok ? "passing" : "not passing"}>{allow ? "✓" : "✕"}</span></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <h2>Attacker suite ({attacker.filter((t) => t.status === "passed").length}/{attacker.length} passing)</h2>
      <p className="small muted">tests/db/attacker.test.ts: real HTTP calls to PostgREST, Storage and GoTrue with supabase-js. Halberd Systems is the victim tenant; its ids are treated as leaked.</p>
      {suites.map((suite) => (
        <div className="card tight" key={suite} style={{ marginBottom: ".6rem" }}>
          <h3>{suite}</h3>
          <ul className="can">
            {attacker.filter((t) => t.suite === suite).map((t) => (
              <li key={t.title}><span className={t.status === "passed" ? "y" : "n"}>{t.status === "passed" ? "✓" : "✕"}</span><span>{t.title}</span></li>
            ))}
          </ul>
        </div>
      ))}

      <h2>Billing, email and first-login tests</h2>
      <div className="card tight">
        <ul className="can">
          {[...otherDb, ...(ci.vitest.unit as any[])].map((t) => (
            <li key={t.file + t.title}><span className={t.status === "passed" ? "y" : "n"}>{t.status === "passed" ? "✓" : "✕"}</span><span>{t.title} <span className="muted small">· {t.file}</span></span></li>
          ))}
        </ul>
      </div>
    </>
  );
}
