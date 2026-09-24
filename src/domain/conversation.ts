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
  /** 知识库对话绑定的库（KB 会话：agentId 恒为 builtin-kb-assistant + kbId 定位库；普通会话为空） */
  kbId: z.string().optional(),
  /** 会话权限模式覆盖；空 = 跟随绑定智能体的 defaultPermissionMode */
  permissionMode: AgentPermissionModeSchema.optional(),
  /** 用户最近一次显式选择的 LLM（modelRef）；空 = 未选过（fallback 系统默认/用户默认 provider）。
   *  兼作钉钉/CLI/回调等无选择 UI 渠道的 fallback。 */
  lastModelRef: z.string().optional(),
  /** 最近一次运行所用引擎（sdkType）；空=未运行过。与本次解析结果不同→弃 resume 开新线程
   *  （claude sessionId 与 codex threadId 不同命名空间，specs/2026-09-21-codex-openai-runner-design.md §7.4） */
  llmSdkType: z.enum(LLM_SDK_TYPES).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
