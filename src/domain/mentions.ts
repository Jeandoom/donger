import { z } from "zod";

/** 引用类别：@ 文件 / ⁄ 技能 / $ 连接器 */
export const MentionKindSchema = z.enum(["file", "skill", "connector"]);
export type MentionKind = z.infer<typeof MentionKindSchema>;

/**
 * 前端上送的引用标记。file.id 形如 "runtime:<relPath>"（与文件浏览器 runtime scope
 * 同口径）；skill.id 为技能白名单 id（pack:skill）；connector.id 为连接器 id。
 * 仅作为候选意图传输，路径/名称以服务端校验结果为准。
 */
export const MentionInputSchema = z.object({
  kind: MentionKindSchema,
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(256),
});
export type MentionInput = z.infer<typeof MentionInputSchema>;

/** 服务端解析校验后的引用：文件已换算为经属主与边界校验的绝对路径，未命中的引用直接丢弃 */
export const ResolvedMentionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), label: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal("skill"), label: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal("connector"), label: z.string().min(1), name: z.string().min(1) }),
]);
export type ResolvedMention = z.infer<typeof ResolvedMentionSchema>;

/**
 * 将已校验的引用注入 prompt。只注入路径/名称，不内联文件内容——与附件机制同哲学，
 * 内容由 agent 自行 Read，避免撑爆上下文，也不扩大提示注入暴露面。
 */
export function appendMentions(prompt: string, mentions?: readonly ResolvedMention[]): string {
  if (!mentions?.length) return prompt;
  const lines: string[] = ["## 用户引用"];
  for (const m of mentions) {
    if (m.kind === "file") {
      lines.push(
        `- 文件 @${m.label}：绝对路径 ${JSON.stringify(m.path)}（请先用 Read 工具读取再回答，不要仅凭文件名推测）`,
      );
    } else if (m.kind === "skill") {
      lines.push(`- 技能 /${m.label}：用户指定使用该技能，请优先按其流程执行`);
    } else {
      lines.push(`- 连接器 $${m.label}：用户指定优先通过该连接器（MCP 工具）完成任务`);
    }
  }
  return `${prompt}\n\n${lines.join("\n")}`;
}
