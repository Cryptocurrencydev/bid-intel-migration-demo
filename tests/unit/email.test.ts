import { describe, expect, it, vi } from "vitest";
import { createSender, PostmarkSender, TestSender } from "../../lib/email/sender";
import { render } from "../../lib/email/templates";

describe("templates", () => {
  it("renders all four transactional emails", () => {
    const vars = { org_name: "Halberd", tier: "pro", app_url: "https://x", action_link: "https://x/verify", grace_until: "2026-11-11", portal_url: "https://x/p" };
    for (const t of ["welcome", "magic_link", "payment_failed", "access_restored"] as const) {
      const r = render(t, vars);
      expect(r.subject.length).toBeGreaterThan(5);
      expect(r.text.length).toBeGreaterThan(10);
      expect(r.html).toContain("<html>");
    }
  });
  it("escapes tenant-controlled values", () => {
    const r = render("welcome", { org_name: '<img src=x onerror="alert(1)">', tier: "pro", app_url: "https://x" });
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;img");
  });
});

describe("sender adapter", () => {
  it("defaults to test mode and never calls the network", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const s = createSender({});
    expect(s.mode).toBe("test");
    await s.send({ template: "magic_link", to: "a@b.example", vars: { action_link: "https://x" } });
    expect((s as TestSender).sent).toHaveLength(1);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
  it("refuses live mode without credentials or in CI", () => {
    expect(() => createSender({ POSTMARK_MODE: "live" })).toThrow(/POSTMARK_SERVER_TOKEN/);
    expect(() => createSender({ POSTMARK_MODE: "live", POSTMARK_SERVER_TOKEN: "t", POSTMARK_FROM: "f@x", CI: "true" })).toThrow(/CI/);
  });
  it("builds the Postmark /email request (fetch stubbed)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "pm-1" }), { status: 200 }));
    const s = new PostmarkSender("server-token", "noreply@bidmarker.example", fetchImpl as unknown as typeof fetch);
    const sent = await s.send({ template: "payment_failed", to: "o@x.example", vars: { org_name: "H", grace_until: "2026-11-11", portal_url: "https://p" } });
    expect(sent.messageId).toBe("pm-1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect((init.headers as Record<string, string>)["x-postmark-server-token"]).toBe("server-token");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ To: "o@x.example", MessageStream: "outbound", Tag: "payment_failed" });
  });
  it("surfaces Postmark API errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 406, Message: "Inactive recipient" }), { status: 422 }));
    const s = new PostmarkSender("t", "f@x", fetchImpl as unknown as typeof fetch);
    await expect(s.send({ template: "welcome", to: "x@y", vars: { org_name: "a", tier: "b", app_url: "c" } })).rejects.toThrow(/406/);
  });
});
