// Writes made in the new system after cutover are captured in ops.change_log so a rollback can
// replay them to Bubble. Net effect of this test on the data is zero.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DEMO } from "../../migration/mock-bubble/generate";
import { one, pool, sessionFor } from "./helpers";

afterAll(() => pool.end());

describe("rollback replay log", () => {
  it("captures app writes with actor and tenant, and plans Bubble API calls", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const owner = await sessionFor(DEMO.emails.owner);
    const opp = (await owner.from("crm_opportunities").select("id,stage").order("created_at").limit(1)).data![0];
    const other = opp.stage === "proposal" ? "submitted" : "proposal";
    expect((await owner.from("crm_opportunities").update({ stage: other }).eq("id", opp.id).select()).data).toHaveLength(1);
    expect((await owner.from("crm_opportunities").update({ stage: opp.stage }).eq("id", opp.id).select()).data).toHaveLength(1);
    const task = (await owner.from("crm_tasks").insert({ opportunity_id: opp.id, title: "post-cutover task" }).select("id").single()).data!;
    await owner.from("crm_tasks").delete().eq("id", task.id);

    const log = (await pool.query("select table_name, op, actor, org_id from ops.change_log where at >= $1 order by id", [since])).rows;
    expect(log.map((l) => `${l.table_name}:${l.op}`)).toEqual(["crm_opportunities:UPDATE", "crm_opportunities:UPDATE", "crm_tasks:INSERT", "crm_tasks:DELETE"]);
    const ownerUser = (await one("select user_id from public.members where email = $1", [DEMO.emails.owner])).user_id;
    expect(log.every((l) => l.actor === ownerUser)).toBe(true);

    execFileSync("npx", ["tsx", "migration/replay-to-bubble.ts", "--since", since], { stdio: "ignore" });
    const plan = JSON.parse(readFileSync("artifacts/replay-plan.json", "utf8"));
    expect(plan.calls.find((c: any) => c.method === "PATCH")?.path).toMatch(/^\/obj\/opportunity\/\d{13}x\d{18}$/);
    expect(plan.calls.find((c: any) => c.method === "SKIP")?.reason).toMatch(/created and deleted/);
  });

  it("the migrator's own writes are not logged (no JWT)", async () => {
    const n = (await one("select count(*)::int n from ops.change_log where actor is null")).n;
    expect(n).toBe(0);
  });
});
