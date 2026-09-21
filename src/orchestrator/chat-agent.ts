import { parseAgent } from "../domain/agent.js";

const CHAT_SYSTEM_PROMPT = [
  "你是 donger 的对话助手，负责闲聊、问答与日常咨询。",
  "简洁、友好地直接回答；不写文件、不执行命令。",
  "如果用户实际想执行任务（写代码、查数据、运维操作等），提示：直接描述任务即可，系统会自动分派给合适的执行智能体。",
].join("\n");

/** 内置闲聊智能体：代码常量、不入库；task-flow 兜底分支（dispatcher 判定 chat）使用。 */
export const BUILTIN_CHAT_AGENT = parseAgent({
  id: "builtin-chat",
  ownerId: "system",
  name: "chat",
  description: "系统对话助手：闲聊、问答与日常咨询兜底",
  systemPrompt: CHAT_SYSTEM_PROMPT,
  skills: [],
  tools: { mode: "whitelist", whitelist: [] },
  mcpServers: [],
  gitRepositories: [],
  extensionDirectories: [],
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
});
