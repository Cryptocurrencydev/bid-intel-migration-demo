// Migrated users have no password. On first login we mint a magic link with the admin API and send
// it through our own Postmark adapter (branded, logged), instead of GoTrue's built-in mailer.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailSender } from "../email/sender";

export async function sendFirstLoginLink(admin: SupabaseClient, sender: EmailSender, email: string, redirectTo: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
  // same response whether or not the address exists: no account enumeration from the login form
  if (error || !data?.properties?.action_link) return { sent: false as const };
  const sent = await sender.send({ template: "magic_link", to: email, vars: { action_link: data.properties.action_link } });
  return { sent: true as const, messageId: sent.messageId };
}
