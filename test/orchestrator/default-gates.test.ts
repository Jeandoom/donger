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
      g.match("Bash", {
        command: "curl -s https://jihulab.com/api/v4/branches?ref=release-202608-1",
      }),
    ).toBeUndefined();
    expect(g.match("Bash", { command: "git fetch origin release_v2" })).toBeUndefined();
  });

  it("路径中的 .deploy 不算发布动作（2026-09-21 财物管家卡死复盘：照抄附件绝对路径被误拦）", () => {
    expect(
      g.match("Bash", {
        command:
          'cd "D:\\code\\donger\\.deploy\\donger\\data\\workspace\\users\\u1\\agents\\a1\\workspace" && python -c "import openpyxl; print(openpyxl.__version__)"',
      }),
    ).toBeUndefined();
    expect(
      g.match("Bash", {
        command:
          "python -c \"p = r'D:\\code\\donger\\.deploy\\donger\\data\\账单.xlsx'; print(p)\"",
      }),
    ).toBeUndefined();
    expect(g.match("Bash", { command: "ls .deploy/donger/data" })).toBeUndefined();
    expect(g.match("Bash", { command: "cat /srv/app/.deploy/config.json" })).toBeUndefined();
  });

  it("生产部署目录 D:\\deploy 的路径段不算发布动作（2026-09-30 目录迁移，豁免前置 \\ 与盘符:）", () => {
    expect(
      g.match("Bash", {
        command:
          'cd "D:\\deploy\\donger\\data\\workspace\\users\\u1\\agents\\a1\\workspace" && python -c "import openpyxl; print(openpyxl.__version__)"',
      }),
    ).toBeUndefined();
    expect(
      g.match("Bash", {
        command: "python -c \"p = r'D:\\deploy\\donger\\data\\账单.xlsx'; print(p)\"",
      }),
    ).toBeUndefined();
    expect(
      g.match("Bash", { command: "cat D:\\deploy\\donger\\logs\\runner-x.out.log" }),
    ).toBeUndefined();
    expect(g.match("Bash", { command: "cat D:\\deploy\\donger\\data\\donger.db" })).toBeUndefined();
    // D:/deploy 正斜杠形态仍命中：前置 / 的豁免会连带放过 ./deploy.sh 真部署脚本，
    // 取舍上保持拦截（fail-safe），git-bash 风格路径偶发审批可接受
    expect(g.match("Bash", { command: "ls D:/deploy/donger/data" })?.gateId).toBe("deploy");
  });

  it("./deploy.sh 等真部署脚本仍命中（前置 / 不受 dot 排除影响）", () => {
    expect(g.match("Bash", { command: "./deploy.sh --env prod" })?.gateId).toBe("deploy");
    expect(g.match("Bash", { command: "bash deploy.sh" })?.gateId).toBe("deploy");
  });

  it("独立词 release 仍命中 deploy 门", () => {
    expect(g.match("Bash", { command: "./scripts/release 1.2.0" })?.gateId).toBe("deploy");
    expect(g.match("Bash", { command: "release now" })?.gateId).toBe("deploy");
  });

  it("deploy 门元数据已声明", () => {
    expect(g.getGate("deploy")?.description).toBe("部署/发布/推送操作审批");
  });
});
