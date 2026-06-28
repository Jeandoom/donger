import { describe, expect, it } from "vitest";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";

describe("createDefaultGates", () => {
  const g = createDefaultGates();

  it("deploy 命令命中 deploy 门", () => {
    expect(g.match("Bash", { command: "npm run deploy" })?.gateId).toBe("deploy");
  });

  it("publish / release 命中", () => {
    expect(g.match("Bash", { command: "npm publish" })?.gateId).toBe("deploy");
    expect(g.match("Bash", { command: "make release" })?.gateId).toBe("deploy");
  });

  it("git push 命中", () => {
    expect(g.match("Bash", { command: "git push origin main" })?.gateId).toBe("deploy");
  });

  it("安全命令不命中", () => {
    expect(g.match("Bash", { command: "ls -la" })).toBeUndefined();
    expect(g.match("Bash", { command: "npm test" })).toBeUndefined();
    expect(g.match("Bash", { command: "git status" })).toBeUndefined();
  });

  it("deploy 门元数据已声明", () => {
    expect(g.getGate("deploy")?.description).toBe("部署/发布/推送操作审批");
  });
});
