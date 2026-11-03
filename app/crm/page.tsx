import { resolveAs } from "@/lib/snapshot";
import { usd, date } from "@/components/ui";

const STAGES = ["identified", "qualifying", "capture", "proposal", "submitted", "won", "lost", "no_bid"];

export default async function Crm({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { data } = await resolveAs(searchParams);
  const a = data.access as any;
  const opps = data.crm.opportunities as any[];
  const notesBy = new Map<string, number>();
  for (const n of data.crm.notes as any[]) notesBy.set(n.opportunity_id, (notesBy.get(n.opportunity_id) ?? 0) + 1);
  const openTasks = new Map<string, number>();
  for (const t of data.crm.tasks as any[]) if (!t.done) openTasks.set(t.opportunity_id, (openTasks.get(t.opportunity_id) ?? 0) + 1);
  const probes = data.probes as Record<string, { blocked: boolean; rows: number; error: string | null; note?: string }>;
  const total = opps.reduce((s, o) => s + Number(o.value ?? 0), 0);

  return (
    <>
      <h1>Capture CRM{a?.org_name ? ` · ${a.org_name}` : ""}</h1>
      <p className="lead">
        Opportunities, notes and tasks belong to one organization and nobody else can see them. Researchers and support staff get no bypass.
        The server fills in the tenant id, and composite foreign keys stop a note, task or deal owner from pointing at another tenant's data.
      </p>
      {opps.length === 0 ? (
        <div className="empty">
          <strong>0 opportunities.</strong> {data.crm.error ? `API error: ${data.crm.error}` : "RLS returned no rows for this persona."}
          <div className="small">{a?.is_researcher ? "Researchers are internal staff, so customer pipelines are invisible to them by design." : a ? "" : "No session: the anon role has no grant on CRM tables."}</div>
        </div>
      ) : (
        <>
          <div className="row small" style={{ marginBottom: ".6rem" }}>
            <span className="badge">{opps.length} deals</span><span className="badge">{usd(total)} pipeline</span>
            <span className="badge">{data.crm.notes.length} notes</span><span className="badge">{data.crm.tasks.length} tasks</span>
          </div>
          <div className="kanban" aria-label="Pipeline by stage">
            {STAGES.map((st) => {
              const col = opps.filter((o) => o.stage === st);
              return (
                <section className="col" key={st}>
                  <h3><span>{st.replace("_", " ")}</span><span>{col.length}</span></h3>
                  {col.map((o) => (
                    <div className="opp" key={o.id}>
                      <div>{o.title}</div>
                      <div className="spread small muted"><span className="v">{usd(o.value)}</span><span>{o.agency} · due {date(o.due_date)}</span></div>
                      <div className="small muted">{notesBy.get(o.id) ?? 0} notes · {openTasks.get(o.id) ?? 0} open tasks</div>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}

      <h2>Trying to reach Halberd Systems' data as this persona</h2>
      <div className="card">
        {Object.entries(probes).map(([label, r]) => (
          <div className="probe" key={label}>
            <div>
              <code>{label}</code>
              {r.error && <div className="small muted">{r.error}</div>}
              {r.note && <div className="small muted">{r.note}</div>}
            </div>
            <div>{r.blocked || r.rows === 0 ? <span className="badge deny">blocked · {r.blocked ? "error" : "0 rows"}</span> : <span className="badge allow">{r.rows} row{r.rows === 1 ? "" : "s"}</span>}</div>
          </div>
        ))}
      </div>
    </>
  );
}
