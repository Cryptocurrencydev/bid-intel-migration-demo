// Stripe webhook endpoint. Locally / in CI it runs against Postgres (DATABASE_URL). On the Vercel
// snapshot deploy there is no database: signatures are still verified, events are acknowledged
// with 202 and not applied.
import { handleStripeWebhook } from "@/lib/billing/webhook";
import { createSender } from "@/lib/email/sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let pool: import("pg").Pool | null | undefined;
async function db() {
  if (pool !== undefined) return pool;
  if (!process.env.DATABASE_URL) return (pool = null);
  const pg = await import("pg");
  return (pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 3 }));
}

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "webhook not configured (STRIPE_WEBHOOK_SECRET unset)" }, { status: 503 });
  const raw = await req.text(); // raw body: signature is over the exact bytes
  const r = await handleStripeWebhook(raw, req.headers.get("stripe-signature"), { secret, db: await db(), email: createSender() });
  return Response.json(r.body, { status: r.status });
}
