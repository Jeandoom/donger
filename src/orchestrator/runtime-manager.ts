import { join } from "node:path";
import { SdkSessionStoreAdapter } from "../adapters/sdk-session-store.js";
import type { LlmPreset } from "../config.js";
import type { Agent, McpServerConfig } from "../domain/agent.js";
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
  /** Agent 可选 LLM 预置列表（agent.llm.presetId 引用） */
  agentLlmPresets: LlmPreset[];
}

export interface PrepareOpts {
  plan?: Plan;
  systemPromptAppend?: string;
  abortSignal?: AbortSignal;
  /** 显式选中的智能体（旁路 Planner；undefined=默认 Planner 路径） */
  agent?: Agent;
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

    // skills / llm / allowedTools / mcpServers / systemPrompt：agent 分支覆盖默认 Planner 路径
    let skills: string[];
    let llm: LLMConfig = this.deps.config.llm;
    let allowedTools: string[] | undefined;
    let mcpServers: McpServerConfig[] | undefined;
    let extraPrompt: string | undefined = opts.systemPromptAppend;

    if (opts.agent) {
      const a = opts.agent;
      // agent 指定 skills 时直接用；否则回退到 plan.skills（受 superpowers 开关约束）
      skills =
        a.skills.length > 0
          ? a.skills
          : this.deps.config.superpowersPluginPath
            ? (opts.plan?.skills ?? [])
            : [];
      const preset = a.llm.presetId
        ? this.deps.config.agentLlmPresets.find((p) => p.id === a.llm.presetId)
        : undefined;
      if (preset) llm = { ...this.deps.config.llm, model: preset.model, baseUrl: preset.baseUrl };
      allowedTools = a.tools.mode === "whitelist" ? a.tools.whitelist : undefined;
      mcpServers = a.mcpServers;
      extraPrompt = a.systemPrompt
        ? `${opts.systemPromptAppend ?? ""}\n\n${a.systemPrompt}`.trim()
        : opts.systemPromptAppend;
    } else {
      skills = this.deps.config.superpowersPluginPath ? (opts.plan?.skills ?? []) : [];
    }

    const capabilities: CapabilitySet = {
      skills,
      pluginPaths,
    };

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
      llm,
      systemPromptAppend: this.combineSystemPromptAppend(extraPrompt),
      abortSignal: opts.abortSignal,
      resume: conversation.sdkSessionId || undefined,
      workspaceRoot: user.homeDir,
      sessionStore,
      capabilityVersion: 1,
      ...(allowedTools ? { allowedTools } : {}),
      ...(mcpServers?.length ? { mcpServers } : {}),
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

  /** 合并 systemPromptAppend：默认始终在，extra（如记忆上下文）追加其后 */
  private combineSystemPromptAppend(extra?: string): string {
    return extra
      ? `${this.deps.config.defaultSystemPromptAppend}\n\n${extra}`
      : this.deps.config.defaultSystemPromptAppend;
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
