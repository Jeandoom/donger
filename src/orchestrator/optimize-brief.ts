import type { Agent } from "../domain/agent.js";
import type { Comment } from "../domain/comment.js";
import type { AuditEvent, Task } from "../domain/types.js";

export interface OptimizeBriefInput {
  task: Task;
  events: AuditEvent[];
  comments: Comment[];
  agent?: Agent;
  agentSkillsDir?: string;
  agentKbDir?: string;
}

/**
 * 聚合任务执行数据为 task-optimize 的触发材料（纯函数，T17.4）。
 * 审计事件只保留观测相关字段并截断长文本，控制 prompt 体积。
 */
export function buildOptimizeBrief(input: OptimizeBriefInput): string {
  const { task, events, comments, agent } = input;
  const lines: string[] = [];
  lines.push(`请对任务 ${task.id} 做优化分析（task-optimize）。`);
  lines.push(`任务内容：${task.prompt}`);
  lines.push(`任务状态：${task.status}${task.phase ? ` / 阶段 ${task.phase}` : ""}`);
  if (agent) {
    lines.push(`执行智能体：${agent.name}（${agent.id}）`);
    lines.push(`skills 清单：${agent.skills.join("、") || "无"}`);
    if (input.agentSkillsDir) lines.push(`skills 文件目录：${input.agentSkillsDir}`);
    if (input.agentKbDir) lines.push(`知识库目录：${input.agentKbDir}`);
  }

  lines.push("", "## 审计事件摘要");
  if (events.length === 0) {
    lines.push("（无审计事件）");
  } else {
    const byType = new Map<string, number>();
    for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    lines.push(
      `事件统计：${[...byType.entries()].map(([t, n]) => `${t}×${n}`).join("、")}（共 ${events.length} 条）`,
    );
    for (const e of events) {
      if (e.type === "tool_use") {
        lines.push(`- [tool_use] ${e.toolName ?? "?"}：${clip(e.toolInput)}`);
      } else if (e.type === "tool_result" && e.isError) {
        lines.push(`- [tool_result 失败] ${e.toolName ?? "?"}：${clip(e.toolOutput)}`);
      } else if (e.type === "result") {
        lines.push(
          `- [result ${e.resultSubtype ?? ""}] tokens=${sumTokens(e.usage)} 耗时=${e.durationMs ?? "?"}ms${e.isError ? " 异常" : ""}`,
        );
      } else if (e.type === "user_message") {
        lines.push(`- [用户] ${clip(e.text)}`);
      }
    }
  }

  lines.push("", "## 用户评论");
  if (comments.length === 0) {
    lines.push("（无评论）");
  } else {
    for (const c of comments) lines.push(`- [${c.createdAt.slice(0, 16)}] ${c.text}`);
  }

  lines.push("", "请按 task-optimize 技能的步骤产出修订提案（diff 形式），经我确认后再落盘。");
  return lines.join("\n");
}

function clip(text: string | undefined, max = 120): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function sumTokens(usage: AuditEvent["usage"]): number {
  if (!usage) return 0;
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}
