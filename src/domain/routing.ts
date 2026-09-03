import { z } from "zod";

/** dispatcher 的结构化路由决策（spec §4.3） */
export const RoutingDecisionSchema = z.object({
  agentId: z.string().min(1),
  requiresDesign: z.boolean(),
  taskType: z.string().min(1),
  rationale: z.string().min(1),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

/**
 * 从 dispatcher 最终输出解析路由决策。
 * 依次尝试：```json 代码块 → 文本中第一个平衡的 {...}；全部失败抛普通 Error（domain 保持纯）。
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
  for (const c of candidates) {
    try {
      return RoutingDecisionSchema.parse(JSON.parse(c));
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error(`无法从 dispatcher 输出解析路由决策: ${text.slice(0, 200)}`);
}
