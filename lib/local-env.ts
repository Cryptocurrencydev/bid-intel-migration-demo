// Fills DB / API env from `supabase status` when not already set (local dev). CI sets them explicitly.
import { execFileSync } from "node:child_process";

export function loadLocalEnv(): void {
  if (process.env.DB_URL && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY) return;
  const out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const s = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  process.env.DB_URL ??= s.DB_URL;
  process.env.SUPABASE_URL ??= s.API_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= s.SERVICE_ROLE_KEY;
  process.env.SUPABASE_ANON_KEY ??= s.ANON_KEY;
  process.env.SUPABASE_JWT_SECRET ??= s.JWT_SECRET;
}
