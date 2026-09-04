import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDispatcherKb } from "../../src/orchestrator/dispatch-kb.js";

describe("ensureDispatcherKb", () => {
  it("创建 agents.md 与 routing-rules.md，且重复调用不覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "donger-kb-"));
    ensureDispatcherKb(dir);
    const agents = join(dir, "dispatcher", "agents.md");
    const rules = join(dir, "dispatcher", "routing-rules.md");
    expect(readFileSync(agents, "utf8")).toContain("执行智能体登记表");
    expect(readFileSync(rules, "utf8")).toContain("路由规则");
    // 幂等：改内容后再调，不被覆盖
    writeFileSync(agents, "手工修改", "utf8");
    ensureDispatcherKb(dir);
    expect(readFileSync(agents, "utf8")).toBe("手工修改");
  });
});
