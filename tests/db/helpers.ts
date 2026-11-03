import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadLocalEnv } from "../../lib/local-env";

loadLocalEnv();
export const env = {
  db: process.env.DB_URL!,
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  jwtSecret: process.env.SUPABASE_JWT_SECRET!,
};
export const pool = new pg.Pool({ connectionString: env.db, max: 4 });
export const admin = createClient(env.url, env.service, { auth: { persistSession: false, autoRefreshToken: false } });
export const anonClient = () => createClient(env.url, env.anon, { auth: { persistSession: false, autoRefreshToken: false } });

// Real sign-in path for migrated (passwordless) users: admin magic link → verifyOtp.
export async function sessionFor(email: string): Promise<SupabaseClient> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const c = anonClient();
  const v = await c.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "email" });
  if (v.error) throw v.error;
  return c;
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pool.query(sql, params)).rows[0] as T;
}

// Run a query as a given auth user through RLS (same as PostgREST does).
export async function asUser<T = any>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [
      JSON.stringify({ sub: userId, role: userId ? "authenticated" : "anon" }), userId ? "authenticated" : "anon",
    ]);
    const r = await c.query(sql, params);
    await c.query("rollback");
    return r.rows as T[];
  } finally {
    c.release();
  }
}
