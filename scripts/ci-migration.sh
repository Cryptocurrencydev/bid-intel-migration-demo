#!/usr/bin/env bash
# Full migration rehearsal against local Supabase: run twice (idempotency), validate, inject drift,
# prove validation catches it, re-run to heal, validate again.
set -euo pipefail
npx tsx migration/mock-bubble/server.ts > artifacts/mock-bubble.log 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8787/appforest_uf/ready.png >/dev/null && break; sleep 0.5; done

echo "::group::migration run 1 (fresh load)";  npx tsx migration/migrate.ts; echo "::endgroup::"
echo "::group::migration run 2 (re-run, must change nothing)"; npx tsx migration/migrate.ts; echo "::endgroup::"
echo "::group::validation"; npx tsx migration/validate.ts; echo "::endgroup::"

echo "::group::drift: tamper with Supabase, validation must fail"
psql "$DB_URL" -X -q -c "update public.crm_notes set body = body || ' (edited by hand)' where bubble_id = (select min(bubble_id) from public.crm_notes); delete from public.crm_tasks where bubble_id = (select min(bubble_id) from public.crm_tasks); update public.subscription_agencies set agency = 'FEMR' where (subscription_id, agency) = (select sa.subscription_id, sa.agency from public.subscription_agencies sa join public.subscriptions s on s.id = sa.subscription_id where s.bubble_id is not null and not exists (select 1 from public.subscription_agencies x where x.subscription_id = sa.subscription_id and x.agency = 'FEMR') order by 1, 2 limit 1);"
cp artifacts/validation-report.json artifacts/validation-report.clean.json
if npx tsx migration/validate.ts > artifacts/validation-drift.txt 2>&1; then echo "validation did NOT catch drift"; exit 1; fi
grep -E "❌" artifacts/validation-drift.txt | head -20
cp artifacts/validation-report.json artifacts/validation-report.drift.json
echo "::endgroup::"

echo "::group::migration run 3 (heals drift)"; npx tsx migration/migrate.ts; echo "::endgroup::"
echo "::group::migration run 4 (re-run, must change nothing)"; npx tsx migration/migrate.ts; echo "::endgroup::"
echo "::group::final validation"; npx tsx migration/validate.ts; echo "::endgroup::"
