import type { Conversation } from "../domain/conversation.js";
import type { AgentPermissionMode } from "../domain/permission-mode.js";

export interface ConversationStore {
  /** 创建新会话（sdkSessionId 初始为空，首次 query 后回写；agentId 为空=默认对话） */
  create(userId: string, channelId: string, title: string): Promise<Conversation>;
  /** 创建绑定到指定智能体的会话；opts.permissionMode 用于会话级权限模式覆盖（回调链路写 full_access）；
   *  opts.kbId 用于 KB 会话（agentId=builtin-kb-assistant + kbId 定位库） */
  createWithAgent(
    userId: string,
    channelId: string,
    title: string,
    agentId: string,
    opts?: { permissionMode?: AgentPermissionMode; kbId?: string },
  ): Promise<Conversation>;
  /** 按 ID 查 */
  get(id: string): Promise<Conversation | undefined>;
  /** 纵深防御 L2（规格 §4）：仅当会话属于 viewer 时返回（否则 undefined，含不存在） */
  getVisible(viewerId: string, id: string): Promise<Conversation | undefined>;
  /** 列出用户未归档会话（最新在前） */
  listByUser(userId: string): Promise<Conversation[]>;
  /** 取用户最新未归档会话 */
  getLatest(userId: string, channelId: string): Promise<Conversation | undefined>;
  /** 更新（回写 sdkSessionId / title / agentId / archived；agentId 置空串=解除绑定） */
  update(id: string, patch: Partial<Conversation>): Promise<void>;
}
