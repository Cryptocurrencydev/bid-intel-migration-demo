// Transactional email templates (rendered locally, sent through the sender adapter).
export type TemplateName = "welcome" | "magic_link" | "payment_failed" | "access_restored";
export type Rendered = { subject: string; html: string; text: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const layout = (body: string) =>
  `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:auto;padding:24px">${body}<p style="color:#64748b;font-size:12px">Bidmarker (demo) · synthetic data</p></body></html>`;
const button = (href: string, label: string) =>
  `<p><a href="${esc(href)}" style="background:#0f3d5e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(label)}</a></p>`;

export function render(name: TemplateName, v: Record<string, string>): Rendered {
  switch (name) {
    case "welcome":
      return {
        subject: `Welcome to Bidmarker, ${v.org_name}`,
        html: layout(`<h1>You're set up</h1><p>${esc(v.org_name)} is on the <b>${esc(v.tier)}</b> plan.</p>${button(v.app_url, "Open Bidmarker")}`),
        text: `${v.org_name} is on the ${v.tier} plan. Open Bidmarker: ${v.app_url}`,
      };
    case "magic_link":
      return {
        subject: "Your Bidmarker sign-in link",
        html: layout(`<h1>Sign in to Bidmarker</h1><p>We've moved to a new platform. Your data came with you; your old password did not. Use this link to sign in, then set a password if you want one.</p>${button(v.action_link, "Sign in")}<p>The link expires in 1 hour and works once.</p>`),
        text: `We've moved to a new platform. Sign in (expires in 1 hour, single use): ${v.action_link}`,
      };
    case "payment_failed":
      return {
        subject: "Payment failed — your Bidmarker access is in a grace period",
        html: layout(`<h1>We couldn't charge your card</h1><p>${esc(v.org_name)} keeps full access until <b>${esc(v.grace_until)}</b>. After that, reports, contacts and contract search are limited until the invoice is paid. Your capture pipeline stays available.</p>${button(v.portal_url, "Update payment method")}`),
        text: `Payment failed for ${v.org_name}. Full access until ${v.grace_until}. Update payment: ${v.portal_url}`,
      };
    case "access_restored":
      return {
        subject: "Payment received — full access restored",
        html: layout(`<h1>Thanks, you're all set</h1><p>${esc(v.org_name)} has full ${esc(v.tier)} access again.</p>${button(v.app_url, "Open Bidmarker")}`),
        text: `Payment received. ${v.org_name} has full ${v.tier} access again: ${v.app_url}`,
      };
  }
}
