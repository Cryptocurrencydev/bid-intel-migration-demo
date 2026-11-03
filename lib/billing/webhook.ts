// Stripe webhook core: verify signature → record event id (idempotency) → apply → email after commit.
// Access is never toggled directly: we only write subscription status / grace_until / tier, and RLS
// derives access from those via private.current_features().
import Stripe from "stripe";
import type { Pool } from "pg";
import type { EmailSender, OutgoingEmail } from "../email/sender";

export const GRACE_DAYS = 7;

export const PRICE_TIERS: Record<string, "basic" | "pro" | "enterprise"> = {
  bidmarker_basic_monthly: "basic",
  bidmarker_pro_monthly: "pro",
  bidmarker_enterprise_annual: "enterprise",
};

const STATUS: Record<string, "trialing" | "active" | "past_due" | "canceled" | "incomplete"> = {
  trialing: "trialing", active: "active", past_due: "past_due", unpaid: "past_due",
  canceled: "canceled", incomplete_expired: "canceled", incomplete: "incomplete", paused: "canceled",
};

export type WebhookDeps = {
  secret: string;
  db: Pool | null; // null in snapshot mode (Vercel): verify, acknowledge, do not write
  email: EmailSender;
  appUrl?: string;
  toleranceSeconds?: number;
};
export type WebhookResult = { status: number; body: Record<string, unknown> };

const stripe = new Stripe("sk_test_signature_verification_only");

export function tierFromSubscription(sub: Stripe.Subscription): "basic" | "pro" | "enterprise" {
  const item = sub.items?.data?.[0];
  const key = item?.price?.lookup_key ?? sub.metadata?.tier;
  const tier = key ? PRICE_TIERS[key] ?? (["basic", "pro", "enterprise"].includes(key) ? (key as any) : undefined) : undefined;
  if (!tier) throw new Error(`unknown price lookup_key ${key}`);
  return tier;
}

function periodEnd(sub: any): Date | null {
  const s = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return s ? new Date(s * 1000) : null;
}

function invoiceSubscriptionId(inv: any): string | null {
  const s = inv.parent?.subscription_details?.subscription ?? inv.subscription;
  return typeof s === "string" ? s : s?.id ?? null;
}

export async function handleStripeWebhook(rawBody: string, signature: string | null, deps: WebhookDeps): Promise<WebhookResult> {
  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("missing Stripe-Signature header");
    event = stripe.webhooks.constructEvent(rawBody, signature, deps.secret, deps.toleranceSeconds ?? 300);
  } catch (e) {
    return { status: 400, body: { error: "invalid signature", detail: (e as Error).message } };
  }
  if (!deps.db) return { status: 202, body: { received: true, id: event.id, snapshot: true, note: "snapshot mode: verified, not applied" } };

  const client = await deps.db.connect();
  const emails: OutgoingEmail[] = [];
  let outcome = "ignored";
  try {
    await client.query("begin");
    const fresh = await client.query(
      `insert into ops.stripe_events (id, type, stripe_created_at, outcome, payload) values ($1, $2, to_timestamp($3), 'processing', $4)
       on conflict (id) do nothing returning id`,
      [event.id, event.type, event.created, event],
    );
    if (fresh.rowCount === 0) {
      await client.query("rollback");
      return { status: 200, body: { received: true, id: event.id, duplicate: true } };
    }
    const at = new Date(event.created * 1000);
    const app = deps.appUrl ?? "http://127.0.0.1:3400";

    const orgByCustomer = async (customer: unknown) => {
      const id = typeof customer === "string" ? customer : (customer as { id?: string })?.id;
      const r = await client.query("select id, name from public.organizations where stripe_customer_id = $1", [id]);
      return r.rows[0] as { id: string; name: string } | undefined;
    };
    const managers = async (orgId: string) =>
      (await client.query("select email from public.members where org_id = $1 and role in ('owner','admin') and email is not null", [orgId])).rows.map((r) => r.email as string);

    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const r = await client.query(
          "update public.organizations set stripe_customer_id = $2 where id = $1 and (stripe_customer_id is null or stripe_customer_id = $2) returning id, name",
          [s.client_reference_id, s.customer],
        );
        if (!r.rowCount) { outcome = "customer_conflict"; break; }
        outcome = "customer_linked";
        for (const to of await managers(r.rows[0].id)) emails.push({ template: "welcome", to, vars: { org_name: r.rows[0].name, tier: String(s.metadata?.tier ?? "new"), app_url: app } });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const org = await orgByCustomer(sub.customer);
        if (!org) { outcome = "unknown_customer"; break; }
        const cur = (await client.query("select id, last_stripe_event_at, grace_until from public.subscriptions where org_id = $1 for update", [org.id])).rows[0];
        if (cur?.last_stripe_event_at && cur.last_stripe_event_at > at) { outcome = "stale_ignored"; break; }
        const status = event.type === "customer.subscription.deleted" ? "canceled" : STATUS[sub.status] ?? "incomplete";
        const grace = status === "past_due" ? cur?.grace_until ?? new Date(at.getTime() + GRACE_DAYS * 86_400_000) : null;
        const res = await client.query(
          `insert into public.subscriptions (org_id, tier, status, stripe_subscription_id, current_period_end, grace_until, last_stripe_event_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (org_id) do update set tier = excluded.tier, status = excluded.status, stripe_subscription_id = excluded.stripe_subscription_id,
             current_period_end = excluded.current_period_end, grace_until = excluded.grace_until, last_stripe_event_at = excluded.last_stripe_event_at
           returning id`,
          [org.id, tierFromSubscription(sub), status, sub.id, periodEnd(sub), grace, at],
        );
        const agencies = String(sub.metadata?.agencies ?? "").split(",").map((a) => a.trim()).filter(Boolean);
        if (sub.metadata?.agencies !== undefined) {
          await client.query("delete from public.subscription_agencies where subscription_id = $1", [res.rows[0].id]);
          await client.query("insert into public.subscription_agencies (subscription_id, agency) select $1, unnest($2::public.agency_code[]) on conflict do nothing", [res.rows[0].id, agencies]);
        }
        outcome = `subscription_${status}`;
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const org = await orgByCustomer(inv.customer);
        if (!org) { outcome = "unknown_customer"; break; }
        // grace starts at the FIRST failure; Stripe's retries must not extend it
        const r = await client.query(
          `update public.subscriptions set status = 'past_due', grace_until = coalesce(grace_until, $2), last_stripe_event_at = greatest(last_stripe_event_at, $3)
           where org_id = $1 and ($4::text is null or stripe_subscription_id = $4) returning grace_until`,
          [org.id, new Date(at.getTime() + GRACE_DAYS * 86_400_000), at, invoiceSubscriptionId(inv)],
        );
        if (!r.rowCount) { outcome = "unknown_subscription"; break; }
        outcome = "past_due_grace";
        const portal = `${app}/billing/portal`;
        for (const to of await managers(org.id)) emails.push({ template: "payment_failed", to, vars: { org_name: org.name, grace_until: r.rows[0].grace_until.toISOString().slice(0, 10), portal_url: portal } });
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        const org = await orgByCustomer(inv.customer);
        if (!org) { outcome = "unknown_customer"; break; }
        const prev = (await client.query("select status, tier from public.subscriptions where org_id = $1 for update", [org.id])).rows[0];
        if (!prev) { outcome = "unknown_subscription"; break; }
        await client.query(
          "update public.subscriptions set status = 'active', grace_until = null, last_stripe_event_at = greatest(last_stripe_event_at, $2) where org_id = $1",
          [org.id, at],
        );
        outcome = prev.status === "active" ? "paid" : "access_restored";
        if (prev.status !== "active")
          for (const to of await managers(org.id)) emails.push({ template: "access_restored", to, vars: { org_name: org.name, tier: prev.tier, app_url: app } });
        break;
      }
      default:
        outcome = "ignored";
    }
    await client.query("update ops.stripe_events set outcome = $2 where id = $1", [event.id, outcome]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    // not recorded → Stripe retries the delivery
    return { status: 500, body: { error: (e as Error).message } };
  } finally {
    client.release();
  }

  // after commit: send + log (a failed send never rolls back billing state)
  for (const m of emails) {
    try {
      const sent = await deps.email.send(m);
      await deps.db.query(
        "insert into ops.email_outbox (template, to_email, subject, mode, provider_message_id, payload) values ($1, $2, $3, $4, $5, $6)",
        [m.template, m.to, sent.subject, sent.mode, sent.messageId, { event: event.id, vars: m.vars }],
      );
    } catch (e) {
      console.error(`email ${m.template} → ${m.to} failed: ${(e as Error).message}`);
    }
  }
  return { status: 200, body: { received: true, id: event.id, outcome, emails: emails.length } };
}

// Customer portal link for owners/admins (Stripe-hosted billing management).
export type PortalClient = { billingPortal: { sessions: { create(p: { customer: string; return_url: string }): Promise<{ url: string }> } } };
export async function createPortalLink(stripeClient: PortalClient, customerId: string | null, returnUrl: string): Promise<string> {
  if (!customerId) throw new Error("organization has no Stripe customer");
  const s = await stripeClient.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return s.url;
}
