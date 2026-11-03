// Stripe lifecycle against the local database with signed sample events (no Stripe keys needed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { handleStripeWebhook, GRACE_DAYS } from "../../lib/billing/webhook";
import { TestSender } from "../../lib/email/sender";
import { asUser, one, pool } from "./helpers";

const secret = "whsec_local_test_secret";
const stripe = new Stripe("sk_test_signing_only");
const email = new TestSender();
const orgId = randomUUID();
const userId = randomUUID();
const reportId = randomUUID();
const customer = `cus_bt_${orgId.slice(0, 8)}`;
const subId = `sub_bt_${orgId.slice(0, 8)}`;
let seq = 0;
let clock = Math.floor(Date.now() / 1000) - 3600;

function signed(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number } = {}) {
  const event = { id: opts.id ?? `evt_bt_${orgId.slice(0, 8)}_${++seq}`, object: "event", api_version: "2026-10-28.endive", created: opts.created ?? ++clock, livemode: false, type, data: { object } };
  const payload = JSON.stringify(event);
  return { payload, sig: stripe.webhooks.generateTestHeaderString({ payload, secret }), id: event.id };
}
const deliver = (e: { payload: string; sig: string }) => handleStripeWebhook(e.payload, e.sig, { secret, db: pool, email });
const subscription = (status: string, lookup = "bidmarker_pro_monthly", agencies = "DCD") => ({
  id: subId, object: "subscription", customer, status, metadata: { agencies },
  items: { object: "list", data: [{ id: "si_1", price: { id: "price_1", lookup_key: lookup }, current_period_end: clock + 30 * 86400 }] },
});
const invoice = (status: string) => ({ id: `in_${seq}`, object: "invoice", customer, status, parent: { subscription_details: { subscription: subId } } });
const bodyVisible = async () => (await asUser(userId, "select body from public.report_library where id = $1", [reportId]))[0]?.body != null;
const contractsVisible = async () => (await asUser(userId, "select count(*)::int as n from public.awarded_contracts"))[0].n > 0;

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', '{}', '{}', now(), now(), '', '', '', '')`,
    [userId, `owner-${orgId.slice(0, 8)}@billing.test`],
  );
  await pool.query("insert into public.organizations (id, name, slug) values ($1, 'Billing Test Org', $2)", [orgId, `bt-${orgId}`]);
  await pool.query("insert into public.members (org_id, user_id, email, full_name, role) values ($1, $2, $3, 'Bill Owner', 'owner')", [orgId, userId, `owner-${orgId.slice(0, 8)}@billing.test`]);
  await pool.query("insert into public.reports (id, title, agency, category, body, tier_required, status, published_at) values ($1, 'Billing test report', 'DCD', 'forecast', 'gated body', 'pro', 'published', now())", [reportId]);
  await pool.query("insert into public.crm_opportunities (org_id, title, agency) values ($1, 'Our own deal', 'DCD')", [orgId]);
});
afterAll(async () => {
  await pool.query("delete from public.organizations where id = $1", [orgId]);
  await pool.query("delete from public.reports where id = $1", [reportId]);
  await pool.query("delete from auth.users where id = $1", [userId]);
  await pool.query("delete from ops.stripe_events where id like $1", [`evt_bt_${orgId.slice(0, 8)}%`]);
  await pool.end();
});

describe("stripe subscription lifecycle → entitlements → RLS", () => {
  it("checkout.session.completed links the Stripe customer and sends a welcome email", async () => {
    const r = await deliver(signed("checkout.session.completed", { id: "cs_1", object: "checkout.session", customer, client_reference_id: orgId, metadata: { tier: "pro" } }));
    expect(r.body.outcome).toBe("customer_linked");
    expect((await one("select stripe_customer_id from public.organizations where id = $1", [orgId])).stripe_customer_id).toBe(customer);
    expect(email.sent.at(-1)).toMatchObject({ template: "welcome", mode: "test" });
  });

  it("customer.subscription.created → pro entitlements → gated report body unlocks", async () => {
    expect(await bodyVisible()).toBe(false);
    const r = await deliver(signed("customer.subscription.created", subscription("active")));
    expect(r.body.outcome).toBe("subscription_active");
    const feats = (await one("select array_agg(feature order by feature) f from public.entitlements where org_id = $1", [orgId])).f;
    expect(feats).toContain("reports.read.pro");
    expect(await bodyVisible()).toBe(true);
    expect(await contractsVisible()).toBe(true);
  });

  it("is idempotent: redelivering the same event id changes nothing", async () => {
    const e = signed("invoice.payment_failed", invoice("open"));
    const first = await deliver(e);
    const sentAfterFirst = email.sent.length;
    const graceAfterFirst = (await one("select grace_until from public.subscriptions where org_id = $1", [orgId])).grace_until;
    const again = await deliver(e);
    expect(first.body.outcome).toBe("past_due_grace");
    expect(again.body.duplicate).toBe(true);
    expect(email.sent.length).toBe(sentAfterFirst);
    expect((await one("select count(*)::int n from ops.stripe_events where id = $1", [e.id])).n).toBe(1);
    expect((await one("select grace_until from public.subscriptions where org_id = $1", [orgId])).grace_until).toEqual(graceAfterFirst);
  });

  it("invoice.payment_failed → past_due with a 7 day grace; access continues; payment_failed email", async () => {
    const s = await one("select status, grace_until from public.subscriptions where org_id = $1", [orgId]);
    expect(s.status).toBe("past_due");
    const days = (new Date(s.grace_until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(GRACE_DAYS - 1.1);
    expect(days).toBeLessThan(GRACE_DAYS + 0.1);
    expect(await bodyVisible()).toBe(true);
    expect(email.sent.some((m) => m.template === "payment_failed")).toBe(true);
  });

  it("Stripe's retry failures do not extend the grace period", async () => {
    const before = (await one("select grace_until from public.subscriptions where org_id = $1", [orgId])).grace_until;
    clock += 3 * 86400;
    await deliver(signed("invoice.payment_failed", invoice("open")));
    expect((await one("select grace_until from public.subscriptions where org_id = $1", [orgId])).grace_until).toEqual(before);
  });

  it("grace expires → access limited by RLS (body masked, contracts hidden), own CRM stays readable", async () => {
    await pool.query("update public.subscriptions set grace_until = now() - interval '1 minute' where org_id = $1", [orgId]); // the clock moves on
    expect(await bodyVisible()).toBe(false);
    expect(await contractsVisible()).toBe(false);
    expect((await asUser(userId, "select count(*)::int n from public.crm_opportunities"))[0].n).toBe(1);
    expect((await asUser(userId, "select (public.my_access() ->> 'good_standing')::boolean as g"))[0].g).toBe(false);
  });

  it("invoice.paid → active, grace cleared, access restored, access_restored email", async () => {
    const r = await deliver(signed("invoice.paid", invoice("paid")));
    expect(r.body.outcome).toBe("access_restored");
    const s = await one("select status, grace_until from public.subscriptions where org_id = $1", [orgId]);
    expect(s).toMatchObject({ status: "active", grace_until: null });
    expect(await bodyVisible()).toBe(true);
    expect(email.sent.at(-1)?.template).toBe("access_restored");
  });

  it("ignores an out-of-order (older) subscription event", async () => {
    const r = await deliver(signed("customer.subscription.updated", subscription("canceled"), { created: clock - 7 * 86400 }));
    expect(r.body.outcome).toBe("stale_ignored");
    expect((await one("select status from public.subscriptions where org_id = $1", [orgId])).status).toBe("active");
  });

  it("downgrade to basic removes pro content and contact emails", async () => {
    await deliver(signed("customer.subscription.updated", subscription("active", "bidmarker_basic_monthly")));
    expect(await bodyVisible()).toBe(false);
    const feats = (await one("select array_agg(feature) f from public.entitlements where org_id = $1", [orgId])).f;
    expect(feats).not.toContain("contacts.full");
  });

  it("customer.subscription.deleted → canceled → no subscriber access", async () => {
    await deliver(signed("customer.subscription.deleted", subscription("canceled")));
    expect((await one("select status from public.subscriptions where org_id = $1", [orgId])).status).toBe("canceled");
    expect(await contractsVisible()).toBe(false);
  });

  it("rejects forged and tampered events before touching the database", async () => {
    const e = signed("invoice.paid", invoice("paid"));
    const forged = await handleStripeWebhook(e.payload, stripe.webhooks.generateTestHeaderString({ payload: e.payload, secret: "whsec_wrong" }), { secret, db: pool, email });
    const tampered = await handleStripeWebhook(e.payload.replace(customer, "cus_victim"), e.sig, { secret, db: pool, email });
    expect(forged.status).toBe(400);
    expect(tampered.status).toBe(400);
    expect((await one("select count(*)::int n from ops.stripe_events where id = $1", [e.id])).n).toBe(0);
  });

  it("logs every email to the outbox in test mode", async () => {
    const n = (await one("select count(*)::int n from ops.email_outbox where to_email like $1 and mode = 'test'", [`owner-${orgId.slice(0, 8)}%`])).n;
    expect(n).toBe(email.sent.length);
  });
});
