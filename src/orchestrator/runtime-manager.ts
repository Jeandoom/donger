import { join } from "node:path";
import { SdkSessionStoreAdapter } from "../adapters/sdk-session-store.js";
import type { Conversation } from "../domain/conversation.js";
import type { LLMConfig } from "../domain/llm-config.js";
import type { Plan } from "../domain/planner.js";
import type { CapabilitySet, RuntimeContext, TranscriptRef } from "../domain/runtime-context.js";
import type { User } from "../domain/user.js";
import type { RunOptions } from "../ports/agent-runner.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { TranscriptStore } from "../ports/transcript-store.js";
import { ensureRuntimeDir } from "../util/workspace.js";

export interface RuntimeManagerConfig {
  workspaceDir: string;
  llm: LLMConfig;
  /** 额外默认插件路径（每用户 .skills/ 由 prepare 自动追加） */
  defaultPluginPaths: string[];
  /** superpowers 插件路径；配置后才启用 plan.skills（沿用原 runOptsFor 语义） */
  superpowersPluginPath?: string;
  /** 默认 systemPromptAppend */
  defaultSystemPromptAppend: string;
}

export interface PrepareOpts {
  plan?: Plan;
  systemPromptAppend?: string;
  abortSignal?: AbortSignal;
}

interface RuntimeManagerDeps {
  transcriptStore: TranscriptStore;
  conversationStore: ConversationStore;
  config: RuntimeManagerConfig;
}

/**
 * 会话运行态总管（单一对外入口）。
 * 「上下文」= 历史对话数据(transcript) + 运行时目录(runtimeDir) + 可用能力(capabilities)。
 * - prepare：组装 RuntimeContext + RunOptions（含 sessionStore 注入）
 * - commit：回写 sdkSessionId
 * - getTranscript：读历史（回溯/重放）
 * - clearResume：清空 sdkSessionId（session 过期重试用）
 *
 * 内部含 ContextBuilder（能力组装）与 RuntimeDirResolver（目录懒创建），
 * 对外只暴露本类的统一 API。
 */
export class RuntimeManager {
  constructor(private readonly deps: RuntimeManagerDeps) {}

  async prepare(
    user: User,
    conversation: Conversation,
    opts: PrepareOpts,
  ): Promise<{ context: RuntimeContext; runOptions: RunOptions }> {
    // —— ContextBuilder：组装能力 ——
    const pluginPaths = this.buildPluginPaths(user);
    const capabilities: CapabilitySet = {
      skills: opts.plan?.skills ?? [],
      pluginPaths,
    };
    // skills 过滤：无 superpowers 时不启用 plan.skills（沿用原 runOptsFor 语义）
    const skills = this.deps.config.superpowersPluginPath ? capabilities.skills : [];

    // —— RuntimeDirResolver：懒创建运行时目录 homeDir/sessions/<convId>/workspace/ ——
    const runtimeDir = ensureRuntimeDir(user.homeDir, "sessions", conversation.id, "workspace");

    // —— transcript 适配器：projectKey=userId, conv_id=conversationId ——
    const sessionStore = new SdkSessionStoreAdapter(this.deps.transcriptStore, () => {
      return conversation.id;
    });

    const transcript: TranscriptRef = {
      projectKey: user.id,
      sessionId: conversation.sdkSessionId,
      conversationId: conversation.id,
      updatedAt: conversation.updatedAt,
    };

    const now = new Date().toISOString();
    const context: RuntimeContext = {
      conversationId: conversation.id,
      sdkSessionId: conversation.sdkSessionId,
      userId: user.id,
      runtimeDir,
      capabilities,
      transcript,
      createdAt: conversation.createdAt,
      updatedAt: now,
    };

    const runOptions: RunOptions = {
      cwd: runtimeDir,
      skills,
      pluginPaths: capabilities.pluginPaths,
      llm: this.deps.config.llm,
      systemPromptAppend: opts.systemPromptAppend ?? this.deps.config.defaultSystemPromptAppend,
      abortSignal: opts.abortSignal,
      resume: conversation.sdkSessionId || undefined,
      workspaceRoot: user.homeDir,
      sessionStore,
      capabilityVersion: 1,
    };

    return { context, runOptions };
  }

  /** 组装插件路径：每用户 .skills/ + 额外默认 + superpowers */
  private buildPluginPaths(user: User): string[] {
    const paths: string[] = [join(user.homeDir, ".skills")];
    for (const p of this.deps.config.defaultPluginPaths) {
      if (!paths.includes(p)) paths.push(p);
    }
    if (this.deps.config.superpowersPluginPath) {
      paths.push(this.deps.config.superpowersPluginPath);
    }
    return paths;
  }

  async commit(conversationId: string, patch: { sdkSessionId?: string }): Promise<void> {
    if (patch.sdkSessionId !== undefined) {
      await this.deps.conversationStore.update(conversationId, {
        sdkSessionId: patch.sdkSessionId,
      });
    }
  }

  /** session 过期重试：清空 sdkSessionId，使下次 prepare 不带 resume */
  async clearResume(conversationId: string): Promise<void> {
    await this.deps.conversationStore.update(conversationId, { sdkSessionId: "" });
  }

  /** 读取会话 transcript（回溯/重放用）。无 sdkSessionId 返回 null。 */
  async getTranscript(conversationId: string) {
    const conv = await this.deps.conversationStore.get(conversationId);
    if (!conv || !conv.sdkSessionId) return null;
    return this.deps.transcriptStore.load({
      projectKey: conv.userId,
      sessionId: conv.sdkSessionId,
    });
  }
}
