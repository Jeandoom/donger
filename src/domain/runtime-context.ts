// 会话运行态值对象（纯数据，零依赖）。
// 「上下文」= 历史对话数据(transcript) + 运行时目录(runtimeDir) + 可用能力(capabilities)。

/** 可用能力快照：每次会话可配置，决定 agent 能用什么 */
export interface CapabilitySet {
  /** 启用的 skill 名（透传 SDK options.skills 做过滤） */
  skills: string[];
  /** 本地插件路径（含 .skills/ 与可选 superpowers） */
  pluginPaths: string[];
}

/** transcript 指针：内容存 TranscriptStore，这里只存锚点 */
export interface TranscriptRef {
  /** = userId（SDK projectKey 映射） */
  projectKey: string;
  /** = sdkSessionId（SDK sessionId 映射） */
  sessionId: string;
  /** donger 会话 ID（桥接 SDK session 与 donger 会话） */
  conversationId: string;
  /** 最后一条消息 UUID（fork 回滚落点候选） */
  lastMessageUuid?: string;
  updatedAt: string;
}

/** 一个会话的完整运行态快照 */
export interface RuntimeContext {
  conversationId: string;
  sdkSessionId: string;
  userId: string;
  /** cwd 绝对路径（homeDir/sessions/<convId>/workspace/） */
  runtimeDir: string;
  capabilities: CapabilitySet;
  transcript: TranscriptRef;
  createdAt: string;
  updatedAt: string;
}
