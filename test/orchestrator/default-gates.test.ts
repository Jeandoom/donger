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

  it("分支名/参数里的 release 不算发布动作（复盘 P2-9 误拦回归）", () => {
    expect(g.match("Bash", { command: "git fetch origin release-202608-1" })).toBeUndefined();
    expect(
      g.match("Bash", { command: "curl -s https://jihulab.com/api/v4/branches?ref=release-202608-1" }),
    ).toBeUndefined();
    expect(g.match("Bash", { command: "git fetch origin release_v2" })).toBeUndefined();
  });

  it("独立词 release 仍命中 deploy 门", () => {
    expect(g.match("Bash", { command: "./scripts/release 1.2.0" })?.gateId).toBe("deploy");
    expect(g.match("Bash", { command: "release now" })?.gateId).toBe("deploy");
  });

  it("deploy 门元数据已声明", () => {
    expect(g.getGate("deploy")?.description).toBe("部署/发布/推送操作审批");
  });
});
