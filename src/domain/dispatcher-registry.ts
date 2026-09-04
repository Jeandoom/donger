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

/**
 * 纯函数：在登记表表尾数据行后追加一行。
 * 强制表格连续（不引入空行，dispatcher LLM 才能整表读到）；重复 agentId / 表结构不符抛 Error。
 */
export function appendDispatcherAgentRow(markdown: string, row: DispatcherAgentRow): string {
  const lines = markdown.split(/\r?\n/);
  const sepIdx = lines.findIndex((l) => l.trimStart().startsWith("|---"));
  if (sepIdx < 0) throw new Error("登记表格式不符：未找到表格分隔行");
  if (lines.some((l) => l.includes(`| ${row.agentId} |`) || l.includes(`|${row.agentId}|`))) {
    throw new Error(`agentId 已登记: ${row.agentId}`);
  }
  let last = sepIdx;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    if (lines[i]?.trimStart().startsWith("|")) last = i;
  }
  const line = `| ${row.agentId} | ${row.name} | ${row.duty} | ${row.skills.join(" / ")} | ${row.taskTypes} | ${row.knowledgeBase ?? "无"} |`;
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}
