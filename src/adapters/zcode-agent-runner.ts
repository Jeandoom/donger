import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { McpServerConfig } from "../domain/agent.js";
import type { GateRouter } from "../domain/gate-router.js";
import type { LLMConfig } from "../domain/llm-config.js";
import type { AgentPermissionMode } from "../domain/permission-mode.js";
import { classifyShellCommand } from "../domain/read-only-shell-command.js";
import type { QuestionItem, RunnerEvent, Task, TokenUsage } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";
import { materializeWhitelistedSkills } from "../util/skill-materialization.js";
import { type McpGateCheck, McpHttpBridge } from "./mcp-http-bridge.js";
import { runStaticToolGuards } from "./tool-call-guards.js";
import {
  defaultZcodeConnectionFactory,
  type ZcodeConnection,
  type ZcodeConnectionFactory,
  type ZcodeSessionEventParams,
} from "./zcode-protocol-client.js";

/**
 * ZCode 引擎 runner：spawn `zcode app-server`（GLM 官方 harness）以 ZCode Protocol
 * stdio NDJSON 驱动（specs/2026-09-25-zcode-engine-integration.md）。
 *
 * 与 ClaudeAgentRunner 的关键差异：
 * - 守卫经 toolDenylist（内置工具词表 ∖ 白名单，在 ZCode 内部生效——build 模式只读
 *   直通不发权限请求，单靠权限回调兜不住白名单）+ interaction/requestPermission
 *   双层执行；守卫函数与 claude 引擎共用（tool-call-guards.ts）。
 * - 审批门经反向请求 interaction/requestPermission 接 donger 审批卡（全功能，非
 *   codex 式静态拒绝）；AskUserQuestion 经 interaction/requestUserInput 桥接。
 * - 会话模式映射：白名单含写能力工具 → build（高危/副作用才问宿主），否则 plan
 *   （只读，ZCode 对写操作内部 deny）；恒不使用 yolo/auto。
 * - 用户 GLM key 以个人 provider 配置物化进用户工作区隔离目录，轮末删除；
 *   状态目录（HOME/DATA_BASE_DIR/SESSION_DB_PATH）全部重定向，不碰真实 ~/.zcode。
 * - MCP 挂载（对齐 codex M2 + 部署运维轮 hostTools）：进程内平台工具台
 *   （platform/git/host/kb/audit）经共享 McpHttpBridge 以 Streamable HTTP 形态
 *   喂给 session/create 原生 mcpServers 参数；连接器 stdio/http 原样透传。
 *   审批门在桥级静态拒绝（force 门任何模式、非 force 门 ask 模式；full_access
 *   豁免非 force 门——与 claude canUseTool 同语义）。
 * - 平台技能物化（G5 收口）：白名单技能每轮物化到 <重定向HOME>/.zcode/skills（ZCode
 *   用户级发现根，bundle resolveDefaultSkillRoots 实证）；agent 级技能（workspace/
 *   .agents/skills）由项目级发现根原生读取，零改动。
 */

/** 会话内 provider 注册 id（provider_config.json 物化时使用，modelSelection 引用） */
const DONGER_ZCODE_PROVIDER_ID = "donger-glm";

/** session/create mcpServers 参数元素（CLI 协议解析形状：stdio 走 command 分支、
 *  其余走 {type,url,headers} 分支；env/headers 均为键值对数组） */
type ZcodeSessionMcpServer =
  | {
      name: string;
      command: string;
      args?: string[];
      env: Array<{ name: string; value: string }>;
    }
  | { name: string; type: string; url: string; headers: Array<{ name: string; value: string }> };

/** 自定义模型必须显式 reasoningLevel（实测缺失报 invalid_model_request），且档位词表
 *  按模型而异（glm-5.3-flash 实测 high ✓ / enabled ✗；glm-4.6 实测 enabled ✓ / high ✗）。
 *  按模型族启发 + DONGER_ZCODE_REASONING_LEVEL 覆盖；不命中回退 enabled（报错可诊断）。 */
const REASONING_LEVEL_BY_MODEL: Array<[RegExp, string]> = [[/flash|highspeed|mini|lite/i, "high"]];

export function resolveReasoningLevel(model: string): string {
  const override = process.env.DONGER_ZCODE_REASONING_LEVEL?.trim();
  if (override) return override;
  for (const [pattern, level] of REASONING_LEVEL_BY_MODEL) {
    if (pattern.test(model)) return level;
  }
  return "enabled";
}

/** ZCode 内置工具注册词表（apps/zcode-cli/packages/core/src/tool/provider-visible-order.ts）。
 *  白名单补集经 toolDenylist 下发，使「白名单外工具」在 ZCode 内部即不可达。 */
const ZCODE_BUILTIN_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

/** 视为具备写能力的工具（mode 启发，与 codex runner 同口径） */
const WRITE_CAPABLE_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);

/** 会话模式解析：白名单全只读 → plan（ZCode 对写操作内部 deny，宿主等不到请求）；
 *  否则 build（只读直通，高危/副作用发 requestPermission）。恒不使用 yolo/auto。 */
export function resolveZcodeMode(allowedTools: string[] | undefined): "plan" | "build" {
  if (allowedTools && !allowedTools.some((tool) => WRITE_CAPABLE_TOOLS.has(tool))) {
    return "plan";
  }
  return "build";
}

/** 白名单补集：内置词表中不在白名单内的工具名（toolDenylist 下发）。
 *  白名单未配置（开放 agent）时不下发——与 claude 引擎「白名单段跳过」语义一致。 */
export function resolveToolDenylist(allowedTools: string[] | undefined): string[] | undefined {
  if (!allowedTools) return undefined;
  const allowed = new Set(allowedTools);
  const denied = ZCODE_BUILTIN_TOOL_NAMES.filter((name) => !allowed.has(name));
  return denied.length > 0 ? [...denied] : undefined;
}

/** MCP 桥级审批门语义（共享 McpHttpBridge 的 gateCheck 注入）：命中审批门的工具在桥内
 *  静态拒绝——zcode 会话内的 requestPermission 通道是否覆盖 MCP 工具未经实证，
 *  fail-closed 优先。分流与平台铁律对齐：force 门任何权限模式不豁免；非 force 门
 *  full_access 放行（与 claude canUseTool 同语义），ask 模式拒绝。 */
export function createMcpGateCheck(
  gates: GateRouter,
  permissionMode?: () => AgentPermissionMode,
  gateAllowCheck?: (toolName: string, input: Record<string, unknown>) => boolean,
): McpGateCheck {
  return (tool, input) => {
    const gated = gates.match(tool, input);
    if (!gated) return undefined;
    // agent 级白名单放行（含 force 门）：判定范围由 orchestrator 侧钩子收窄
    if (gateAllowCheck?.(tool, input)) return undefined;
    if (permissionMode?.() === "full_access" && !gated.force) return undefined;
    return gated;
  };
}

export class ZcodeAgentRunner implements AgentRunner {
  /** 等用户作答 AskUserQuestion 的任务（看门狗豁免判定；与 claude runner 同模式） */
  private readonly pendingUserInputs = new Set<string>();

  constructor(
    private readonly gates: GateRouter,
    private readonly clientFactory: ZcodeConnectionFactory = defaultZcodeConnectionFactory,
    /** 共享 MCP HTTP 桥（进程内工具台 → session/create mcpServers；测试可注入） */
    private readonly bridge: McpHttpBridge = new McpHttpBridge("ZCode"),
  ) {}

  isAwaitingUserInput(taskId: string): boolean {
    return this.pendingUserInputs.has(taskId);
  }

  async *run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    const cwd = resolve(opts.cwd);
    mkdirSync(cwd, { recursive: true });

    // —— 提示链交付（三引擎等价，spec 2026-09-28-agent-app-stewardship-design §4.0）：
    //    claude=preset append、codex=写 AGENTS.md；ZCode 的 workspace 上下文源原生读取
    //    AGENTS.md（NodeContextSourceAdapter）——与 codex runner 同款先例，轮轮覆盖写。
    //    此前本引擎不消费 systemPromptAppend，agent 人设/平台约定/不可信前言/记忆/KB
    //    全不达模型（排障 2026-09-28：「你是干什么的」自认 ZCode 的直接根因）。
    if (opts.systemPromptAppend?.trim()) {
      writeFileSync(join(cwd, "AGENTS.md"), `${opts.systemPromptAppend.trim()}\n`);
    }

    const cliPath = resolveCliPath();
    const runtimeHome = join(resolve(opts.workspaceRoot ?? cwd), ".zcode-home");
    const homeDir = join(runtimeHome, "home");
    const dataDir = join(runtimeHome, "data");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // —— 平台技能物化（G5 收口，specs/2026-10-09-skills-git-hosting-design.md）：
    //    ZCode 技能发现根（bundle 实证 resolveDefaultSkillRoots）：用户级 <HOME>/.zcode/skills
    //    与 <HOME>/.agents/skills（HOME 已重定向 → 每用户隔离，机器技能不可见）；项目级
    //    <workspace>/.agents/skills（agent 级技能原生发现，零改动）。pack 技能在此按白名单
    //    物化（与 codex CODEX_HOME 同一物化器），每轮整根重建防白名单变更残留。
    //    注意 description>1024 字符的技能会被 CLI 整体丢弃（官方文档硬约束）。
    const zcodeSkillsDir = join(homeDir, ".zcode", "skills");
    rmSync(zcodeSkillsDir, { recursive: true, force: true });
    materializeWhitelistedSkills(opts.skills ?? [], opts.pluginPaths ?? [], zcodeSkillsDir);

    // —— GLM key 物化：个人 provider 注册（api-key 明文进配置文件，finally 删除）。
    //    ZCODE_{BUILTIN,PERSONAL}_PROVIDER_CONFIG_FILE 必须成对显式：builtin 侧要求
    //    完整 release 结构，CLI 相对候选在不同安装布局下位置不同，靠探测定位
    //    （resolveBuiltinProviderConfig），缺省补齐在无布局线索时会启动失败（实测）。
    const providerConfigPath = join(dataDir, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(dataDir, ".zcode", "v2"), { recursive: true });
    writeProviderConfig(providerConfigPath, opts.llm);
    const builtinConfigPath = resolveBuiltinProviderConfig(cliPath);

    const mode = resolveZcodeMode(opts.allowedTools);
    const denylist = resolveToolDenylist(opts.allowedTools);

    // —— MCP 装配：进程内工具台经共享 HTTP 桥挂载 + 连接器透传（per-run token 鉴权，
    //    轮末卸载）。session/create 原生消费 mcpServers 参数（CLI 协议运行时日志
    //    zcode_protocol.create_record.mcp_config 实证 paramMcpServerCount）。 ——
    const mcpRunToken = randomUUID();
    const sessionMcpServers = await this.materializeSessionMcpServers(opts, mcpRunToken);

    const env: Record<string, string | undefined> = {
      ...process.env,
      // 状态目录全隔离（实测 HOME/USERPROFILE 重定向覆盖 logging/rollout/exec）；
      // 脱敏沿用平台口径：系统 LLM key 对子进程不可见——ZCode 侧模型 key 走配置文件，
      // 进程 env 不携带任何 LLM 凭证
      HOME: homeDir,
      USERPROFILE: homeDir,
      ZCODE_DATA_BASE_DIR: dataDir,
      ZCODE_SESSION_DB_PATH: join(runtimeHome, "db.sqlite"),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfigPath,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfigPath,
      ZCODE_NO_BROWSER: "1",
      // 平台凭证（pack 声明）照常注入：技能脚本合法消费
      ...opts.credentialsEnv,
    };

    let connection: ZcodeConnection | null = null;
    const eventQueue: RunnerEvent[] = [];
    let wake: (() => void) | null = null;

    const enqueue = (event: RunnerEvent) => {
      eventQueue.push(event);
      wake?.();
    };

    try {
      connection = this.clientFactory(
        { cliPath, cwd, env },
        {
          onSessionEvent: (params) => {
            for (const event of mapSessionEvent(task.id, params)) enqueue(event);
          },
          onRequest: (method, params) =>
            this.handleReverseRequest(task, opts, resolver, method, params),
        },
      );

      // —— 会话建立 + 事件订阅（无需握手，实测直接发请求）——
      const created = await connection.request<{
        session?: { sessionId?: string };
      }>("session/create", {
        workspace: { workspacePath: cwd, workspaceKey: cwd },
        mode,
        ...(denylist ? { toolDenylist: denylist } : {}),
        ...(sessionMcpServers.length > 0 ? { mcpServers: sessionMcpServers } : {}),
      });
      const sessionId = created.session?.sessionId ?? "";
      if (!sessionId) throw new Error("ZCode session/create 未返回 sessionId");
      // 会话生命周期契约（specs/2026-10-08-zcode-session-lifecycle-contract.md §C2/C4）：
      // create 的返回值是协议握手 id，本轮干活的是 resume 目标（无 resume 时才是 create id）。
      // 新 CLI 按会话绑定严格投递事件且 resume 不改绑定——上报/订阅/发送必须全部对准干活
      // id，否则 resume 轮事件全盲（2026-10-08 生产事故：turn.completed 永不到达、任务挂死）。
      const workingSessionId = opts.resume ?? sessionId;
      enqueue({ type: "session_init", taskId: task.id, sessionId: workingSessionId });

      if (opts.resume) {
        // 冷恢复：同 sessionId 重建 runtime（隔离目录 db 按用户持久）；订阅必须晚于
        // resume——会话激活是 subscribe 查找的前置（未持久化在此显性报错走 C3 重试）
        await connection.request("session/resume", {
          sessionId: opts.resume,
          workspace: { workspacePath: cwd, workspaceKey: cwd },
        });
      }

      await connection.request("session/subscribe", {
        sessionId: workingSessionId,
        deliveryKind: "desktop-continuous",
      });

      enqueue({
        type: "llm_input",
        taskId: task.id,
        input: serializeJson({
          prompt: task.prompt,
          engine: "zcode",
          options: {
            cwd,
            model: opts.llm.model,
            sdkType: "zcode",
            mode,
            toolDenylist: denylist,
            resume: opts.resume ?? null,
            providerId: DONGER_ZCODE_PROVIDER_ID,
            reasoningLevel: resolveReasoningLevel(opts.llm.model),
            skills: opts.skills,
            agentPermissionMode: opts.permissionMode?.(),
            workspaceRoot: opts.workspaceRoot,
            capabilityVersion: opts.capabilityVersion,
            credentialKeys: Object.keys(opts.credentialsEnv ?? {}),
            mcpServers: sessionMcpServers.map((s) => s.name),
            note: "zcode 引擎：审批门=反向权限请求（全功能）+桥级静态拒绝（force 门恒拒/非 force 门 ask 拒/full_access 豁免）、AskUserQuestion 桥接、MCP=HTTP 桥挂载+连接器透传、平台技能=白名单物化至 HOME/.zcode/skills、agent 级技能=workspace/.agents/skills 原生发现",
          },
        }),
      });

      const sendAck = await connection.request("session/send", {
        sessionId: workingSessionId,
        content: task.prompt,
        modelSelection: {
          providerId: DONGER_ZCODE_PROVIDER_ID,
          modelId: opts.llm.model,
          options: { reasoningLevel: resolveReasoningLevel(opts.llm.model) },
        },
        ...(denylist ? { toolDenylist: denylist } : {}),
      });
      if (
        sendAck &&
        typeof sendAck === "object" &&
        (sendAck as { accepted?: unknown }).accepted === false
      ) {
        throw new Error("ZCode session/send 被拒绝");
      }

      // —— 事件泵：消费队列直到 result（turn.completed/failed 已映射入队）——
      // 轮级事件停摆守卫（契约 §C5）：全局看门狗在生产关闭（AskUserQuestion 竞态），
      // 订阅错位/引擎挂死曾让轮无限等待（2026-10-08 事故）——send 后长时间零事件即显性
      // fail 本轮，队列不堵。AskUserQuestion 桥接挂起期间合法无事件，豁免（不设闹钟）。
      const stallMs = resolveEventStallMs();
      let lastEventAt = Date.now();
      let stallTimer: NodeJS.Timeout | null = null;
      while (true) {
        const event = eventQueue.shift();
        if (event) {
          lastEventAt = Date.now();
          if (event.type === "result") {
            yield event;
            return;
          }
          yield event;
          continue;
        }
        if (opts.abortSignal?.aborted) throw new Error("任务已取消");
        const remainMs =
          stallMs > 0 ? lastEventAt + stallMs - Date.now() : Number.POSITIVE_INFINITY;
        if (remainMs <= 0 && !this.isAwaitingUserInput(task.id)) {
          throw new Error(
            `zcode 事件流停摆：${Math.round(stallMs / 1000)}s 零事件（订阅错位或引擎挂起），显性失败防无限挂死`,
          );
        }
        const armed = Number.isFinite(remainMs) && !this.isAwaitingUserInput(task.id);
        await new Promise<void>((resolveWake) => {
          wake = () => {
            if (stallTimer) {
              clearTimeout(stallTimer);
              stallTimer = null;
            }
            wake = null;
            resolveWake();
          };
          if (armed) {
            stallTimer = setTimeout(
              () => {
                stallTimer = null;
                wake?.();
              },
              Math.max(1, remainMs),
            );
          }
        });
      }
    } catch (err) {
      // 连接级失败（spawn 失败/协议错误/abort）：显性失败，绝不静默换引擎
      yield {
        type: "result",
        taskId: task.id,
        subtype: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      connection?.close();
      // MCP 挂载轮末卸载（per-run token；URL 失效即不可达，桥实例存续供下一轮复用）
      await this.bridge.unmountAllMcp(mcpRunToken).catch(() => {
        // 卸载失败不掩盖主流程
      });
      // 凭证不落盘残留：provider 配置（含明文 key）轮末即删；状态目录留待 resume 复用
      try {
        if (existsSync(providerConfigPath)) rmSync(providerConfigPath, { force: true });
      } catch {
        // 删除失败不掩盖主流程
      }
    }
  }

  /** 反向请求统一入口：安全兜底原则——未知方法返回空对象，绝不放行权限语义 */
  private handleReverseRequest(
    task: Task,
    opts: RunOptions,
    resolver: ApprovalResolver,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> | unknown {
    if (method === "session/requestRuntimePreferences") {
      // create/send 前必答（不应答 15s 超时 -32022）。问询自动解析关闭：
      // AskUserQuestion 必须真实弹卡给用户（interaction-broker 自动答案分支禁用）
      return {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      };
    }
    if (method === "interaction/requestPermission") {
      return this.handlePermissionRequest(task, opts, resolver, params);
    }
    if (method === "interaction/requestUserInput") {
      return this.handleUserInputRequest(task, opts, params);
    }
    // browser-use 与 CUA（决策点 ②）：ZCode 引擎不开放浏览器操作通道
    if (method === "interaction/browserList") return { browsers: [] };
    if (method === "interaction/browserExecute") {
      return { decision: "deny", reason: "donger 平台未开放浏览器操作（ZCode 引擎）" };
    }
    return {};
  }

  /** 权限反向请求：守卫表（与 claude 同函数）→ 只读豁免 → 门 → full_access → 审批卡 */
  private async handlePermissionRequest(
    task: Task,
    opts: RunOptions,
    resolver: ApprovalResolver,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const toolName = typeof params.toolName === "string" ? params.toolName : "";
    const input =
      params.input && typeof params.input === "object"
        ? (params.input as Record<string, unknown>)
        : {};
    const deny = (reason: string) => ({ decision: "deny", reason });

    if (!toolName) return deny("权限请求缺少工具名");

    // 静态守卫六段与 claude 引擎同函数：白名单/shell git/KB 写/要害路径读/
    // 启动敏感文件/写边界（fail-closed，任何权限模式生效）
    const denial = runStaticToolGuards({ toolName, input, opts });
    if (denial) return deny(denial.message);

    // 只读命令豁免审批门（与 claude 同口径）：三项全净才豁免
    const shellClass =
      toolName === "Bash" && typeof input.command === "string"
        ? classifyShellCommand(input.command)
        : undefined;
    if (shellClass?.readOnly && !shellClass.substitution && !shellClass.egress) {
      return { decision: "allow" };
    }

    const gated = this.gates.match(toolName, input);
    if (!gated) return { decision: "allow" };

    // agent 级白名单放行（含 force 门）：判定范围由 orchestrator 侧钩子收窄
    if (opts.gateAllowCheck?.(toolName, input)) {
      return { decision: "allow" };
    }

    // full_access 豁免审批门（force 门例外，与 claude 同语义）
    if (opts.permissionMode?.() === "full_access" && !gated.force) {
      return { decision: "allow" };
    }

    const summary =
      toolName === "Bash" && typeof input.command === "string"
        ? String(input.command)
        : JSON.stringify(input).slice(0, 500);
    let decision: { approved: boolean; reason?: string };
    try {
      decision = await resolver({
        taskId: task.id,
        gateId: gated.gateId,
        tool: toolName,
        toolUseId: typeof params.toolCallId === "string" ? params.toolCallId : "",
        input,
        summary,
      });
    } catch (err) {
      return deny(err instanceof Error ? err.message : "审批流程异常");
    }
    return decision.approved
      ? { decision: "allow" }
      : { decision: "deny", reason: decision.reason ?? "审批未通过" };
  }

  /** 问询反向请求：AskUserQuestion 桥（questions[] 与 donger 问询卡同构） */
  private async handleUserInputRequest(
    task: Task,
    opts: RunOptions,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const origin =
      params.schema && typeof params.schema === "object"
        ? (params.schema as Record<string, unknown>)
        : {};
    if (origin.interaction === "plan_approval") {
      // ExitPlanMode 的计划确认：donger 未启用计划模式，明确拒绝（fail-closed）
      return { action: "decline", reason: "donger 平台未启用计划模式审批" };
    }
    if (!opts.questionResolver) {
      return { action: "decline", reason: "该会话不支持用户问询" };
    }
    const questions = parseZcodeQuestions(params.questions);
    if (!questions) {
      return { action: "decline", reason: "问询形态不合法" };
    }
    this.pendingUserInputs.add(task.id);
    try {
      const resolution = await opts.questionResolver({
        taskId: task.id,
        toolUseId: typeof params.toolCallId === "string" ? params.toolCallId : "",
        questions,
      });
      const answers: Record<string, string | string[]> = {};
      for (const [question, answer] of Object.entries(resolution.answers)) {
        const multi = questions.find((q) => q.question === question)?.multiSelect === true;
        // 多选的逗号串拆回数组（broker 端以 ", " 连接回选项比对；choice 应答必须回 label）
        answers[question] =
          multi && answer.includes(",") ? answer.split(",").map((s) => s.trim()) : answer;
      }
      const content: Record<string, unknown> = { answers };
      if (resolution.response?.trim()) content.response = resolution.response.trim();
      return { action: "accept", content };
    } catch (err) {
      return {
        action: "decline",
        reason: err instanceof Error ? err.message : "问询失败",
      };
    } finally {
      this.pendingUserInputs.delete(task.id);
    }
  }

  /** MCP 装配：五台进程内工具台（platform/git/host/kb/audit）经共享 HTTP 桥挂载
   *  （桥级审批门静态拒绝见 createMcpGateCheck）；连接器 stdio/http 原样透传。
   *  env/headers 必须是 [{name,value}] 数组——协议解析对缺失字段直接 .map 崩。 */
  private async materializeSessionMcpServers(
    opts: RunOptions,
    runToken: string,
  ): Promise<ZcodeSessionMcpServer[]> {
    const gateCheck = createMcpGateCheck(this.gates, opts.permissionMode, opts.gateAllowCheck);
    const servers: ZcodeSessionMcpServer[] = [];
    for (const sdkTools of [
      opts.platformTools,
      opts.gitPlatformTools,
      opts.hostTools,
      opts.kbTools,
      opts.auditTools,
    ]) {
      if (!sdkTools) continue;
      const url = await this.bridge.mountMcp(
        runToken,
        sdkTools.name,
        sdkTools.instance as never,
        gateCheck,
      );
      servers.push({ name: sdkTools.name, type: "http", url, headers: [] });
    }
    for (const server of (opts.mcpServers ?? []) as McpServerConfig[]) {
      if (server.type === "stdio" && server.command) {
        servers.push({
          name: server.name,
          command: server.command,
          ...(server.args?.length ? { args: server.args } : {}),
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
        });
      } else if (server.url) {
        servers.push({
          name: server.name,
          type: server.type,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        });
      }
    }
    return servers;
  }
}

// —— 协议事件 → RunnerEvent 映射 ——

function mapSessionEvent(taskId: string, params: ZcodeSessionEventParams): RunnerEvent[] {
  const type = params.type;
  const payload = (params.payload ?? {}) as Record<string, unknown>;
  if (type === "model.streaming") {
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    const messageId =
      typeof payload.assistantMessageId === "string" ? payload.assistantMessageId : "stream";
    if (!delta) return [];
    if (kind === "text_delta") return [{ type: "text_delta", taskId, messageId, text: delta }];
    if (kind === "reasoning_delta") {
      return [{ type: "thinking_delta", taskId, messageId, text: delta }];
    }
    return [];
  }
  if (type === "tool.updated") {
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
    if (kind === "scheduled") {
      const tool = typeof payload.toolName === "string" ? payload.toolName : "unknown";
      return [
        {
          type: "tool_use",
          taskId,
          tool,
          input:
            payload.input && typeof payload.input === "object"
              ? (payload.input as Record<string, unknown>)
              : {},
          toolUseId: toolCallId,
        },
      ];
    }
    if (kind === "result") {
      return [
        {
          type: "tool_result",
          taskId,
          toolUseId: toolCallId,
          content: toolResultToText(payload.result),
          isError: false,
        },
      ];
    }
    if (kind === "error") {
      const err = payload.error as { message?: string } | undefined;
      return [
        {
          type: "tool_result",
          taskId,
          toolUseId: toolCallId,
          content: err?.message ?? "工具执行失败",
          isError: true,
        },
      ];
    }
    return [];
  }
  if (type === "turn.completed") {
    const resultType = typeof payload.resultType === "string" ? payload.resultType : "success";
    const response = typeof payload.response === "string" ? payload.response : "";
    if (resultType === "success" || resultType === "cancelled") {
      const events: RunnerEvent[] = [];
      if (response) {
        events.push({ type: "text", taskId, text: response });
        events.push({ type: "llm_output", taskId, output: serializeJson(payload) });
      }
      events.push({
        type: "result",
        taskId,
        subtype: "success",
        result: response || undefined,
        usage: extractUsage(payload),
      });
      return events;
    }
    return [
      {
        type: "result",
        taskId,
        subtype: "error",
        error: response || `ZCode 回合异常结束（${resultType}）`,
        usage: extractUsage(payload),
      },
    ];
  }
  if (type === "turn.failed") {
    const err = payload.error as { message?: string; underlyingErrorMessage?: string } | undefined;
    return [
      {
        type: "result",
        taskId,
        subtype: "error",
        error: err?.message ?? err?.underlyingErrorMessage ?? "ZCode 回合执行失败",
      },
    ];
  }
  return [];
}

/** tool.updated{result} 的 result 对象 → 人读文本（形状宽松：text/content[].text 优先） */
function toolResultToText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object") return String(raw);
  const obj = raw as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (Array.isArray(obj.content)) {
    const text = (obj.content as Array<Record<string, unknown>>)
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return serializeJson(raw);
}

/** turn.completed 的 usage 宽松提取（协议 schema 为 z.unknown；拿不到返回 undefined） */
function extractUsage(payload: Record<string, unknown>): TokenUsage | undefined {
  const raw = payload.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(u.inputTokens) ?? num(u.input_tokens);
  const output = num(u.outputTokens) ?? num(u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadInputTokens:
      num(u.cacheReadTokens) ?? num(u.cache_read_input_tokens) ?? num(u.cached_input_tokens) ?? 0,
    cacheCreationInputTokens: num(u.cacheCreationTokens) ?? num(u.cache_creation_input_tokens) ?? 0,
  };
}

/** ZCode requestUserInput 的 questions[] → donger QuestionItem[]
 *  （options[].label 为应答词表——wire 层 value 已被覆盖为 label）。不合法返回 null。 */
function parseZcodeQuestions(raw: unknown): QuestionItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: QuestionItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.question !== "string" || !e.question.trim()) return null;
    const item: QuestionItem = { question: e.question };
    if (typeof e.header === "string" && e.header.trim()) item.header = e.header;
    if (e.multiSelect === true) item.multiSelect = true;
    if (Array.isArray(e.options)) {
      const options: Array<{ label: string; description?: string }> = [];
      for (const opt of e.options) {
        if (typeof opt !== "object" || opt === null) return null;
        const o = opt as Record<string, unknown>;
        if (typeof o.label !== "string" || !o.label) return null;
        const parsed: { label: string; description?: string } = { label: o.label };
        if (typeof o.description === "string" && o.description) parsed.description = o.description;
        options.push(parsed);
      }
      if (options.length > 0) item.options = options;
    }
    items.push(item);
  }
  return items;
}

/** 用户 GLM key 物化：个人 provider 注册（实测形状——personalModelIds 而非
 *  builtinModelIds，modelConfigRules 键必填，api-key 明文 + anthropic-messages 端点） */
export function writeProviderConfig(path: string, llm: LLMConfig): void {
  const config = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: DONGER_ZCODE_PROVIDER_ID,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: llm.authToken },
              api: { type: "anthropic-messages", baseUrl: llm.baseUrl },
              personalModelIds: [llm.model],
              modelOrder: [llm.model],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
}

/** CLI 入口解析：DONGER_ZCODE_CLI_PATH 指向 zcode.cjs（node 执行）或可执行文件。
 *  未配置时按常见安装位置探测；都未命中抛错（fail-closed，不静默换引擎）。 */
/**
 * 轮级事件停摆阈值（契约 §C5）：send 后零事件超过该值即显性 fail 本轮。0=关闭。
 * 默认 10 分钟（与历史全局看门狗阈值一致）；DONGER_ZCODE_EVENT_STALL_MS 可覆盖。
 */
export function resolveEventStallMs(): number {
  const raw = process.env.DONGER_ZCODE_EVENT_STALL_MS?.trim();
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 600_000;
}

export function resolveCliPath(): string {
  const configured = process.env.DONGER_ZCODE_CLI_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    "C:/Program Files/ZCode/resources/glm/zcode.cjs",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
    join(process.env.USERPROFILE ?? "", ".zcode", "runtime", "bin", "zcode"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 ZCode CLI：请配置 DONGER_ZCODE_CLI_PATH（指向 zcode.cjs 或可执行文件）");
}

/**
 * 内置 provider 配置（builtin）定位：CLI 启动校验要求该文件具备完整 release 结构，
 * 必须用安装自带的原始资产，不能自造。探测顺序：
 * 1. DONGER_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（运维显式覆盖）；
 * 2. <CLI 目录>/provider/zcode-builtin.json（独立 CLI 安装布局）；
 * 3. <CLI 目录>/../config/provider/zcode-builtin.json（桌面版布局，实测本机命中）。
 * 均未命中抛错（fail-closed：ZCode 引擎不可用必须显性失败，不静默换引擎）。
 */
export function resolveBuiltinProviderConfig(cliPath: string): string {
  const explicit = process.env.DONGER_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`DONGER_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向的文件不存在：${explicit}`);
    }
    return explicit;
  }
  const cliDir = dirname(cliPath);
  const candidates = [
    join(cliDir, "provider", "zcode-builtin.json"),
    join(cliDir, "..", "config", "provider", "zcode-builtin.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "未找到 ZCode 内置 provider 配置（zcode-builtin.json）：请安装完整 ZCode CLI，" +
      "或配置 DONGER_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向安装自带的该文件",
  );
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
