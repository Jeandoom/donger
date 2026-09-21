import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SdkSessionStoreAdapter } from "../adapters/sdk-session-store.js";
import type { LlmPreset } from "../config.js";
import type { Agent, McpServerConfig } from "../domain/agent.js";
import { collectCredentialRefs } from "../domain/connector.js";
import {
  mergeConnectorMcpServers,
  substituteCredentialRefs,
} from "../domain/connector-resolution.js";
import type { Conversation } from "../domain/conversation.js";
import { resolveInjectionEnv } from "../domain/credential-injection.js";
import type { LLMConfig } from "../domain/llm-config.js";
import { parseModelRef } from "../domain/model-ref.js";
import type { CapabilitySet, RuntimeContext, TranscriptRef } from "../domain/runtime-context.js";
import type { PackSkill, SkillPack } from "../domain/skill-pack.js";
import { resolveActiveSkills } from "../domain/skill-resolution.js";
import { UNTRUSTED_DATA_PREAMBLE } from "../domain/untrusted-content.js";
import type { User } from "../domain/user.js";
import type { RunOptions } from "../ports/agent-runner.js";
import type { MissingCredentialItem } from "../ports/channel.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { ExtensionDirectoryResolver } from "../ports/extension-directory-resolver.js";
import type { LlmProviderStore } from "../ports/llm-provider-store.js";
import type {
  RepositoryMaterializeItem,
  RepositoryMaterializer,
} from "../ports/repository-materializer.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { TranscriptStore } from "../ports/transcript-store.js";
import { seedBuiltinPacksIfAbsent } from "../util/builtin-skills.js";
import { ensureSdkPluginLayout, materializeSharedSkillPlugin } from "../util/sdk-plugin-layout.js";
import { ensureRuntimeDir } from "../util/workspace.js";

export interface RuntimeManagerConfig {
  workspaceDir: string;
  llm: LLMConfig;
  /** 默认 systemPromptAppend */
  defaultSystemPromptAppend: string;
  /** .env 预设列表（对话 modelRef=preset:<id> 的解析源） */
  agentLlmPresets: LlmPreset[];
  /** 会话空闲滚动阈值（小时；undefined/0=关闭）：闲置超限的会话重开新 SDK 会话 */
  sessionIdleRollHours?: number;
}

export interface PrepareOpts {
  systemPromptAppend?: string;
  abortSignal?: AbortSignal;
  /** 显式选中的智能体（旁路 Planner；undefined=默认 Planner 路径） */
  agent?: Agent;
  /** 共享智能体的创建者，仅用于复制其配置中实际选中的技能。 */
  sharedAgentSkillOwner?: User;
  gitMaterializeItems?: RepositoryMaterializeItem[];
  /** 用户显式选择的 LLM（消息级 modelRef；最高优先级，覆盖 agent preset 与基底） */
  modelRef?: string;
}

interface RuntimeManagerDeps {
  transcriptStore: TranscriptStore;
  conversationStore: ConversationStore;
  config: RuntimeManagerConfig;
  skillPackStore: SkillPackStore;
  /** 凭证集存储：agent 勾选的模板 code → 当前用户已配置值（解密仅此链路） */
  credentialSets: CredentialSetStore;
  /** 连接器注册表：agent.connectorIds → http McpServerConfig（headers 按访问者解析） */
  connectorStore?: ConnectorStore;
  /** 用户 LLM 供应商配置：默认 provider 作会话 LLM 基底（无则全局 .env） */
  llmProviderStore?: LlmProviderStore;
  installer: SkillInstaller;
  builtinSkillsDir: string;
  repositoryMaterializer?: RepositoryMaterializer;
  extensionDirectoryResolver?: ExtensionDirectoryResolver;
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

    // —— 由启用 Pack 派生默认能力（skills 白名单 + pluginPaths）——
    const packs = await this.deps.skillPackStore.listPacks(user.id);
    const skillsByPack = new Map<string, PackSkill[]>();
    for (const p of packs) {
      skillsByPack.set(p.id, await this.deps.skillPackStore.listSkills(user.id, p.id));
    }
    const resolved = resolveActiveSkills(packs, skillsByPack, (p) => this.resolvePackPath(user, p));
    // agent 勾选凭证：共享智能体按属主（分享者）用户空间解析——被分享者直接使用分享者的
    // 凭证配置（specs/2026-09-20-agent-share-tighten-and-duplicate-design.md §2.5）；
    // 缺失的注入 <CODE>_MISSING=1 兜底，agent 可自检。
    // git 类凭证（kind="git"）不注入 env——token 仅经凭证桥在 donger-git 工具/仓库
    // 物化内现取，防止 agent 从环境拿到 token 绕过工具直连平台（防线 1）。
    let credentialsEnv: Record<string, string> = {};
    if (opts.agent?.credentials?.length) {
      const picked = opts.agent.credentials;
      const templates = await Promise.all(
        picked.map((code) => this.deps.credentialSets.getTemplate(code)),
      );
      const injectable = picked.filter((_, i) => templates[i]?.kind !== "git");
      const filled = await this.deps.credentialSets.getFilledValues(
        opts.sharedAgentSkillOwner?.id ?? user.id,
        injectable,
      );
      credentialsEnv = resolveInjectionEnv(
        filled.map((f) => ({ code: f.code, values: f.values })),
        injectable,
      ).env;
    }

    // agent 分支：显式 agent 可覆盖 skills/工具/mcp/系统提示；否则用 Pack 派生默认
    let skills = resolved.whitelist;
    // —— LLM 解析（优先级从高到低；specs/2026-09-18-llm-multi-provider-design.md §8）——
    // ① 消息显式 modelRef ② conversation.lastModelRef（上次选择，兼作无选择 UI 渠道 fallback）
    // ③ 用户默认 provider ④ 全局 .env
    // （agent 侧 presetId/modelRefs 配置已退役，specs/2026-09-21-agent-config-llm-removal-skills-tree-design.md）
    const defaultProvider = await this.deps.llmProviderStore?.findDefaultWithKey(user.id);
    const baseLlm: LLMConfig = defaultProvider
      ? {
          model: defaultProvider.models[0] ?? this.deps.config.llm.model,
          baseUrl: defaultProvider.baseUrl,
          authToken: defaultProvider.key,
        }
      : this.deps.config.llm;
    let llm: LLMConfig = baseLlm;
    // 用户选择（显式优先，上次选择兜底）：显式无效即报错（用户可感知），历史失效静默降级
    const selectedRef = opts.modelRef ?? conversation.lastModelRef;
    if (selectedRef) {
      const resolvedLlm = await this.resolveModelRef(selectedRef, user, baseLlm);
      if (resolvedLlm) {
        llm = resolvedLlm;
      } else if (opts.modelRef) {
        throw new Error(`所选模型不可用（配置可能已删除或不在你的模型配置中）：${opts.modelRef}`);
      }
      // 回写仅限显式选择（内部轮/历史命中不刷新）
      if (opts.modelRef) {
        await this.deps.conversationStore.update(conversation.id, {
          lastModelRef: opts.modelRef,
        });
      }
    }
    let allowedTools: string[] | undefined;
    let mcpServers: McpServerConfig[] | undefined;
    let gitAllowShellGit = false;
    let extraPrompt: string | undefined = opts.systemPromptAppend;
    let additionalDirectories: string[] | undefined;
    let allowedWriteRoots: string[] | undefined;
    let readOnlyRoots: string[] | undefined;

    if (opts.agent) {
      const a = opts.agent;
      // agent 指定 skills 时直接用；否则沿用 Pack 白名单
      if (a.skills.length > 0) skills = a.skills;
      allowedTools = a.tools.mode === "whitelist" ? a.tools.whitelist : undefined;
      mcpServers = a.mcpServers;
      // 连接器注入：共享智能体按属主解析（可见性+headers 凭证随分享者，§2.5）；
      // 重名连接器优先，防工具命名空间幻觉
      if ((a.connectorIds?.length ?? 0) > 0 && this.deps.connectorStore) {
        const connectors = await this.resolveAgentConnectors(
          a.connectorIds ?? [],
          opts.sharedAgentSkillOwner?.id ?? user.id,
        );
        mcpServers = mergeConnectorMcpServers(mcpServers, connectors.servers);
      }
      // shell git 守卫（防线 2）：全域缺省禁用，仅 agent 显式开启才放行
      gitAllowShellGit = a.gitAllowShellGit;
      if (a.systemPrompt) {
        extraPrompt = `${opts.systemPromptAppend ?? ""}\n\n${a.systemPrompt}`.trim();
      }
    }

    // —— RuntimeDirResolver：运行时目录懒创建 ——
    // agent 绑定任务：cwd 按 agent 共享（agents/<agentId>/workspace），产物跨会话延续；
    // 闲聊/无 agent：保持会话级隔离（sessions/<convId>/workspace）。
    // 注意同 agent 并发任务会写同一目录——语义上 agent 应串行干活，后续可加忙互斥。
    const runtimeDir = opts.agent
      ? ensureRuntimeDir(user.homeDir, "agents", opts.agent.id, "workspace")
      : ensureRuntimeDir(user.homeDir, "sessions", conversation.id, "workspace");
    const pluginPaths = [
      ...resolved.pluginPaths,
      ...(opts.agent && opts.sharedAgentSkillOwner
        ? await this.materializeSharedAgentSkills(
            user,
            runtimeDir,
            opts.agent,
            opts.sharedAgentSkillOwner,
          )
        : []),
    ];
    // 插件共享运行库（<plugin>/scripts，如 copilot-skills 的 credentials 包）→
    // PYTHONPATH 注入清单；存在才注入，交给 runner 并 env（specs/2026-09-12-copilot-skills-packaging.md）
    const pythonPaths = pluginPaths.map((p) => join(p, "scripts")).filter((p) => existsSync(p));

    const capabilities: CapabilitySet = {
      skills,
      pluginPaths,
    };

    if (opts.agent?.extensionDirectories?.length && this.deps.extensionDirectoryResolver) {
      if (opts.agent.ownerId === user.id) {
        const resolution = await this.deps.extensionDirectoryResolver.resolve(
          opts.agent.extensionDirectories,
          resolve(user.homeDir),
        );
        additionalDirectories = resolution.available.map((item) => item.path);
        allowedWriteRoots = resolution.available
          .filter((item) => item.access === "readWrite")
          .map((item) => item.path);
        readOnlyRoots = resolution.available
          .filter((item) => item.access === "readOnly")
          .map((item) => item.path);
        const directoryPrompt = [
          "## 扩展工作目录",
          ...resolution.available.map(
            (item) =>
              `- ${item.name}: ${item.path}（${item.access === "readWrite" ? "读写" : "只读"}）`,
          ),
          ...resolution.unavailable.map((item) => `- ${item.name}: 不可用（${item.reason}）`),
        ].join("\n");
        extraPrompt = extraPrompt ? `${extraPrompt}\n\n${directoryPrompt}` : directoryPrompt;
      } else {
        const warning = "## 扩展工作目录\n共享智能体不会向访问者开放创建者的宿主工作目录。";
        extraPrompt = extraPrompt ? `${extraPrompt}\n\n${warning}` : warning;
      }
    }

    if (opts.gitMaterializeItems?.length && this.deps.repositoryMaterializer) {
      const repositories = await this.deps.repositoryMaterializer.materialize({
        destination: join(runtimeDir, "repos"),
        items: opts.gitMaterializeItems,
        signal: opts.abortSignal,
      });
      const requiredById = new Map(
        opts.gitMaterializeItems.map((item) => [item.repository.id, item.repository.required]),
      );
      const blocking = repositories.find(
        (result) => result.status === "error" && requiredById.get(result.repositoryId),
      );
      if (blocking)
        throw new Error(`必需仓库 ${blocking.name} 准备失败：${blocking.message ?? "未知错误"}`);
      const repositoryPrompt = [
        "## 会话 Git 仓库",
        ...repositories.map(
          (result) =>
            `- ${result.name}: ${result.path}，${result.status === "ready" ? "已就绪" : (result.message ?? result.status)}`,
        ),
      ].join("\n");
      extraPrompt = extraPrompt ? `${extraPrompt}\n\n${repositoryPrompt}` : repositoryPrompt;
    }

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

    // 空闲滚动：距会话最后活跃超过阈值时重开新 SDK 会话（sessionStore 保留，新 sessionId
    // 轮末照常 commit 回写）。跨天/周低频会话若一直 resume，每轮全量重建超长上下文，
    // 实测闲置 9 天后"回复 OK"也要 32k 输入 token（cacheRead 仅 2k）。
    const idleRollMs = (this.deps.config.sessionIdleRollHours ?? 0) * 3_600_000;
    const idleTooLong =
      idleRollMs > 0 &&
      Boolean(conversation.sdkSessionId) &&
      Date.now() - Date.parse(conversation.updatedAt) > idleRollMs;

    const runOptions: RunOptions = {
      cwd: runtimeDir,
      skills,
      pluginPaths,
      llm,
      systemPromptAppend: this.combineSystemPromptAppend(extraPrompt),
      abortSignal: opts.abortSignal,
      resume: idleTooLong ? undefined : conversation.sdkSessionId || undefined,
      workspaceRoot: user.homeDir,
      additionalDirectories,
      allowedWriteRoots,
      readOnlyRoots,
      sessionStore,
      capabilityVersion: 1,
      credentialsEnv,
      ...(pythonPaths.length ? { pythonPaths } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      gitAllowShellGit,
      ...(mcpServers?.length ? { mcpServers } : {}),
    };

    return { context, runOptions };
  }

  /**
   * 解析 modelRef → LLMConfig。
   * system=全局；preset=.env 预设（叠加基底 token，沿 preset 既有语义）；
   * provider=当前用户自建（getWithKey 按属主查询，天然越权拦截；模型须在清单内）。
   * 无法解析（格式非法/引用失效/非本人 provider）返回 undefined，由调用方决定报错或降级。
   */
  private async resolveModelRef(
    ref: string,
    user: User,
    baseLlm: LLMConfig,
  ): Promise<LLMConfig | undefined> {
    const parsed = parseModelRef(ref);
    if (!parsed) return undefined;
    if (parsed.kind === "system") return this.deps.config.llm;
    if (parsed.kind === "preset") {
      const preset = this.deps.config.agentLlmPresets.find((p) => p.id === parsed.id);
      if (!preset) return undefined;
      return { ...baseLlm, model: preset.model, baseUrl: preset.baseUrl };
    }
    const provider = await this.deps.llmProviderStore?.getWithKey(user.id, parsed.providerId);
    if (!provider?.models.includes(parsed.model)) return undefined;
    return { model: parsed.model, baseUrl: provider.baseUrl, authToken: provider.key };
  }

  /**
   * 解析 agent 引用的连接器 → 可注入的 http McpServerConfig：
   * 可见性（private 仅 owner / global 人人）与 enabled 过滤 + headers 凭证引用按访问者解析。
   * 解析失败的引用头置空剔除（缺失预检已由 inspectCredentials 前置问询）。
   */
  private async resolveAgentConnectors(
    connectorIds: string[],
    userId: string,
  ): Promise<{ servers: McpServerConfig[]; missing: string[] }> {
    const cstore = this.deps.connectorStore;
    if (!cstore) return { servers: [], missing: [] };
    const connectors = (await cstore.listByIds(connectorIds)).filter(
      (c) => c.enabled && (c.shareScope === "global" || c.ownerId === userId),
    );
    const codes = [...new Set(connectors.flatMap((c) => collectCredentialRefs(c.headers)))];
    const valuesByCode = new Map<string, Record<string, string>>();
    if (codes.length > 0) {
      for (const f of await this.deps.credentialSets.getFilledValues(userId, codes)) {
        valuesByCode.set(f.code, f.values);
      }
    }
    const servers: McpServerConfig[] = [];
    const missing = new Set<string>();
    for (const c of connectors) {
      const sub = substituteCredentialRefs(c.headers, valuesByCode);
      for (const m of sub.missing) missing.add(m);
      const headers = Object.fromEntries(Object.entries(sub.resolved).filter(([, v]) => v !== ""));
      servers.push({
        name: c.name,
        type: "http",
        url: c.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
    return { servers, missing: [...missing] };
  }

  /** 连接器 headers 引用的凭证 code（可见+enabled 过滤后；缺失预检与 agent.credentials 并集用）。 */
  async connectorCredentialCodes(userId: string, connectorIds: string[]): Promise<string[]> {
    const cstore = this.deps.connectorStore;
    if (!cstore || connectorIds.length === 0) return [];
    const connectors = (await cstore.listByIds(connectorIds)).filter(
      (c) => c.enabled && (c.shareScope === "global" || c.ownerId === userId),
    );
    return [...new Set(connectors.flatMap((c) => collectCredentialRefs(c.headers)))];
  }

  /** 凭证缺失预检：agent 勾选但当前用户未配置的模板元数据（问询卡/日志用，不含值）。 */
  async inspectCredentials(userId: string, codes: string[]): Promise<MissingCredentialItem[]> {
    if (codes.length === 0) return [];
    const filled = new Set(
      (await this.deps.credentialSets.getFilledValues(userId, codes)).map((f) => f.code),
    );
    const missing: MissingCredentialItem[] = [];
    for (const code of codes) {
      if (filled.has(code)) continue;
      const t = await this.deps.credentialSets.getTemplate(code);
      missing.push({
        code,
        name: t?.name ?? code,
        description: t?.description,
        keys: t?.keySpecs.map((k) => k.key) ?? [],
      });
    }
    return missing;
  }

  /** 解析 pack 绝对路径：预装/绝对路径原样，用户 pack 拼 homeDir。 */
  private resolvePackPath(user: User, pack: SkillPack): string {
    const packPath =
      pack.builtin || isAbsolute(pack.installedPath)
        ? pack.installedPath
        : join(user.homeDir, pack.installedPath);
    return ensureSdkPluginLayout(packPath, pack.name);
  }

  private async materializeSharedAgentSkills(
    user: User,
    runtimeDir: string,
    agent: Agent,
    owner: User,
  ): Promise<string[]> {
    if (agent.ownerId === user.id) return [];
    const selected = new Map<string, Set<string>>();
    for (const skillId of [...agent.skills, ...(agent.defaultSkill ? [agent.defaultSkill] : [])]) {
      const separator = skillId.indexOf(":");
      if (separator <= 0 || separator === skillId.length - 1) continue;
      const packName = skillId.slice(0, separator);
      const skillName = skillId.slice(separator + 1);
      const names = selected.get(packName) ?? new Set<string>();
      names.add(skillName);
      selected.set(packName, names);
    }
    if (selected.size === 0) return [];

    const ownerPacks = (await this.deps.skillPackStore.listPacks(owner.id)).filter(
      (pack) => pack.enabled && selected.has(pack.name),
    );
    const targetRoot = join(runtimeDir, ".donger-shared-skills");
    const paths: string[] = [];
    for (const pack of ownerPacks) {
      const packPath = this.resolvePackPath(owner, pack);
      const target = join(targetRoot, safeDirectoryName(pack.name));
      const materialized = materializeSharedSkillPlugin(
        packPath,
        pack.name,
        [...(selected.get(pack.name) ?? [])],
        target,
      );
      if (materialized) paths.push(materialized);
    }
    return paths;
  }

  /** 合并 systemPromptAppend：默认始终在，extra（如记忆上下文）追加其后 */
  private combineSystemPromptAppend(extra?: string): string {
    // 不可信数据信任规则随系统提示注入（规格 §5.1，与 wrapUntrusted 定界配套）
    const base = `${this.deps.config.defaultSystemPromptAppend}\n\n${UNTRUSTED_DATA_PREAMBLE}`;
    return extra ? `${base}\n\n${extra}` : base;
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
    if (!conv?.sdkSessionId) return null;
    return this.deps.transcriptStore.load({
      projectKey: conv.userId,
      sessionId: conv.sdkSessionId,
    });
  }
}

function safeDirectoryName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "pack";
}
