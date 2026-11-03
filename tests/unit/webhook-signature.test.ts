import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createPortalLink, handleStripeWebhook, tierFromSubscription } from "../../lib/billing/webhook";
import { TestSender } from "../../lib/email/sender";

const secret = "whsec_test_unit_only";
const stripe = new Stripe("sk_test_unit");
const payload = JSON.stringify({ id: "evt_unit_1", object: "event", type: "invoice.paid", created: Math.floor(Date.now() / 1000), data: { object: { id: "in_1", customer: "cus_x" } } });

describe("webhook signature verification (snapshot mode, no db)", () => {
  it("accepts a correctly signed event", async () => {
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const r = await handleStripeWebhook(payload, sig, { secret, db: null, email: new TestSender() });
    expect(r.status).toBe(202);
    expect(r.body.snapshot).toBe(true);
  });
  it("rejects a missing signature", async () => {
    expect((await handleStripeWebhook(payload, null, { secret, db: null, email: new TestSender() })).status).toBe(400);
  });
  it("rejects a signature made with another secret", async () => {
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_attacker" });
    expect((await handleStripeWebhook(payload, sig, { secret, db: null, email: new TestSender() })).status).toBe(400);
  });
  it("rejects a tampered body", async () => {
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect((await handleStripeWebhook(payload.replace("cus_x", "cus_y"), sig, { secret, db: null, email: new TestSender() })).status).toBe(400);
  });
  it("rejects a replay outside the 5 minute tolerance", async () => {
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect((await handleStripeWebhook(payload, sig, { secret, db: null, email: new TestSender() })).status).toBe(400);
  });
});

describe("plans", () => {
  it("maps price lookup keys to tiers", () => {
    expect(tierFromSubscription({ items: { data: [{ price: { lookup_key: "bidmarker_pro_monthly" } }] } } as any)).toBe("pro");
    expect(() => tierFromSubscription({ items: { data: [{ price: { lookup_key: "mystery" } }] }, metadata: {} } as any)).toThrow();
  });
  it("creates a customer portal link (Stripe client stubbed, no keys)", async () => {
    const calls: unknown[] = [];
    const client = { billingPortal: { sessions: { create: async (p: any) => (calls.push(p), { url: "https://billing.stripe.com/p/session/test_123" }) } } };
    expect(await createPortalLink(client, "cus_1", "https://app/billing")).toMatch(/^https:\/\/billing\.stripe\.com/);
    expect(calls[0]).toEqual({ customer: "cus_1", return_url: "https://app/billing" });
    await expect(createPortalLink(client, null, "x")).rejects.toThrow(/no Stripe customer/);
  });
});
