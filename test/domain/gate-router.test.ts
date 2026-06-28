import { describe, expect, it } from "vitest";
import { GateRouter } from "../../src/domain/gate-router.js";

describe("GateRouter", () => {
  it("按工具名 + 命令正则命中门", () => {
    const g = new GateRouter();
    g.describe({ id: "deploy", description: "部署审批" });
    g.add({ gateId: "deploy", toolName: "Bash", commandPattern: /deploy|publish|release/i });
    expect(g.match("Bash", { command: "npm run deploy" })?.gateId).toBe("deploy");
    expect(g.match("Bash", { command: "ls -la" })).toBeUndefined();
  });

  it("commandPattern 缺省 → 该工具任何调用都命中", () => {
    const g = new GateRouter();
    g.add({ gateId: "any-bash", toolName: "Bash" });
    expect(g.match("Bash", { command: "anything" })?.gateId).toBe("any-bash");
    expect(g.match("Bash", {})?.gateId).toBe("any-bash");
    expect(g.match("Read", { path: "/x" })).toBeUndefined();
  });

  it("有 commandPattern 但无 input.command → 不命中该规则", () => {
    const g = new GateRouter();
    g.add({ gateId: "deploy", toolName: "Bash", commandPattern: /deploy/ });
    expect(g.match("Bash", {})).toBeUndefined();
  });

  it("首条匹配规则胜出（按 add 顺序）", () => {
    const g = new GateRouter();
    g.add({ gateId: "deploy", toolName: "Bash", commandPattern: /deploy/ });
    g.add({ gateId: "any-bash", toolName: "Bash" });
    expect(g.match("Bash", { command: "npm run deploy" })?.gateId).toBe("deploy");
    expect(g.match("Bash", { command: "ls" })?.gateId).toBe("any-bash");
  });

  it("getGate 取门元数据", () => {
    const g = new GateRouter();
    g.describe({ id: "design", description: "方案审批" });
    expect(g.getGate("design")?.description).toBe("方案审批");
    expect(g.getGate("nope")).toBeUndefined();
  });
});
