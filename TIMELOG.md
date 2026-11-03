# TIMELOG

Local time (WAT, UTC+1). One build session, 2026-11-03 → 2026-11-04.

| # | Phase | Start | End | Duration | Notes |
|---|---|---|---|---|---|
| 0 | Setup | 23:42 | 23:45 | 3 min | repo, Supabase local config (ports 574xx, signups off, no auto-expose), Colima already running |
| 1 | Privacy rules → RLS | 23:45 | 23:59 | 14 min | `privacy-rules.yaml`, schema + privacy migrations, seed personas, pgTAP generator; first run 747/748 (the failing control showed the composite tenant FK blocks cross-org moves even for the service role, so that control was marked n/a); mutation check 8/8 |
| 2 | Bubble migration | 23:59 | 00:06 | 7 min | mock Data API (20,620 records, 429s, CDN, Stripe export), transform, idempotent loader, file re-hosting, validation report; worked first run, re-run 0 changes |
| 3 | Stripe + Postmark + attacker suite | 00:06 | 00:12 | 6 min | webhook core, sender adapter, first-login magic link; 24 unit + 58 DB tests. Rewrote policies to `(select helper())` (billing suite 5.2 s → 0.1 s). Proved the attacker suite catches an opened policy (10 failures) |
| 4 | Snapshot export + UI | 00:12 | 00:23 | 11 min | per-persona export through PostgREST (hit `max_rows = 1000`, aligned), Next.js pages, Playwright smoke at 390/1280 |
| 5 | Rollback log, docs, CI | 00:23 | 00:30 | 7 min | `ops.change_log` + replay planner, list-field checksums, drift → fail → heal rehearsal, README, MIGRATION.md, GitHub Actions |
| 6 | Publish | 00:30 | 00:40 | 10 min | gitleaks (clean), public repo, `vercel link`; CI run 1: database job green, smoke failed (10px overflow on /crm at 390px with Linux fonts). Fixed, smoke now also checks 320px |

Measured inside the pipeline (local, Apple Silicon + Colima):

| Step | Time |
|---|---|
| pgTAP: 770 assertions + 8 mutation re-runs | 6.6 s |
| Migration run 1 (20,620 records, 397 files) | 7.4 s (extract 5.2, transform 0.1, load 1.1, files 1.0) |
| Migration re-run (0 changes) | 6.1 s |
| Validation report | ~6 s |
| Attacker + billing + first-login + rollback suites (72 tests) | ~2 s |
