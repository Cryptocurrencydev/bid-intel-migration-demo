// Bundles every test result + the live policy definitions into artifacts/ci-results.json.
// CI publishes it as a release asset (ci-latest) that the /security page reads; a copy is
// committed under snapshot/ as the fallback.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import pg from "pg";
import { loadLocalEnv } from "../lib/local-env";

loadLocalEnv();
const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

function vitest(file: string) {
  const j = read(file);
  if (!j) return null;
  const tests = j.testResults.flatMap((f: any) =>
    f.assertionResults.map((a: any) => ({ file: f.name.split("/tests/")[1] ?? f.name, suite: a.ancestorTitles.join(" › "), title: a.title, status: a.status, ms: Math.round(a.duration ?? 0) })),
  );
  return { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, tests };
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DB_URL });
  const policies = (await pool.query(`
    select schemaname as schema, tablename as table, policyname as name, cmd, roles::text[] as roles, qual as using, with_check
    from pg_policies
    where schemaname = 'public' or (schemaname = 'storage' and (policyname like 'report_files_%' or policyname like 'org_logos_%'))
    order by tablename, policyname`)).rows;
  const columnGrants = (await pool.query(`
    select table_name as table, grantee, privilege_type as privilege, array_agg(column_name::text order by column_name) as columns
    from information_schema.column_privileges
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
    group by 1, 2, 3 order by 1, 2, 3`)).rows;
  const views = (await pool.query(`
    select c.relname as name, c.reloptions as options, pg_get_viewdef(c.oid, true) as definition
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' order by 1`)).rows;
  await pool.end();

  const pgtap = read("artifacts/pgtap-results.json");
  const unit = vitest("artifacts/vitest-unit.json");
  const db = vitest("artifacts/vitest-db.json");
  const validation = read("artifacts/validation-report.json");
  const manifest = read("snapshot/matrix-manifest.json");
  const repo = process.env.GITHUB_REPOSITORY;
  const bundle = {
    generated_at: new Date().toISOString(),
    run: process.env.GITHUB_RUN_ID
      ? { id: process.env.GITHUB_RUN_ID, number: process.env.GITHUB_RUN_NUMBER, sha: process.env.GITHUB_SHA, url: `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` }
      : { id: null, number: null, sha: null, url: null, local: true },
    summary: {
      pgtap: pgtap?.summary ?? null,
      matrix: manifest ? { cells: manifest.cells.length, personas: Object.keys(manifest.personas).length, probes: manifest.cells.length / Object.keys(manifest.personas).length, controls: manifest.controls.length, allow: manifest.cells.filter((c: any) => c.expect === "allow").length, deny: manifest.cells.filter((c: any) => c.expect === "deny").length } : null,
      unit: unit && { total: unit.total, passed: unit.passed, failed: unit.failed },
      db: db && { total: db.total, passed: db.passed, failed: db.failed },
      attacker: db && { total: db.tests.filter((t: any) => t.file.includes("attacker")).length, passed: db.tests.filter((t: any) => t.file.includes("attacker") && t.status === "passed").length },
      validation: validation ? { status: validation.status, bubble_records: validation.bubble_records } : null,
    },
    pgtap: pgtap ? { results: pgtap.results.map((r: any) => [r.ok ? 1 : 0, r.desc]), mutations: pgtap.mutations } : null,
    vitest: { unit: unit?.tests ?? [], db: db?.tests ?? [] },
    policies, column_grants: columnGrants, views,
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/ci-results.json", JSON.stringify(bundle));
  copyFileSync("artifacts/ci-results.json", "snapshot/ci-results.json");
  console.log(JSON.stringify(bundle.summary, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
