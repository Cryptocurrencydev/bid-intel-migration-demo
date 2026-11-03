// Migrated users have no password: first login is a magic link sent through the Postmark adapter.
import { afterAll, describe, expect, it } from "vitest";
import { sendFirstLoginLink } from "../../lib/auth/first-login";
import { TestSender } from "../../lib/email/sender";
import { DEMO } from "../../migration/mock-bubble/generate";
import { admin, anonClient, one, pool } from "./helpers";

afterAll(() => pool.end());

describe("first login after migration", () => {
  it("migrated users exist in auth without a password", async () => {
    const u = await one("select encrypted_password, raw_user_meta_data from auth.users where email = $1", [DEMO.emails.member]);
    expect(u.encrypted_password).toBe("");
    expect(u.raw_user_meta_data.migrated_from).toBe("bubble");
  });

  it("sends a magic link email (test mode) that signs the user in", async () => {
    const sender = new TestSender();
    const r = await sendFirstLoginLink(admin, sender, DEMO.emails.member, "http://127.0.0.1:3400/welcome");
    expect(r.sent).toBe(true);
    const mail = sender.sent[0];
    expect(mail).toMatchObject({ template: "magic_link", to: DEMO.emails.member, mode: "test" });
    const link = new URL(mail.vars.action_link);
    const token = link.searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(20);

    const c = anonClient();
    const v = await c.auth.verifyOtp({ token_hash: token, type: "email" });
    expect(v.error).toBeNull();
    const access = (await c.rpc("my_access")).data as any;
    expect(access.org_name).toBe("Halberd Systems");
    expect(access.role).toBe("member");
  });

  it("the link is single use", async () => {
    const sender = new TestSender();
    await sendFirstLoginLink(admin, sender, DEMO.emails.member, "http://127.0.0.1:3400/welcome");
    const token = new URL(sender.sent[0].vars.action_link).searchParams.get("token")!;
    expect((await anonClient().auth.verifyOtp({ token_hash: token, type: "email" })).error).toBeNull();
    expect((await anonClient().auth.verifyOtp({ token_hash: token, type: "email" })).error).not.toBeNull();
  });

  it("users without an email were not given a login at all", async () => {
    const n = (await one("select count(*)::int n from public.members where bubble_id is not null and email is null and user_id is not null")).n;
    expect(n).toBe(0);
  });
});
