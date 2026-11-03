// Sender adapter. Test mode (default) never talks to Postmark; live mode needs an explicit opt-in.
import { render, type TemplateName } from "./templates";

export type OutgoingEmail = { template: TemplateName; to: string; vars: Record<string, string>; tag?: string };
export type SentEmail = OutgoingEmail & { subject: string; html: string; text: string; mode: "test" | "live"; messageId: string };

export interface EmailSender {
  readonly mode: "test" | "live";
  send(email: OutgoingEmail): Promise<SentEmail>;
}

export class TestSender implements EmailSender {
  readonly mode = "test" as const;
  readonly sent: SentEmail[] = [];
  async send(email: OutgoingEmail): Promise<SentEmail> {
    const r = render(email.template, email.vars);
    const out = { ...email, ...r, mode: this.mode, messageId: `test-${this.sent.length + 1}` };
    this.sent.push(out);
    return out;
  }
}

export class PostmarkSender implements EmailSender {
  readonly mode = "live" as const;
  constructor(
    private token: string,
    private from: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(email: OutgoingEmail): Promise<SentEmail> {
    const r = render(email.template, email.vars);
    const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": this.token },
      body: JSON.stringify({ From: this.from, To: email.to, Subject: r.subject, HtmlBody: r.html, TextBody: r.text, MessageStream: "outbound", Tag: email.tag ?? email.template }),
    });
    const body = (await res.json()) as { ErrorCode: number; Message: string; MessageID?: string };
    if (!res.ok || body.ErrorCode !== 0) throw new Error(`postmark ${res.status} ErrorCode=${body.ErrorCode}: ${body.Message}`);
    return { ...email, ...r, mode: this.mode, messageId: body.MessageID! };
  }
}

export function createSender(env: Record<string, string | undefined> = process.env): EmailSender {
  if (env.POSTMARK_MODE !== "live") return new TestSender();
  if (!env.POSTMARK_SERVER_TOKEN || !env.POSTMARK_FROM) throw new Error("POSTMARK_MODE=live needs POSTMARK_SERVER_TOKEN and POSTMARK_FROM");
  if (env.CI) throw new Error("refusing live email sends in CI");
  return new PostmarkSender(env.POSTMARK_SERVER_TOKEN, env.POSTMARK_FROM);
}
