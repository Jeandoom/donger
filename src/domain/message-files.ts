import type { MessageFile } from "./types.js";

/** 将已由 WebChannel 校验过的附件路径显式交给 Agent。 */
export function appendMessageFiles(prompt: string, files?: readonly MessageFile[]): string {
  if (!files?.length) return prompt;
  const list = files
    .map((file) => `- ${JSON.stringify(file.name)} (${file.type}): ${JSON.stringify(file.path)}`)
    .join("\n");
  return `${prompt}\n\n## 用户附件\n请先使用 Read 工具读取与问题相关的附件，再结合文件内容回答；不要仅根据文件名推测。\n${list}`;
}
