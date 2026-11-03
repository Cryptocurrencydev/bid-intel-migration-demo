// Rollback helper: turns ops.change_log entries since cutover into Bubble Data API calls
// (POST /obj/<type> for new rows, PATCH /obj/<type>/<id> for updates, DELETE for deletes).
// Dry run by default: prints the plan as JSON. Usage: tsx migration/replay-to-bubble.ts --since 2026-11-03T22:00:00Z [--execute]
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { loadLocalEnv } from "../lib/local-env";

loadLocalEnv();
const TYPE: Record<string, string> = { crm_opportunities: "opportunity", crm_notes: "note", crm_tasks: "task", members: "user", organizations: "organization" };
const since = process.argv[process.argv.indexOf("--since") + 1] ?? new Date(Date.now() - 86_400_000).toISOString();

const pool = new pg.Pool({ connectionString: process.env.DB_URL });
const rows = (await pool.query(
  `select c.id, c.at, c.table_name, c.op, c.row_id, c.org_id, c.actor, c.data, m.bubble_id
   from ops.change_log c left join migration.id_map m on m.uuid = c.row_id
   where c.at >= $1 order by c.id`, [since])).rows;
// collapse to the final state per row, so a row created then edited becomes one POST
const last = new Map<string, any>();
for (const r of rows) last.set(`${r.table_name}:${r.row_id}`, { ...(last.get(`${r.table_name}:${r.row_id}`) ?? { first_op: r.op }), ...r });
const plan = [...last.values()].map((r) => {
  const type = TYPE[r.table_name];
  if (r.op === "DELETE") return r.bubble_id ? { method: "DELETE", path: `/obj/${type}/${r.bubble_id}` } : { method: "SKIP", reason: "created and deleted after cutover", row: r.row_id };
  if (!r.bubble_id || r.first_op === "INSERT") return { method: "POST", path: `/obj/${type}`, body: r.data, maps_uuid: r.row_id };
  return { method: "PATCH", path: `/obj/${type}/${r.bubble_id}`, body: r.data };
});
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/replay-plan.json", JSON.stringify({ since, changes: rows.length, calls: plan }, null, 1));
console.log(`replay since ${since}: ${rows.length} logged changes → ${plan.length} Bubble API calls (${["POST", "PATCH", "DELETE", "SKIP"].map((m) => `${plan.filter((p) => p.method === m).length} ${m}`).join(", ")})${process.argv.includes("--execute") ? "" : " [dry run]"}`);
await pool.end();
