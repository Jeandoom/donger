/** dispatcher 登记表（kb/dispatcher/agents.md）一行的领域形状 */
export interface DispatcherAgentRow {
  agentId: string;
  /** 名称 */
  name: string;
  /** 职责（一句话） */
  duty: string;
  skills: string[];
  /** 适用任务类型 */
  taskTypes: string;
  /** 业务知识库（缺省=无） */
  knowledgeBase?: string;
}

/** 表格单元格消毒：竖线/换行会破坏 markdown 行结构，统一替换 */
function sanitizeCell(text: string): string {
  return text.replace(/\|/g, "／").replace(/\r?\n/g, " ").trim();
}

/**
 * 纯函数：在登记表表尾数据行后追加一行。
 * 强制表格连续（不引入空行，dispatcher LLM 才能整表读到）；重复 agentId / 表结构不符抛 Error。
 * 单元格内容经消毒（LLM 生成的职责描述可能含竖线/换行）。
 */
export function appendDispatcherAgentRow(markdown: string, row: DispatcherAgentRow): string {
  const safe: DispatcherAgentRow = {
    agentId: sanitizeCell(row.agentId),
    name: sanitizeCell(row.name),
    duty: sanitizeCell(row.duty),
    skills: row.skills.map((s) => sanitizeCell(s)).filter((s) => s.length > 0),
    taskTypes: sanitizeCell(row.taskTypes),
    knowledgeBase: row.knowledgeBase === undefined ? undefined : sanitizeCell(row.knowledgeBase),
  };
  const lines = markdown.split(/\r?\n/);
  const sepIdx = lines.findIndex((l) => l.trimStart().startsWith("|---"));
  if (sepIdx < 0) throw new Error("登记表格式不符：未找到表格分隔行");
  if (lines.some((l) => l.includes(`| ${safe.agentId} |`) || l.includes(`|${safe.agentId}|`))) {
    throw new Error(`agentId 已登记: ${safe.agentId}`);
  }
  let last = sepIdx;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    if (lines[i]?.trimStart().startsWith("|")) last = i;
  }
  const line = `| ${safe.agentId} | ${safe.name} | ${safe.duty} | ${safe.skills.join(" / ")} | ${safe.taskTypes} | ${safe.knowledgeBase ?? "无"} |`;
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}
