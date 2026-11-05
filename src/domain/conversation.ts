import { z } from "zod";
import { LLM_SDK_TYPES } from "./llm-platforms.js";
import { AgentPermissionModeSchema } from "./permission-mode.js";

export const ConversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sdkSessionId: z.string(),
  title: z.string(),
  channelId: z.string(),
  agentId: z.string(),
  /** 遗留：KB 会话特性（2026-11-04 随内置知识库管家退役）绑定的库 id；存量行只读兼容 */
  kbId: z.string().optional(),
  /** 会话权限模式覆盖；空 = 跟随绑定智能体的 defaultPermissionMode */
  permissionMode: AgentPermissionModeSchema.optional(),
  /** 用户最近一次显式选择的 LLM（modelRef）；空 = 未选过（fallback 系统默认/用户默认 provider）。
   *  兼作钉钉/CLI/回调等无选择 UI 渠道的 fallback。 */
  lastModelRef: z.string().optional(),
  /** 最近一次运行所用引擎（sdkType）；空=未运行过。与本次解析结果不同→弃 resume 开新线程
   *  （claude sessionId 与 codex threadId 不同命名空间，specs/2026-09-21-codex-openai-runner-design.md §7.4） */
  llmSdkType: z.enum(LLM_SDK_TYPES).optional(),
  /** 血缘：分叉来源会话 id；空 = 非分叉（specs/2026-10-23-conversation-fork-design.md §4.1） */
  forkedFromConversationId: z.string().optional(),
  /** 血缘：分叉点消息 id（D5 单档「含此条」语义下 = 最后一条被复制的消息）；会话级整史分叉 = 源会话末条 */
  forkedFromMessageId: z.string().optional(),
  /** 用户最近一次打开该会话的时间（会话未读徽标基准；缺省 = 从未打开，全部 bot 消息计未读） */
  lastSeenAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
