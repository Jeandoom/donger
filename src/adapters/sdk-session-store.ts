import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptEntry, TranscriptKey, TranscriptStore } from "../ports/transcript-store.js";

/** 把 SDK SessionKey(projectKey/sessionId/subpath) 映射为 donger conversationId（append 落 conv_id 用） */
export type ConversationIdResolver = (key: TranscriptKey) => string;

/**
 * SDK SessionStore（Alpha）适配器：唯一接触 SDK Alpha SessionStore 接口的类。
 * 把 SDK 的 append/load/listSessions/listSubkeys/delete 翻译为 donger 自有 TranscriptStore 端口调用。
 * SDK 的 SessionStoreEntry 与 donger TranscriptEntry 结构对齐（type+uuid?+timestamp?+透传字段）。
 */
export class SdkSessionStoreAdapter implements SessionStore {
  constructor(
    private readonly store: TranscriptStore,
    private readonly resolveConversationId: ConversationIdResolver,
  ) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const tkey: TranscriptKey = {
      projectKey: key.projectKey,
      sessionId: key.sessionId,
      subpath: key.subpath,
    };
    await this.store.append(tkey, this.resolveConversationId(tkey), entries as TranscriptEntry[]);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.store.load({
      projectKey: key.projectKey,
      sessionId: key.sessionId,
      subpath: key.subpath,
    });
  }

  async listSessions(projectKey: string) {
    return this.store.listSessions(projectKey);
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.store.listSubkeys({
      projectKey: key.projectKey,
      sessionId: key.sessionId,
    });
  }

  async delete(key: { projectKey: string; sessionId: string }): Promise<void> {
    await this.store.delete({
      projectKey: key.projectKey,
      sessionId: key.sessionId,
    });
  }
}
