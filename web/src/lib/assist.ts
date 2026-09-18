/** 内置协助智能体 ID（与后端 src/orchestrator/assist-agent.ts 保持一致） */
export const BUILTIN_ASSIST_AGENT_ID = "builtin-assist";

/** 兜底草稿的 sessionStorage key（入口 B 写入，assist 会话页读后即删） */
export const ASSIST_DRAFT_STORAGE_KEY = "donger.assistDraft";

// 旧版「暂无智能体 → 协助创建」提示（noneAssistHint）已随 task-flow 对话入口退役：
// 对话模块统一绑定智能体后，web 侧不再产生 dispatcher 的 none 回复。
