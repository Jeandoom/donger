import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendDispatcherAgentRow } from "../../src/domain/dispatcher-registry.js";
import { ensureDispatcherKb } from "../../src/orchestrator/dispatch-kb.js";

const ROW = {
  agentId: "a2bf3c71-0000",
  name: "jihulab",
  duty: "GitLab 仓库查询",
  skills: ["gitlab-execute"],
  taskTypes: "代码查询",
};

/** 用 seed 出的真实登记表做基准 markdown */
function seedMarkdown(): string {
  const dir = mkdtempSync(join(tmpdir(), "donger-registry-"));
  ensureDispatcherKb(dir);
  return readFileSync(join(dir, "dispatcher", "agents.md"), "utf8");
}

describe("appendDispatcherAgentRow", () => {
  it("追加到表尾数据行之后，保持表格连续（无空行插入）", () => {
    const out = appendDispatcherAgentRow(seedMarkdown(), ROW);
    const lines = out.split("\n");
    const idx = lines.findIndex((l) => l.includes(`| ${ROW.agentId} |`));
    expect(idx).toBeGreaterThan(0);
    // 前一行仍是表格行（中间无空行）
    expect(lines[idx - 1]?.trimStart().startsWith("|")).toBe(true);
    // 表后注释仍在新行之后
    const commentIdx = lines.findIndex((l) => l.startsWith("<!--"));
    expect(commentIdx).toBeGreaterThan(idx);
    expect(out).toContain(
      "| a2bf3c71-0000 | jihulab | GitLab 仓库查询 | gitlab-execute | 代码查询 | 无 |",
    );
  });

  it("重复 agentId 报错（幂等保护）", () => {
    const once = appendDispatcherAgentRow(seedMarkdown(), ROW);
    expect(() => appendDispatcherAgentRow(once, ROW)).toThrow("已登记");
  });

  it("无表格分隔行报错", () => {
    expect(() => appendDispatcherAgentRow("# 无表格\n正文", ROW)).toThrow("格式不符");
  });
});
