// transcript 持久化端口：donger 自有契约，不依赖 SDK Alpha 类型。
// SdkSessionStoreAdapter 负责把 SDK SessionStore 调用翻译成对这个端口的调用。

/** 一条 transcript 条目（与 SDK SessionStoreEntry 结构对齐：type 判别 + 可选 uuid/timestamp + 透传 payload） */
export interface TranscriptEntry {
  /** 判别类型：'user'/'assistant'/'summary'/'title'/'tag'...（SDK 决定，透传不解析） */
  type: string;
  /** 多数条目带稳定 uuid（幂等键）；title/tag/mode 等无 uuid */
  uuid?: string;
  /** ISO 时间戳（多数条目带） */
  timestamp?: string;
  /** 其余原始字段（透传，JSON round-trip 是唯一不变量） */
  [k: string]: unknown;
}

/** 存储定位：projectKey=userId, sessionId=sdkSessionId, subpath 区分子 agent */
export interface TranscriptKey {
  projectKey: string;
  sessionId: string;
  /** undefined=主 transcript；有值=子 agent transcript */
  subpath?: string;
}

/** 会话摘要条目（listSessions 用） */
export interface TranscriptSessionSummary {
  sessionId: string;
  /** Unix epoch 毫秒（存储写入时间） */
  mtime: number;
}

export interface TranscriptStore {
  /** 批量追加（幂等：uuid 冲突忽略；无 uuid 按序插入）。子 agent 经 subpath 区分。 */
  append(key: TranscriptKey, conversationId: string, entries: TranscriptEntry[]): Promise<void>;

  /** 加载整个 transcript（resume 用）。无记录返回 null。 */
  load(key: TranscriptKey): Promise<TranscriptEntry[] | null>;

  /** 列出某 projectKey 下的会话（按 mtime 倒序由调用方处理） */
  listSessions(projectKey: string): Promise<TranscriptSessionSummary[]>;

  /** 反查某会话最近一次 SDK session（主 transcript，不含子 agent）。无记录返回 null。 */
  latestSessionForConversation(conversationId: string): Promise<TranscriptSessionSummary | null>;

  /** 列出某 session 的子 agent subpath */
  listSubkeys(key: TranscriptKey): Promise<string[]>;

  /** 删除某 session 全部条目（含子 agent）。 */
  delete(key: TranscriptKey): Promise<void>;
}
