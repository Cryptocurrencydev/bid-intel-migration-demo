# Migration runbook: Bubble → Next.js + Supabase

This is the plan for moving Bidmarker's production data (thousands of users, every tenant's CRM) off Bubble.
Every step below has been rehearsed in CI against a local Supabase with a 20,620-record synthetic export
(`scripts/ci-migration.sh`). The goal is a **write freeze measured in minutes, a single DNS change, and a rollback
that loses no customer writes**.

## Roles

| Role | Who | Owns |
|---|---|---|
| Cutover lead | Technical lead | go / no-go, timeline, rollback call |
| Migration operator | Engineer #2 | runs extract/load/validate, watches logs |
| Verifier | Someone who didn't write the migration | dual verification, signs the checklist |
| Comms | Customer success | status page, customer emails, support inbox |

## What moves and how

| Bubble | Supabase | Notes |
|---|---|---|
| Data types (9) | tables in `public` | Every row keeps `bubble_id`; `migration.id_map` maps Bubble id → UUID (deterministic v5, so re-runs land on the same rows) |
| Option sets | Postgres enums | Unknown display values **fail the run**; we never guess |
| List fields | join tables | `subscription_agencies`, `report_tags`, `crm_opportunity_reports`; items removed in Bubble are removed on re-run |
| Files on `s3.amazonaws.com/appforest_uf` | Supabase Storage (`report-files`, `org-logos`) | Path `<row uuid>/<file name>`; `migration.files` stores the sha256 so a re-run skips files already moved |
| Rich text (BBCode) | Markdown | `bbcodeToMarkdown` |
| Users | `auth.users` + `members` / `researchers` | **No passwords.** Users get a magic link on first login (Postmark adapter). Users without an email, or with duplicate emails, become members with no login and are listed for outreach |
| Privacy rules | RLS + column grants + masking views | see `privacy-rules.yaml` and the README |
| Stripe customer ids | `organizations.stripe_customer_id` | Matched against a Stripe export by `metadata.bubble_org_id`; missing ids are backfilled, orphans reported |

Data problems that Bubble allowed and Postgres won't (a note authored by someone in another org, an owner
pointing at a deleted user) are **set to null and logged** in `migration.issues`. They're never silently kept.

## Timeline

Durations come from the CI rehearsal (20.6k records: extract 5.2 s including throttling, load 1.1 s, 397 files 1.0 s)
plus a production estimate. Bubble's Data API returns 100 records per call and rate limits, so extract time scales
with request count. Budget about 1 minute per 50k records, then rehearse at full size.

### T-14 days: rehearsals
1. Get a read-only Data API token for a **copy** of the Bubble app (Settings → API → generate key, data types exposed).
2. Run the full pipeline against a Supabase **staging** project: `migrate` twice, `validate`, then the attacker suite.
3. Fix every issue kind that shows up in the report. Agree with customer success how to handle the `user_without_email` and `duplicate_email` lists.
4. Time the extract at production size. That number sets the freeze window.

### T-2 days
1. Lower the DNS TTL on `app.` to 60 s (Cloudflare: proxied records already switch at the edge; lower it anyway for anyone pinning the origin).
2. Point a second Stripe webhook endpoint at the new app (**disabled**). Note its signing secret in Vercel env.
3. Set up Postmark: verified sender domain (SPF, DKIM, Return-Path), `outbound` transactional stream, plus a separate broadcast stream for the "we've moved" announcement.
4. Email customers the freeze window. Put the status page banner up.

### T-0: cutover (target ≤ 30 min freeze)

| # | Step | Command / action | Exit criterion |
|---|---|---|---|
| 1 | **Freeze Bubble writes** | Maintenance page on every write page, plus a "read-only" yes/no on the app (privacy rules / workflow conditions `Only when app_read_only is no`); pause backend workflows and scheduled API workflows | No `Modified Date` newer than freeze time (spot query on each type) |
| 2 | Raw backup of Bubble | Bubble Settings → Backup + full JSON extract to an encrypted bucket (`artifacts/extract/*`) | Files present, counts logged |
| 3 | Safety snapshot of the target | `pg_dump --format=custom --no-owner "$PROD_DB_URL" > pre-cutover.dump` (and PITR restore point if available) | Dump size > 0, `pg_restore --list` works |
| 4 | Migrate | `tsx migration/migrate.ts` | Exits 0 |
| 5 | Migrate again | `tsx migration/migrate.ts` | **0 inserted, 0 updated, 0 files uploaded** (proves the first run finished and nothing is in flight) |
| 6 | Automated verification | `tsx migration/validate.ts` (re-extracts from Bubble on its own) | `status: pass`: counts, checksums, list-field checksums, 13 integrity checks, sample diffs |
| 7 | **Dual verification** | Verifier opens the validation report and checks 10 accounts by hand in both systems (one per tier, the biggest pipelines, one lapsed account), then runs the attacker suite against production with test personas | Signed checklist |
| 8 | Billing switch | Enable the new Stripe webhook endpoint, disable Bubble's. Events from the freeze window are replayed with `stripe events resend` (handler is idempotent on `event.id`) | `ops.stripe_events` receiving, no 4xx/5xx |
| 9 | **DNS cutover** | Cloudflare: change `app.` CNAME from the Bubble target to Vercel (`cname.vercel-dns.com`), proxied | `curl -sI https://app.…` shows Vercel headers from 3 regions |
| 10 | Open the doors | Lift the maintenance banner; first logins get magic links | Sentry error rate normal; auth success > 95% |

**Bubble stays read-only (not deleted, not writable) until sign-off.**

### T+1 hour to T+7 days: watch
- Sentry: errors by release, RLS-denied counts (`42501`) by route. A spike means a policy is too tight.
- Postgres: `ops.change_log` growth (post-cutover writes), slow queries (`pg_stat_statements`).
- Support inbox: "I can't see X" tickets get triaged against `privacy-rules.yaml` before anyone touches a policy.
- Day 7 sign-off: product + customer success + technical lead. Then Bubble's API key is revoked and the app is archived (keep the backup for 12 months).

## Rollback

**Triggers** (any one, before sign-off): validation fails and can't be fixed in the window; a cross-tenant read is confirmed;
auth success < 80% for 15 minutes; billing webhooks failing with no fix in sight.

**Steps**
1. **Point DNS back to Bubble** (Cloudflare record, proxied, TTL 60 s). Users are back on Bubble within a minute or two.
2. Disable the new Stripe endpoint and re-enable Bubble's. Resend events since cutover to Bubble (`stripe events resend <id>` for each `ops.stripe_events` row after the cutover time).
3. **Replay writes made after cutover** into Bubble. Every app write to CRM / member / org rows is captured by
   triggers in `ops.change_log` (actor, tenant, row snapshot). Run
   `tsx migration/replay-to-bubble.ts --since <cutover time>`. It collapses changes per row and plans Bubble
   Data API calls (POST for new rows, PATCH by `bubble_id` via `migration.id_map`, DELETE). It's a dry run by default and writes `artifacts/replay-plan.json`; review it, then run with `--execute`.
4. Keep Bubble **read-only until the replay is verified** (spot-check the replayed rows), then lift the freeze on Bubble.
5. Post-mortem. Fix, re-rehearse, reschedule. The target database is restored from `pre-cutover.dump` (or simply re-migrated, since the load is idempotent).

## Users and first login
- Users come over without passwords (`encrypted_password = ''`), confirmed when Bubble had them confirmed, with an email identity so magic links work.
- Login page: email → `sendFirstLoginLink()` generates a magic link with the admin API and sends it through the Postmark adapter (`magic_link` template). Same response whether the address exists or not.
- After first login users can set a password or stay passwordless. Public sign-up stays off; new users join by invite (owner/admin) or through checkout.

## Commands
```bash
supabase start                                   # local stack (docker)
npx tsx migration/mock-bubble/server.ts &        # mock Bubble Data API on :8787
npx tsx migration/migrate.ts                     # extract → transform → load → files
npx tsx migration/validate.ts                    # artifacts/validation-report.{json,md}
bash scripts/ci-migration.sh                     # the full CI rehearsal incl. drift + heal
npx tsx migration/replay-to-bubble.ts --since 2026-11-03T22:00:00Z
```
