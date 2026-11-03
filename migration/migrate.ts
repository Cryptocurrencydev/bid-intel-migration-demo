// Bubble → Supabase migration: extract (paged Data API) → transform → idempotent load → re-host files.
// Usage: tsx migration/migrate.ts [--start-mock]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { loadLocalEnv } from "../lib/local-env";
import { extractType, fetchJson } from "./bubble-client";
import { transformAll, type FileJob } from "./transform";
import { SPECS, upsertBatches, upsertAuthUsers, type LoadStats } from "./load";
import { COUNTS, type BubbleData, type StripeCustomer } from "./mock-bubble/generate";

loadLocalEnv();
const BUBBLE_ROOT = process.env.BUBBLE_ROOT ?? "http://127.0.0.1:8787";
const BUBBLE_TOKEN = process.env.BUBBLE_API_TOKEN ?? "mock-bubble-admin-token";
const TYPES = Object.keys(COUNTS);
const LOAD_ORDER = [
  "id_map", "organizations", "auth_users", "members", "researchers", "subscriptions", "subscription_agencies",
  "reports", "report_tags", "awarded_contracts", "contacts", "crm_opportunities", "crm_opportunity_reports", "crm_notes", "crm_tasks",
];

async function main() {
  const t0 = Date.now();
  let mock: { close: () => void } | undefined;
  if (process.argv.includes("--start-mock")) {
    const { startMockBubble } = await import("./mock-bubble/server");
    mock = await startMockBubble(8787);
  }
  const pool = new pg.Pool({ connectionString: process.env.DB_URL, max: 6 });
  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const run = (await pool.query("insert into migration.runs default values returning id")).rows[0].id as number;
  console.log(`migration run #${run}`);

  // 1. Extract ------------------------------------------------------------------------------
  const tExtract = Date.now();
  const data: BubbleData = {};
  const extract: Record<string, { records: number; pages: number }> = {};
  for (const type of TYPES) {
    const { records, pages } = await extractType(type, { baseUrl: `${BUBBLE_ROOT}/api/1.1`, token: BUBBLE_TOKEN });
    data[type] = records;
    extract[type] = { records: records.length, pages };
    await pool.query(
      `insert into migration.checkpoints (bubble_type, cursor) values ($1, $2)
       on conflict (bubble_type) do update set cursor = excluded.cursor, updated_at = now()`,
      [type, records.length],
    );
    console.log(`  extract ${type.padEnd(17)} ${String(records.length).padStart(6)} records in ${pages} pages`);
  }
  const stripe: StripeCustomer[] = (await fetchJson(`${BUBBLE_ROOT}/stripe/customers.json`, BUBBLE_TOKEN)).data;
  const extractMs = Date.now() - tExtract;

  // 2. Transform ----------------------------------------------------------------------------
  const tTransform = Date.now();
  const { rows, idmap, files, issues } = transformAll(data, stripe);
  const transformMs = Date.now() - tTransform;
  console.log(`  transform: ${idmap.length} ids mapped, ${files.length} files, ${issues.length} issues`);

  // 3. Load ---------------------------------------------------------------------------------
  const tLoad = Date.now();
  const load: Record<string, LoadStats> = {};
  for (const name of LOAD_ORDER) {
    if (name === "auth_users") load[name] = await upsertAuthUsers(pool, rows.auth_users);
    else if (name === "id_map") load[name] = await upsertBatches(pool, SPECS.id_map, idmap, 1000);
    else load[name] = await upsertBatches(pool, SPECS[name], rows[name]);
    const s = load[name];
    console.log(`  load ${name.padEnd(24)} rows ${String(s.rows).padStart(6)}  +${s.inserted} ~${s.updated} =${s.unchanged} -${s.removed}  ${s.ms}ms`);
  }
  await pool.query("update migration.id_map set last_seen_at = now()");
  const loadMs = Date.now() - tLoad;

  // 4. Files → Supabase Storage -------------------------------------------------------------
  const tFiles = Date.now();
  const done = new Set((await pool.query("select bubble_url from migration.files")).rows.map((r) => r.bubble_url as string));
  const todo = files.filter((f) => !done.has(f.bubble_url));
  let uploaded = 0;
  let bytes = 0;
  const worker = async (queue: FileJob[]) => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const res = await fetch(`${BUBBLE_ROOT}${f.cdn_path}`);
      if (!res.ok) throw new Error(`download ${f.bubble_url}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { error } = await supa.storage.from(f.bucket).upload(f.path, buf, { upsert: true, contentType: res.headers.get("content-type") ?? undefined });
      if (error) throw new Error(`upload ${f.path}: ${error.message}`);
      await pool.query(
        `insert into migration.files (bubble_url, bucket, path, sha256, bytes) values ($1, $2, $3, $4, $5)
         on conflict (bubble_url) do update set sha256 = excluded.sha256, bytes = excluded.bytes, uploaded_at = now()`,
        [f.bubble_url, f.bucket, f.path, createHash("sha256").update(buf).digest("hex"), buf.length],
      );
      uploaded++;
      bytes += buf.length;
    }
  };
  const queue = [...todo];
  await Promise.all(Array.from({ length: 8 }, () => worker(queue)));
  const filesMs = Date.now() - tFiles;
  console.log(`  files: ${files.length} total, ${uploaded} uploaded (${(bytes / 1024).toFixed(0)} KiB), ${files.length - uploaded} already re-hosted`);

  // 5. Record the run -------------------------------------------------------------------------
  await pool.query("delete from migration.issues where run_id = $1", [run]);
  for (let i = 0; i < issues.length; i += 500) {
    await pool.query(
      `insert into migration.issues (run_id, severity, kind, bubble_type, bubble_id, detail)
       select $1, x.severity, x.kind, x.bubble_type, x.bubble_id, x.detail
       from jsonb_to_recordset($2::jsonb) as x(severity text, kind text, bubble_type text, bubble_id text, detail text)`,
      [run, JSON.stringify(issues.slice(i, i + 500))],
    );
  }
  const totals = Object.values(load).reduce((a, s) => ({ inserted: a.inserted + s.inserted, updated: a.updated + s.updated, unchanged: a.unchanged + s.unchanged, removed: a.removed + s.removed }), { inserted: 0, updated: 0, unchanged: 0, removed: 0 });
  const stats = {
    run,
    bubble_records: Object.values(extract).reduce((a, e) => a + e.records, 0),
    extract,
    load,
    totals,
    files: { total: files.length, uploaded, skipped: files.length - uploaded, bytes },
    issues: issues.reduce<Record<string, number>>((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {}),
    timings_ms: { extract: extractMs, transform: transformMs, load: loadMs, files: filesMs, total: Date.now() - t0 },
  };
  await pool.query("update migration.runs set finished_at = now(), stats = $2 where id = $1", [run, stats]);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(`artifacts/migration-run-${run}.json`, JSON.stringify(stats, null, 1));
  console.log(`run #${run}: ${stats.bubble_records} Bubble records; +${totals.inserted} inserted, ~${totals.updated} updated, =${totals.unchanged} unchanged; ${stats.timings_ms.total}ms`);
  await pool.end();
  mock?.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
