import { resolveAs } from "@/lib/snapshot";
import { Markdown, date } from "@/components/ui";

const reason = (r: any, a: any) => {
  if (!a) return "Sign in with a paid plan to read this report.";
  if (a.is_researcher) return "";
  if (!a.good_standing) return "Access limited: the subscription's payment failed and the grace period ended.";
  const tierOk = (a.features as string[]).includes(`reports.read.${r.tier_required}`);
  const agencyOk = (a.agencies as string[]).includes(r.agency) || (a.features as string[]).includes("agencies.all");
  if (!tierOk) return `Requires the ${r.tier_required} tier (you have ${a.tier ?? "no plan"}).`;
  if (!agencyOk) return `Your plan doesn't include ${r.agency} research.`;
  return "";
};

export default async function Reports({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { data } = await resolveAs(searchParams);
  const a = data.access as any;
  return (
    <>
      <h1>Research library</h1>
      <p className="lead">
        All {data.reports.visible} published reports can be found by everyone (title, agency, tier). Summaries need a subscription in good standing;
        bodies and attachments need the right tier <em>and</em> agency entitlement. The <code>report_library</code> view does the masking, so a
        locked body comes back as <code>null</code> from the API. It isn't just hidden with CSS.
      </p>
      <div className="row small" style={{ marginBottom: ".75rem" }}>
        <span className="badge allow">{data.reports.unlocked} unlocked</span>
        <span className="badge lock">{data.reports.visible - data.reports.unlocked} locked</span>
        <span className="muted">showing the 60 most recent</span>
      </div>
      {data.reports.rows.map((r: any) =>
        r.unlocked ? (
          <details key={r.id} className="report">
            <summary>
              <div className="spread"><span className="title">{r.title}</span><span className="badge allow">🔓 unlocked</span></div>
              <div className="row small muted">
                <span className="badge">{r.agency}</span><span className="badge tier">{r.tier_required}</span>
                {r.category && <span>{String(r.category).replace("_", " ")}</span>}<span>{date(r.published_at)}</span>
                {r.author_name && <span>by {r.author_name}</span>}
              </div>
              {r.summary && <div className="small">{r.summary}</div>}
            </summary>
            <div className="body">
              <Markdown text={r.body} />
              {r.attachment_path && <p className="small muted">Attachment moved from Bubble's CDN to Supabase Storage: <code>report-files/{r.attachment_path}</code></p>}
            </div>
          </details>
        ) : (
          <div key={r.id} className="report locked">
            <div className="summary" style={{ padding: ".8rem 1rem", display: "grid", gap: ".3rem" }}>
              <div className="spread"><span className="title">{r.title}</span><span className="badge lock">🔒 locked</span></div>
              <div className="row small muted">
                <span className="badge">{r.agency}</span><span className="badge tier">{r.tier_required}</span><span>{date(r.published_at)}</span>
              </div>
              {r.summary ? <div className="small">{r.summary}</div> : <div className="small muted">Summary hidden (subscribers only).</div>}
              <div className="lockline">{reason(r, a)} <span className="muted">API returned body = null.</span></div>
            </div>
          </div>
        ),
      )}
    </>
  );
}
