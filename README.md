# Bidmarker: Bubble → Next.js + Supabase migration demo

A working example of moving a multi-tenant government bid-intelligence SaaS off Bubble. Federal contractors subscribe
to research reports on upcoming RFPs, a searchable awarded-contracts database, government contacts, and a capture CRM
for their own pipeline. The parts that are hard to get right are **tenant isolation** and **proving it**, so that's
where most of the code goes.

**Live UI (snapshot mode):** https://bid-intel-migration-demo.vercel.app
**Latest CI results:** [Actions](https://github.com/Cryptocurrencydev/bid-intel-migration-demo/actions/workflows/ci.yml) · [ci-latest release assets](https://github.com/Cryptocurrencydev/bid-intel-migration-demo/releases/tag/ci-latest)

> **Snapshot mode.** The live database runs locally / in CI, and the Vercel site shows a snapshot of it. No hosted
> Supabase project is involved. CI starts Supabase in Docker, runs every test and the full migration, then exports what
> each persona actually sees (signed in via magic link, through PostgREST) to JSON. The UI renders that JSON. The
> `/security` and `/migration` pages read the latest green run's results from the `ci-latest` release.

Bidmarker, its customers and the agencies are fictional. All 20,620 records are synthetic.

## What's in here

| | |
|---|---|
| `privacy-rules.yaml` | The Bubble privacy rules written out per data type ("when Current User's organization is This Thing's organization → view all fields, find in searches"), field restrictions, tier → entitlement mapping, and the allow/deny probes |
| `supabase/migrations/` | Schema, RLS policies, column grants, masking views, helper functions, change log |
| `supabase/tests/` | pgTAP: the **generated** 700-cell matrix (`10_…`) and hand-written billing rules (`20_…`) |
| `tests/db/attacker.test.ts` | 54 attacks over HTTP with supabase-js: anon key, another org, an escalating member, a researcher, a lapsed payer, forged JWTs |
| `tests/db/billing.test.ts` | Stripe lifecycle with signed sample events: subscribe → payment failed → grace → limited → paid → restored |
| `migration/` | Mock Bubble Data API, extract/transform/load, validation report, rollback replay |
| `lib/billing`, `lib/email` | Stripe webhook core (signature, idempotency, entitlements), Postmark sender adapter with test mode |
| `app/` | Next.js UI: report library, contract search, CRM pipeline, persona switcher, `/security`, `/migration` |
| `MIGRATION.md` | Cutover runbook: freeze, pg_dump, dual verification, DNS cutover, rollback |

## Architecture

```mermaid
flowchart LR
  subgraph Bubble["Bubble (today)"]
    BAPI["Data API /api/1.1/obj"]
    BCDN["appforest_uf file CDN"]
  end
  subgraph Migration["migration/ (CI + cutover)"]
    X[extract, paged + retries] --> T[transform: ids→uuid v5, option sets→enums, lists→join tables] --> L[idempotent batch load] --> V[validate: re-extract, counts, checksums, RI, diffs]
  end
  BAPI --> X
  BCDN --> L
  subgraph Supabase["Supabase (Postgres 17)"]
    RLS["RLS + column grants + masking views<br/>private.current_features() etc."]
    ST[Storage buckets]
    AUTH["GoTrue: passwordless, magic link"]
    OPS["ops.stripe_events · ops.email_outbox · ops.change_log"]
  end
  L --> Supabase
  subgraph App["Next.js on Vercel"]
    UI[Server components] --> PGR[PostgREST with user JWT]
    WH["/api/stripe/webhook"]
  end
  PGR --> RLS
  Stripe((Stripe)) -- signed events --> WH --> OPS
  WH -- status / grace / tier --> RLS
  WH --> PM((Postmark))
  CF((Cloudflare DNS/WAF)) --> App
```

Everything the client can do goes through PostgREST **with the user's JWT**. There's no service-role key in any
request path a user can reach. The service connection is used only by the migrator and the Stripe webhook.

## How Bubble privacy rules map to Postgres

Bubble rules are row *and* field level ("everyone else → can view title and agency only"). RLS is row level only, so
there are three tools:

| Bubble concept | Postgres | Example |
|---|---|---|
| "When Current User's organization is This Thing's organization" | RLS `using (org_id = (select private.current_org_id()))` | every CRM table |
| "Find this in searches" / "Everyone else: nothing" | No policy for that role = no rows. No grant at all for `anon` on tenant tables | `crm_*`, `members`, `subscriptions` |
| Field-level "view only these fields", same for everyone | **Column GRANTs** | `stripe_customer_id` is never granted; `members.role` isn't updatable (only `set_member_role()`) |
| Field-level that depends on the viewer (tier, agency) | **`security_barrier` view** that masks with `CASE` over the caller's entitlements; base table is researcher-only | `report_library.body` / `summary`, `contacts_directory.email` / `phone` |
| "View attached files" | Storage policy calling the same helper | `report_files_select_entitled` → `private.can_read_report_file(name)` |
| "Allow auto-binding" on a field | `UPDATE` grant on that column + an update policy | `organizations.name` for owner/admin, `members.full_name` for self |
| Backend workflow / API Connector only | Separate schemas (`ops`, `migration`, `private`) with no usage grant for API roles | Stripe events, id map |
| Current User's subscription tier | `entitlements` rows derived from tier by a trigger; `private.current_features()` returns them **only while the subscription is in good standing** | a failed payment past the grace period removes access everywhere at once, without touching a policy |

All helpers are `security definer` with `search_path = ''`, read membership without recursing through RLS, and are
called as `(select private.fn())` so Postgres evaluates them once per query instead of once per row (this took
the billing suite from 5.2 s to 0.1 s). Tenant integrity is also enforced by the schema: notes, tasks, deal owners
and linked reports use **composite foreign keys** `(…, org_id) → (id, org_id)`, so a row can't point into another
tenant even if a policy is wrong. The mutation check proves it: weakening the policy alone wasn't enough to move a
deal to another org.

What user-editable data can't influence: `user_metadata`. Org, role and researcher status come from tables only. The attacker
suite sets `user_metadata.org_id`, `role: owner` and `staff_role: researcher` on itself and checks that nothing changes.

## How it's tested

| Suite | What | Count |
|---|---|---|
| **Generated pgTAP matrix** | `scripts/gen-pgtap.ts` reads `privacy-rules.yaml`. For each of the 70 probes (select / insert / update / delete / RPC / masked field / storage object) it asserts allow-or-deny for each of the 10 personas. Each probe runs in a subtransaction that's always rolled back, and only "blocked" error classes (42501, 23503, …) count as deny, so a typo can't pass as a deny | 700 cells (151 allow, 549 deny) |
| Controls | Every probe also runs with RLS bypassed and must succeed, which proves the fixture row exists | 55 |
| Coverage | Policies in the database ⇔ policies declared in the YAML; RLS on every table; every security definer function pins `search_path` | 3 |
| Billing rules (pgTAP) | grace window, tier sync, canceled = no features, last-owner protection | 12 |
| **Mutation check** | 8 deliberate policy bugs (`using (true)`, `with check (true)` + dropped FKs, grace ignored, agency not checked, column over-granted, …) are injected one at a time. The matrix must fail for each | 8/8 caught |
| **Attacker suite** | supabase-js over HTTP against the migrated data: enumerate / read / update / delete / graft into another org's CRM, count leaks, `or=` filter injection, forged and `alg:none` JWTs, metadata spoofing, self-upgrade of tier and entitlements, storage downloads, private schemas, password login for migrated users, public sign-up | 54 |
| Stripe lifecycle | Signed events through the real handler and real database, with access checked *through RLS* at every step | 12 |
| First login, rollback log | magic link email → verifyOtp → session; single use; app writes logged with actor and tenant; replay plan | 6 |
| Unit | transform (ids, option sets, BBCode, files, cross-tenant cleanup), Postmark adapter, signatures, portal link | 24 |
| UI smoke | Every page × persona at 390 px and 1280 px: no console errors or warnings, no failed requests, no horizontal overflow, footer credit present | 64 visits |
| Migration rehearsal | run, re-run (0 changes), validate, tamper with 3 rows, validation **must fail**, re-run heals, re-run (0 changes), validate | in CI |

Run it all locally:

```bash
npm ci
supabase start -x studio,imgproxy,mailpit,logflare,vector,realtime,supavisor,postgres-meta,edge-runtime
npm run gen:tests && supabase test db         # pgTAP via pg_prove
npx tsx scripts/run-pgtap.ts                   # + JSON results + mutation check
bash scripts/ci-migration.sh                   # needs DB_URL=postgresql://postgres:postgres@127.0.0.1:57422/postgres
npx vitest run tests/unit tests/db             # unit + attacker + billing + first login + rollback
npx tsx scripts/export-snapshot.ts && npx tsx scripts/collect-ci-results.ts
npm run build && npm start & node e2e/smoke.mjs
```

The local stack uses ports 574xx so it can run alongside other Supabase projects.

## Migration

See **[MIGRATION.md](MIGRATION.md)** for the runbook. In short:

- **Extract**: Bubble Data API, 100-record pages with cursor/remaining, retries on 429/5xx with `Retry-After`. The mock (`migration/mock-bubble`) generates the same 20,620 records every run (Bubble-style ids like `1698765432123x987654321098765432`, option-set display values, list fields, `//s3.amazonaws.com/appforest_uf/...` file URLs, users with `authentication.email`).
- **Transform**: deterministic UUID v5 per Bubble id (kept in `migration.id_map`), option sets → enums (unknown values fail the run), list fields → join tables, BBCode → Markdown, cross-tenant references nulled and logged.
- **Load**: `INSERT … ON CONFLICT DO UPDATE … WHERE (…) IS DISTINCT FROM (…)` in batches of 500, each batch in its own transaction. A re-run inserts and updates nothing, and stale list items are removed. Files go to Supabase Storage with sha256 tracking.
- **Validate**: re-extracts from Bubble on its own, then checks row counts per type, md5 checksums on key fields and list-field contents, 13 referential integrity checks (including cross-tenant consistency and "no migrated user has a password"), seeded random sample diffs side by side, users without email, Stripe customer ↔ org matching, and idempotency of the last run.
- **Users** arrive without passwords and get a magic link on first login, sent through the Postmark adapter.

Latest local rehearsal: 20,620 records, first run 7.4 s end to end (extract 5.2 s including the mock's deliberate 429s, transform 0.1 s, load 1.1 s, 397 files 1.0 s), re-run 6.1 s with 0 changes. Validation **PASS**.

## Stripe and Postmark

- Tiers come from Stripe price `lookup_key` (`bidmarker_basic_monthly`, `bidmarker_pro_monthly`, `bidmarker_enterprise_annual`). Agency entitlements come from subscription metadata. A trigger keeps `entitlements` in sync with the tier.
- `/api/stripe/webhook` verifies the signature over the raw body (5-minute tolerance), inserts `event.id` into `ops.stripe_events` in the **same transaction** as the change (a redelivery is a no-op), ignores out-of-order subscription events, and sends email only **after commit**.
- `invoice.payment_failed` → `past_due` with `grace_until = first failure + 7 days`. Retries don't extend it. Access continues during grace. After it, `current_features()` returns nothing, so RLS limits reports, contacts and contract search, while the org's own CRM stays readable. `invoice.paid` → `active`, grace cleared, access restored, `access_restored` email.
- Customer portal: `createPortalLink()` (owner/admin) wraps `billingPortal.sessions.create`.
- Tests sign sample events with `stripe.webhooks.generateTestHeaderString`. No Stripe keys needed.
- Email: `EmailSender` interface with `TestSender` (default, records to `ops.email_outbox` with `mode = test`) and `PostmarkSender` (`POST /email`, `outbound` stream, tag per template). Live mode needs `POSTMARK_MODE=live` plus a token, and refuses to run in CI. Templates: welcome, magic link, payment failed, access restored. Tenant-controlled values are HTML-escaped.
- On Vercel (snapshot mode) the webhook still verifies signatures but has no database, so it answers `202 snapshot`.

## Recommended stack

| | Choice | Why |
|---|---|---|
| App hosting | **Vercel** | Next.js server components and route handlers with zero config, preview deploy per PR (each with its own Supabase branch), instant rollback to a previous deployment. Pin functions to the same region as the database (`iad1` next to `us-east-1`) |
| Database / auth / storage | **Supabase** (Postgres) | RLS keeps access rules next to the data, so one set of policies covers the app, the API and any future integration. Postgres can be pen-tested and audited with standard tools. Get PITR, a dedicated pooler and read replicas when reporting grows. For defense customers, consider Supabase's SOC 2 / HIPAA offerings and a US region |
| Edge / DNS | **Cloudflare** | DNS with 60 s TTL makes cutover and rollback a one-record change. WAF and bot rules in front of auth endpoints, rate limiting on `/auth/v1/otp` and the login form, and it absorbs the scraping a contracts database attracts. Proxy Vercel with "Full (strict)" TLS |
| CI | **GitHub Actions** | This repo's pipeline: gitleaks on full history, generated tests checked for drift against the YAML, pgTAP + mutation check, the migration rehearsal and the attacker suite on every PR against a throwaway local Supabase. Required checks on `main` make "RLS still holds" a merge gate. Add Dependabot and CodeQL |
| Monitoring | **Sentry** | Errors and performance per release, with source maps uploaded from CI. Alert on spikes of `42501` (RLS denials: either an attack or a policy that's too tight) and on webhook failures. Scrub PII (emails, contact data) in `beforeSend`, since customers are defense contractors |
| Email | **Postmark** | Separate transactional and broadcast streams, fast delivery for magic links, bounce webhooks |
| Billing | **Stripe** Billing + Customer Portal | Smart Retries and dunning handle the failed-payment emails, and the portal handles card updates without our UI |

### Pen-test readiness checklist
- [x] No tenant table reachable by `anon`; public sign-up disabled; invite / checkout only
- [x] Every policy declared in one spec, generated tests, coverage check both ways, mutation check
- [x] Restricted columns protected by grants or masking views, not by the UI
- [x] Composite tenant FKs; tenant id defaulted server-side
- [x] `security definer` functions pin `search_path`; private helpers live in a schema the API doesn't expose
- [x] Webhooks signed and replay-protected; idempotent on event id
- [x] Secrets only in Vercel / GitHub env; gitleaks in CI on full history
- [x] Security headers (HSTS, nosniff, frame deny, referrer policy), `noindex` on the demo
- [ ] For production: MFA for owners/admins (Supabase MFA + `aal2` in policies for billing / role changes), audit log retention, SSO (SAML) for enterprise tenants, and a scheduled external pen test

## Repo layout

```
privacy-rules.yaml          spec: Bubble rules, entitlements, probes
supabase/migrations/        schema, privacy (RLS/grants/views), migration support, change log
supabase/seed.sql           fixture personas for the pgTAP matrix
supabase/tests/             generated matrix + billing rules (pgTAP)
scripts/                    gen-pgtap, run-pgtap (+ mutations), ci-migration.sh, export-snapshot, collect-ci-results
migration/                  mock-bubble/, bubble-client, transform, load, migrate, validate, replay-to-bubble
lib/                        billing/webhook, email/{sender,templates}, auth/first-login, snapshot + CI loaders
tests/unit, tests/db        vitest suites
app/, components/           Next.js UI
snapshot/                   JSON the Vercel deploy renders (exported from the database as each persona)
e2e/smoke.mjs               Playwright smoke at 390 px and desktop
```

Built with Claude Code. Demo by [DC Tech](https://dctechltd.com).
