import { z } from "zod";

/** dispatcher 的结构化路由决策（spec §4.3） */
export const RoutingDecisionSchema = z.object({
  agentId: z.string().min(1),
  requiresDesign: z.boolean(),
  taskType: z.string().min(1),
  rationale: z.string().min(1),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

/** chat 类标签归一判定：taskType 是 LLM 自由文本，判定闲聊兜底需容错（chat/Chat/chitchat/闲聊/打招呼…） */
export function isChatTaskType(taskType: string): boolean {
  return /^(chat|chitchat|闲聊|寒暄|打招呼|问候)/i.test(taskType.trim());
}

/**
 * 从 dispatcher 最终输出解析路由决策。
 * 依次尝试：```json 代码块 → 文本中第一个平衡的 {...} → 各候选的字符串内裸换行修复版；
 * 全部失败抛普通 Error（domain 保持纯）。
 */
export function parseRoutingDecision(text: string): RoutingDecision {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  if (fenced?.trim()) candidates.push(fenced.trim());
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  // GLM 偶发在 JSON 字符串值里输出裸换行（非法 JSON）：修复后重试
  const repaired = candidates.map((c) => escapeNewlinesInStrings(c));
  for (const c of [...candidates, ...repaired]) {
    try {
      return RoutingDecisionSchema.parse(JSON.parse(c));
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error(`无法从 dispatcher 输出解析路由决策: ${text.slice(0, 200)}`);
}

/** 仅转义 JSON 字符串内部的裸换行/回车，保留结构性空白 */
function escapeNewlinesInStrings(json: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of json) {
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") continue;
    out += ch;
  }
  return out;
}
