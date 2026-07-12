import { isAbsolute, join } from "node:path";
import { SdkSessionStoreAdapter } from "../adapters/sdk-session-store.js";
import type { Conversation } from "../domain/conversation.js";
import type { LLMConfig } from "../domain/llm-config.js";
import type { PackSkill, SkillPack } from "../domain/skill-pack.js";
import { resolveActiveSkills } from "../domain/skill-resolution.js";
import type { CapabilitySet, RuntimeContext, TranscriptRef } from "../domain/runtime-context.js";
import type { User } from "../domain/user.js";
import type { RunOptions } from "../ports/agent-runner.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialRequestItem } from "../ports/channel.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { TranscriptStore } from "../ports/transcript-store.js";
import { seedBuiltinPacksIfAbsent } from "../util/builtin-skills.js";
import { ensureRuntimeDir } from "../util/workspace.js";

export interface RuntimeManagerConfig {
  workspaceDir: string;
  llm: LLMConfig;
  /** 默认 systemPromptAppend */
  defaultSystemPromptAppend: string;
}

export interface PrepareOpts {
  systemPromptAppend?: string;
  abortSignal?: AbortSignal;
}

interface RuntimeManagerDeps {
  transcriptStore: TranscriptStore;
  conversationStore: ConversationStore;
  config: RuntimeManagerConfig;
  skillPackStore: SkillPackStore;
  credentialStore: CredentialStore;
  installer: SkillInstaller;
  builtinSkillsDir: string;
}

/**
 * 会话运行态总管（单一对外入口）。
 * 「上下文」= 历史对话数据(transcript) + 运行时目录(runtimeDir) + 可用能力(capabilities)。
 * - prepare：组装 RuntimeContext + RunOptions（含 sessionStore 注入、凭证 env）
 * - activeCredentialRequirements：凭证门用，算出缺失的 required 凭证
 * - commit：回写 sdkSessionId
 * - getTranscript：读历史（回溯/重放）
 * - clearResume：清空 sdkSessionId（session 过期重试用）
 *
 * 能力（skills/pluginPaths/凭证）由用户启用的 Pack 驱动（见 domain/skill-resolution.ts）。
 */
export class RuntimeManager {
  constructor(private readonly deps: RuntimeManagerDeps) {}

  async prepare(
    user: User,
    conversation: Conversation,
    opts: PrepareOpts,
  ): Promise<{ context: RuntimeContext; runOptions: RunOptions }> {
    // 预装 Pack 懒登记（幂等）
    await seedBuiltinPacksIfAbsent(
      this.deps.skillPackStore,
      this.deps.installer,
      this.deps.builtinSkillsDir,
      user.id,
    );

    // —— ContextBuilder：由启用 Pack 派生能力 ——
    const packs = await this.deps.skillPackStore.listPacks(user.id);
    const skillsByPack = new Map<string, PackSkill[]>();
    for (const p of packs) {
      skillsByPack.set(p.id, await this.deps.skillPackStore.listSkills(user.id, p.id));
    }
    const resolved = resolveActiveSkills(packs, skillsByPack, (p) => this.resolvePackPath(user, p));
    const capabilities: CapabilitySet = {
      skills: resolved.whitelist,
      pluginPaths: resolved.pluginPaths,
    };
    const credentialsEnv = await this.deps.credentialStore.getMany(
      user.id,
      resolved.declaredCredentialKeys,
    );

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
      skills: resolved.whitelist,
      pluginPaths: resolved.pluginPaths,
      llm: this.deps.config.llm,
      systemPromptAppend: this.combineSystemPromptAppend(opts.systemPromptAppend),
      abortSignal: opts.abortSignal,
      resume: conversation.sdkSessionId || undefined,
      workspaceRoot: user.homeDir,
      sessionStore,
      capabilityVersion: 1,
      credentialsEnv,
    };

    return { context, runOptions };
  }

  /** 凭证门用：返回启用 pack 声明、且用户保险柜尚缺的 required 凭证项（带 packName）。 */
  async missingCredentialItems(userId: string): Promise<CredentialRequestItem[]> {
    const packs = (await this.deps.skillPackStore.listPacks(userId)).filter((p) => p.enabled);
    const vault = new Set((await this.deps.credentialStore.list(userId)).map((e) => e.key));
    const items: CredentialRequestItem[] = [];
    for (const p of packs) {
      for (const c of p.credentials) {
        if (c.required && !vault.has(c.key)) {
          items.push({
            key: c.key,
            label: c.label,
            description: c.description,
            secret: c.secret,
            packName: p.name,
          });
        }
      }
    }
    return items;
  }

  /** 解析 pack 绝对路径：预装/绝对路径原样，用户 pack 拼 homeDir。 */
  private resolvePackPath(user: User, pack: SkillPack): string {
    return pack.builtin || isAbsolute(pack.installedPath)
      ? pack.installedPath
      : join(user.homeDir, pack.installedPath);
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

function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}
