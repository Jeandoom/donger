import { clearLine, createInterface, cursorTo } from "node:readline";
import pc from "picocolors";
import type { ApiError, AttachmentFile, DongerApi } from "./api.js";
import { MarkdownStream } from "./markdown-stream.js";
import { renderMarkdown } from "./render.js";
import { type ConnStatus, Session, type SessionEvents } from "./session.js";
import type { AgentSummary, ConversationSummary } from "./types.js";

export const CLI_VERSION = "0.1.0";

export interface ChatOptions {
  api: DongerApi;
  baseUrl: string;
  token: string;
  /** 直接指定 agent（id 或 name）；缺省交互选择 */
  agent?: string;
  /** 直连既有会话（如 tasks optimize 的优化会话），跳过 agent 选择 */
  conversationId?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const COMMANDS = [
  "/help",
  "/status",
  "/tasks",
  "/result",
  "/resume",
  "/agent",
  "/agent-new",
  "/chat",
  "/new",
  "/file",
  "/multi",
  "/cancel",
  "/exit",
];

/** 内置智能体（不入库，后端短路解析）：id → 展示名 */
const BUILTIN_AGENTS: Record<string, string> = {
  "builtin-assist": "AI 生成助手",
  "agent-builder": "Agent Builder",
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 活动行按工具类型着色（PM 评审 C：类型分区） */
function activityLine(text: string): string {
  if (text.startsWith("⚠️")) return pc.red(`· ${text}`);
  const m = /^🔧\s*(\S+)/.exec(text);
  const tool = m?.[1] ?? "";
  let icon = "🔧";
  if (/write|edit|save|skill/i.test(tool)) icon = "✏️";
  else if (/read/i.test(tool)) icon = "📖";
  else if (/bash|execute/i.test(tool)) icon = "⚡";
  else if (/grep|glob|search/i.test(tool)) icon = "🔍";
  const rest = m ? text.slice(m[0].length).trim() : text;
  return pc.dim(`· ${icon} ${m ? `${tool} ${rest}`.trim() : rest}`);
}

const asArr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
const s = (v: unknown): string => (typeof v === "string" ? v : "");

const ATTACH_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "md"]);

/** 内置智能体上下文标记（builtin-assist / agent-builder，id 即后端常量） */
const BUILTIN_ASSIST_ID = "builtin-assist";

/**
 * /resume 作用域过滤（PM 会话隔离）：agent 上下文默认只列该 agent 的会话，
 * 参数 "all"（或 chat 上下文）列全部。倒序截断也在此收口。
 */
export function filterResumeScope(
  list: ConversationSummary[],
  currentAgent: AgentSummary | null,
  arg: string,
): { items: ConversationSummary[]; scope: "agent" | "all" } {
  const sorted = [...list]
    .filter((c) => !c.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (currentAgent && arg !== "all") {
    return {
      items: sorted.filter((c) => c.agentId === currentAgent.id).slice(0, 10),
      scope: "agent",
    };
  }
  return { items: sorted.slice(0, 10), scope: "all" };
}

/**
 * /tasks 作用域过滤：始终只看本人任务（后端 /api/tasks 无用户隔离，CLI 侧自救）；
 * agent 上下文（已有会话）再收窄到当前会话，参数 "all" 解除全部过滤。
 */
export function filterTasksScope(
  tasks: Record<string, unknown>[],
  userId: string,
  conversationId: string,
  arg: string,
): Record<string, unknown>[] {
  if (arg === "all") return tasks;
  return tasks.filter(
    (task) =>
      s(task.requesterId) === userId && (!conversationId || s(task.threadId) === conversationId),
  );
}

/**
 * 解析 /file 参数：「<路径> [提问]」一行直达。
 * 路径含空格时无法与提问区分——仅当首个空格前的 token 以附件扩展名结尾才切分；
 * 其余情况整段视为路径（支持首尾引号）。
 */
export function parseFileArgs(rest: string): { path: string; question: string } {
  const space = rest.indexOf(" ");
  if (space > 0) {
    const head = rest.slice(0, space);
    const ext = head.split(".").pop()?.toLowerCase() ?? "";
    if (ATTACH_EXTS.has(ext)) {
      return { path: head, question: rest.slice(space + 1).trim() };
    }
  }
  const path = rest.replace(/^"(.*)"$/, "$1");
  return { path, question: "" };
}

/**
 * chat REPL（交互式）：TTY 下启用行编辑/补全/草稿保留；
 * 输出走 emit()——先清提示行再输出，回合结束后重绘提示（I1/I2）。
 */
export async function runChat(opts: ChatOptions): Promise<void> {
  const { api, baseUrl, token } = opts;
  const out = opts.output ?? process.stdout;
  const isTTY = out === process.stdout && process.stdout.isTTY === true;
  const write = (s: string): void => {
    out.write(s);
  };

  const rl = createInterface({
    input: opts.input ?? process.stdin,
    output: isTTY ? process.stdout : undefined,
    terminal: isTTY,
    completer: (line: string): [string[], string] => {
      if (!line.startsWith("/")) return [[], line];
      const hit = COMMANDS.filter((c) => c.startsWith(line));
      return [hit.length > 0 ? hit : COMMANDS, line];
    },
  });

  // ── 提示行与输出分离（I1）：输出前清行，输出后重绘提示 + 已输入草稿 ──
  let currentPrompt = "";
  let askPending = false;
  let pendingResolve: ((line: string) => void) | null = null;
  let eof = false;
  let forceExit = false;
  // 本输出突发内提示行是否已清除：流式增量只清一次，否则每片都会擦掉上一片的半行
  let lineCleared = false;

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      if (isTTY) {
        cursorTo(out, 0);
        clearLine(out, 0);
      }
    }
  }

  function clearPromptLine(): void {
    stopSpinner();
    if (isTTY && !lineCleared) {
      cursorTo(out, 0);
      clearLine(out, 0);
      lineCleared = true;
    }
  }

  function emit(s: string): void {
    clearPromptLine();
    write(s);
    atLineStart = s.endsWith("\n");
    if (askPending && isTTY) {
      rl.setPrompt(currentPrompt);
      rl.prompt(true);
      lineCleared = false;
    }
  }

  // ── 运行态 spinner（I2）──
  let spinnerTimer: NodeJS.Timeout | null = null;
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  function startSpinner(): void {
    if (!isTTY) return;
    const start = Date.now();
    let i = 0;
    spinnerTimer = setInterval(() => {
      const frame = FRAMES[i % FRAMES.length]!;
      write(`\r\x1b[2K${pc.dim(`${frame} 思考中 ${Math.floor((Date.now() - start) / 1000)}s`)}`);
      i += 1;
    }, 120);
  }

  // ── 输入：ask 串行队列 + secret 静默输入（D5）──
  let askTail: Promise<unknown> = Promise.resolve();
  function runAsk(prompt: string, secret?: boolean): Promise<string> {
    if (eof) return Promise.resolve("");
    if (secret && isTTY) return askSecret(prompt);
    currentPrompt = prompt;
    askPending = true;
    lineCleared = false;
    // 非 TTY（piped 驱动/脚本）下 readline 不回显提示——补一次输出，否则提问对用户不可见
    if (!isTTY) write(prompt);
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise<string>((resolve) => {
      pendingResolve = resolve;
    }).finally(() => {
      askPending = false;
      pendingResolve = null;
    });
  }
  function ask(prompt: string, opts2?: { secret?: boolean }): Promise<string> {
    const next = askTail.then(() => runAsk(prompt, opts2?.secret));
    askTail = next.catch(() => "");
    return next;
  }

  function askSecret(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      write(prompt);
      const chars: string[] = [];
      const wasRaw = stdin.isRaw;
      const onKey = (buf: Buffer): void => {
        const s = buf.toString();
        if (s === "\r" || s === "\n" || s === "\x03") finish();
        else if (s === "\x7f" || s === "\b") {
          if (chars.length > 0) {
            chars.pop();
            write("\b \b");
          }
        } else if (s >= " ") {
          chars.push(s);
          write("*");
        }
      };
      function finish(): void {
        stdin.removeListener("data", onKey);
        stdin.setRawMode?.(wasRaw ?? false);
        write("\n");
        rl.resume();
        resolve(chars.join(""));
      }
      rl.pause();
      stdin.setRawMode?.(true);
      stdin.on("data", onKey);
    });
  }

  // 消息排队（P0）：任务运行中/boot 未就绪时的输入统一入队，主循环按序处理，不丢弃；
  // 斜杠命令排队后仍按命令执行（不会当聊天消息发给后端），/cancel 例外——立即生效。
  const lineQueue: string[] = [];
  let roundActive = false;

  rl.on("line", (l: string) => {
    const r = pendingResolve;
    if (r) {
      pendingResolve = null;
      askPending = false;
      r(l);
      return;
    }
    const t = l.trim();
    if (roundActive && t.startsWith("/cancel")) {
      void handleCancelNow(t);
      return;
    }
    lineQueue.push(l);
    if (roundActive) {
      emit(pc.dim(`(已排队，当前任务完成后自动处理 · 共 ${lineQueue.length} 条)\n`));
    }
  });
  rl.on("close", () => {
    eof = true;
    const r = pendingResolve;
    pendingResolve = null;
    askPending = false;
    r?.("");
  });

  // ── 会话状态 ──
  const meUser = (await api.me()).user;
  const pendingFiles: AttachmentFile[] = [];
  let conversationId = "";
  // 断言初值保留联合类型：赋值发生在闭包（switchTo）里，字面量 null 会被 TS 收窄成 never
  let currentAgent = null as AgentSummary | null;
  let session = null as Session | null;
  let connState: ConnStatus = "offline";
  let reconnecting = false;
  let lastSigintAt = 0;
  let forceNewOnce = false;
  // 实时流式（增量直出）；markdown 渲染仅用于完整 text 消息（流式内容保真优先）
  let lastPrinted = ""; // 最近的 print 正文：result(error) 常重复同文本，避免双份输出
  let atLineStart = true; // 活动行拼接用：流式文本未换行时先补换行
  let lastTaskId = ""; // 最近一次分派的任务短 id（产物入口衔接用）

  // 流式 markdown 块渲染器（V18）：普通文本直出，代码块/表格闭合成型；非 TTY 直通
  const mdStream = new MarkdownStream(isTTY);

  // 思考流状态：首个 delta 打 💭 前缀，其余暗淡直出；切换到正文/活动行前收行
  let thinkingActive = false;
  const closeThinking = (): void => {
    if (thinkingActive) {
      thinkingActive = false;
      emit("\n");
    }
  };

  const events: SessionEvents = {
    onDelta: (t) => {
      closeThinking();
      emit(mdStream.feed(t));
    },
    onThinking: (t) => {
      if (!thinkingActive) {
        thinkingActive = true;
        emit(`${atLineStart ? "" : "\n"}${pc.dim("💭 ")}`);
      }
      emit(pc.dim(t));
    },
    onActivity: (t) => {
      closeThinking();
      emit(`${atLineStart ? "" : "\n"}${activityLine(t)}\n`);
    },
    onPrint: (t) => {
      closeThinking();
      emit(mdStream.end());
      emit(`\n${renderMarkdown(t, isTTY)}\n`);
      lastPrinted = t;
      // 📨 分派反馈携带任务短 id → 任务完成后衔接产物入口（PM 评审 F）；括号全半角兼容
      const dispatched = t.match(/📨.*[（(]任务\s*([0-9a-f]{8})[）)]/)?.[1];
      if (dispatched) lastTaskId = dispatched;
      // 冷启动引导（PM 评审#5）：无可用智能体时指一条 CLI 侧出路
      if (t.startsWith("🤷")) {
        emit(
          pc.dim(
            "💡 可运行 /agent-new 让 AI 生成助手基于该任务创建智能体（把任务再描述一遍即可）\n",
          ),
        );
      }
    },
    onApproval: async (gateId, title, summary) => {
      // 后端 title 已带「审批门：」前缀，此处只加图标，避免「审批门：审批门：…」
      emit(pc.yellow(`\n🔔 ${title}\n${summary}\n`));
      const lifeCycleGate = gateId === "design" || gateId === "acceptance";
      emit(pc.dim(`（${lifeCycleGate ? "10 分钟" : "60 秒"}内未响应，后端将取消本次审批）\n`));
      const ans = (await ask(pc.yellow("通过? [y/N]: "))).trim();
      const approved = /^y/i.test(ans);
      if (approved) return { approved: true };
      // 驳回带原因：驱动重设计/重执行的关键输入（PM 评审#2）
      const why = (await ask(pc.yellow("驳回原因（回车跳过）: "))).trim();
      return { approved: false, reason: why || "CLI 驳回" };
    },
    onMissingCredentials: async (items) => {
      emit(pc.yellow("\n🔑 当前智能体缺少以下凭证（值仅存你个人账号）：\n"));
      for (const item of items) {
        emit(pc.yellow(`  - ${item.name}(${item.code})  需要键: ${item.keys.join(", ")}\n`));
      }
      emit(pc.dim("   [c] 继续执行（跳过缺失）   [g] 去配置，完成后重试   [x] 取消任务\n"));
      const ans = (await ask(pc.yellow("选择 [c/G/x]: "))).trim().toLowerCase();
      if (ans === "c") return "continue";
      if (ans === "x") return "cancel";
      // g：等用户在另一终端 donger credentials set 配置完成后回车重试；期间输 x 取消
      const again = (await ask(pc.yellow("配置完成后回车重试（输入 x 取消）: "))).trim().toLowerCase();
      if (again === "x") return "cancel";
      return "retry";
    },
    onRoundEnd: (ok, text) => {
      closeThinking();
      emit(mdStream.end());
      if (!ok && text && text === lastPrinted) {
        // 失败正文已随 print 展示（后端 send+pushResult 双通道），只补结束标记
        emit(pc.red("\n❌ 任务失败\n"));
      } else {
        emit(ok ? pc.green("\n✅ 完成\n") : pc.red(`\n❌ ${text}\n`));
      }
      // 产物入口衔接（PM 评审 F）：分派过的任务提示产物查看命令
      if (ok && lastTaskId) emit(pc.dim(`💡 tasks files ${lastTaskId} 查看任务产物\n`));
    },
    onStatus: (st, attempt) => {
      connState = st;
      if (st === "reconnecting") {
        reconnecting = true;
        emit(pc.dim(`\n(连接中断，重连第 ${attempt ?? 1} 次…)\n`));
      } else if (st === "connected" && reconnecting) {
        reconnecting = false;
        emit(pc.dim("(已重连)\n"));
      }
    },
  };

  const promptText = (): string =>
    `${pc.cyan("you")}${currentAgent ? pc.dim(`(${currentAgent.name})`) : ""}${pc.cyan("> ")}`;

  async function loadHistory(id: string): Promise<void> {
    const msgs = await api.history(id).catch(() => []);
    const recent = msgs.slice(-15);
    if (recent.length === 0) return;
    emit(pc.dim(`── 最近 ${recent.length} 条 ──\n`));
    for (const m of recent) {
      emit(pc.dim(`${m.role === "user" ? "  you" : "  bot"}> ${truncate(m.text, 100)}\n`));
    }
  }

  /** 切会话必清的运行态：流式渲染器复位（残余属旧会话，丢弃）、思考行、任务衔接与去重标记 */
  function resetRoundState(): void {
    mdStream.end();
    thinkingActive = false;
    lastPrinted = "";
    lastTaskId = "";
  }

  async function switchTo(target: {
    conversationId: string;
    agent: AgentSummary | null;
  }): Promise<void> {
    session?.stop();
    resetRoundState();
    pendingFiles.length = 0; // 附件与会话绑定（后端校验归属），切会话必须清空
    session = Session.start(api, baseUrl, token, target.conversationId, events);
    conversationId = target.conversationId;
    currentAgent = target.agent;
    await loadHistory(target.conversationId);
    emit(
      pc.dim(
        `已就绪：${currentAgent ? `agent「${currentAgent.name}」` : "默认会话"} ${conversationId.slice(0, 8)}\n`,
      ),
    );
  }

  /** 惰性建会话：boot 不建，首次发消息/传附件才建，避免空会话堆积。forceNew 绕过 get-or-create（/new 语义） */
  async function ensureConversation(forceNew = false): Promise<void> {
    if (conversationId && !forceNew) return;
    const cid =
      currentAgent && !forceNew
        ? await api.agentConversation(currentAgent.id)
        : (await api.createConversation(meUser.id, currentAgent?.id)).id;
    await switchTo({ conversationId: cid, agent: currentAgent });
    await session!.connected();
  }

  /** 回到未创建态（/new、/agent、/chat、/agent-new 切换后） */
  function resetConversation(): void {
    session?.stop();
    resetRoundState();
    session = null;
    conversationId = "";
    pendingFiles.length = 0;
    connState = "offline";
    emit(
      pc.dim(
        `已重置${currentAgent ? `：agent「${currentAgent.name}」` : ""}（发送首条消息时创建新会话）\n`,
      ),
    );
  }

  async function selectAgent(): Promise<AgentSummary | null> {
    const agents = await api.listAgents().catch(() => []);
    if (agents.length === 0) {
      write(pc.dim("尚无 agent，直接使用默认会话（可在 web 或经 AI 生成创建）\n"));
      return null;
    }
    if (agents.length === 1) return agents[0]!;
    agents.forEach((a, i) => {
      write(
        pc.dim(
          `  [${i + 1}] ${a.name}${a._mine ? "" : "（shared）"}${a.description ? ` - ${a.description}` : ""}\n`,
        ),
      );
    });
    for (;;) {
      const ans = (await ask(`选择 agent [1-${agents.length}]，回车用默认会话: `)).trim();
      const n = Number.parseInt(ans, 10);
      if (Number.isInteger(n) && n >= 1 && n <= agents.length) return agents[n - 1]!;
      if (!ans) return null;
      if (ans.startsWith("/")) {
        write(pc.dim("先选择编号或直接回车取消，进入会话后再使用斜杠命令\n"));
        continue;
      }
      write(pc.yellow(`无效编号"${ans}"，请输入 1-${agents.length} 或回车取消\n`));
    }
  }

  /** 短 id 前缀 → 完整任务（按创建时间倒序取首个前缀匹配） */
  async function resolveTaskId(prefix: string): Promise<Record<string, unknown> | undefined> {
    const list = asArr(await api.call("GET", "/api/tasks")).sort((a, b) =>
      s(b.createdAt).localeCompare(s(a.createdAt)),
    );
    return list.find((task) => s(task.id).startsWith(prefix));
  }

  // ── 启动横幅（I8）──
  write(`${pc.bold("donger CLI")} ${pc.dim(`v${CLI_VERSION}`)} → ${baseUrl}\n`);
  write(pc.dim(`用户 ${meUser.name}（${meUser.role}）\n`));
  // 直连既有会话（tasks optimize 的优化会话等）：跳过 agent 选择，直接 attach
  if (opts.conversationId) {
    const list = await api.listConversations(meUser.id).catch(() => []);
    const conv = list.find((c) => c.id === opts.conversationId);
    const convAgentId = conv?.agentId ?? "";
    const convBuiltin = BUILTIN_AGENTS[convAgentId];
    currentAgent = convBuiltin ? { id: convAgentId, name: convBuiltin, _mine: true } : null;
    await switchTo({ conversationId: opts.conversationId, agent: currentAgent });
  } else if (opts.agent && BUILTIN_AGENTS[opts.agent]) {
    // 内置智能体（不入库，后端短路解析）：AI 生成 / Agent Builder 入口
    const builtinName = BUILTIN_AGENTS[opts.agent] ?? opts.agent;
    currentAgent = { id: opts.agent, name: builtinName, _mine: true };
  } else if (opts.agent) {
    const agents = await api.listAgents().catch(() => []);
    const hit = agents.find((a) => a.id === opts.agent || a.name === opts.agent);
    if (hit) {
      currentAgent = hit;
    } else {
      write(pc.yellow(`⚠️ 未找到 agent "${opts.agent}"，使用默认会话\n`));
    }
  } else {
    const agents = await api.listAgents().catch(() => []);
    if (agents.length > 0) {
      write(pc.dim(`已有 ${agents.length} 个 agent，/agent 查看（不选则用默认会话）\n`));
    }
  }
  if (!opts.conversationId) {
    write(pc.dim(`就绪（agent：${currentAgent?.name ?? "默认会话"}），发送首条消息时创建会话\n`));
  }
  write(pc.dim("/help 查看命令 · Ctrl+C 中断任务，连续两次退出\n"));

  function formatError(e: unknown): string {
    const err = e as ApiError;
    if (err?.kind === "auth") {
      return pc.red(`登录已过期或权限不足（${err.message}）→ 请退出后运行 donger login 重新登录\n`);
    }
    if (err?.kind === "network") {
      return pc.red(`${err.message}（确认后端已启动）\n`);
    }
    return pc.red(`${e instanceof Error ? e.message : String(e)}\n`);
  }

  // ── 信号（D3）：生成中=中断任务；空闲=双击退出 ──
  rl.on("SIGINT", () => {
    if (session?.busy) {
      void api
        .cancel(conversationId)
        .catch(() => {})
        .then(() => emit(pc.yellow("(已请求中断当前任务)\n")));
      return;
    }
    const now = Date.now();
    if (now - lastSigintAt < 2000) {
      forceExit = true;
      const r = pendingResolve;
      if (r) {
        pendingResolve = null;
        askPending = false;
        r("/exit");
      }
    } else {
      lastSigintAt = now;
      emit(pc.dim("(再按一次 Ctrl+C 退出)\n"));
    }
  });

  /** /cancel 实现：无参数=中断当前会话任务；带 id 前缀=中断任意运行中任务。回合中输入时立即执行。 */
  async function handleCancelNow(t: string): Promise<void> {
    const targetId = t.slice(7).trim();
    if (!targetId) {
      if (!conversationId) {
        emit(pc.dim("尚无进行中的会话，无需中断\n"));
        return;
      }
      await api.cancel(conversationId).catch(() => {});
      emit(pc.dim("(已发送中断请求)\n"));
      return;
    }
    try {
      const task = (await resolveTaskId(targetId)) as { threadId?: string } | undefined;
      if (!task?.threadId) throw new Error("任务不存在或无关联会话");
      await api.cancel(task.threadId);
      emit(pc.dim(`(已向任务 ${targetId} 发送取消请求)\n`));
    } catch (e) {
      emit(formatError(e));
    }
  }

  // ── 主循环 ──
  let multiBuf: string[] | null = null;
  async function sendText(t: string): Promise<void> {
    roundActive = true;
    try {
      await ensureConversation(forceNewOnce);
      forceNewOnce = false;
      const files = pendingFiles.length > 0 ? [...pendingFiles] : undefined;
      if (files) {
        emit(pc.dim(`📎 携带附件：${files.map((f) => f.name).join("、")}\n`));
      }
      startSpinner();
      await session!.send(t, files);
      pendingFiles.length = 0;
    } catch (e) {
      stopSpinner();
      emit(formatError(e));
    } finally {
      roundActive = false;
    }
  }

  for (;;) {
    // 队列优先：回合中/boot 期间排队的输入先于新输入处理（斜杠命令按命令执行）
    let fromQueue = false;
    let line: string;
    if (lineQueue.length > 0) {
      line = lineQueue.shift() ?? "";
      fromQueue = true;
    } else {
      line = await ask(multiBuf ? pc.dim("…multi> ") : promptText());
    }
    if (forceExit || (line === "" && eof && lineQueue.length === 0)) break;
    const t = line.trim();
    if (multiBuf !== null) {
      // I6 多行输入：逐行累积，单独一行 "." 提交，/q 放弃
      if (t === "/q") {
        multiBuf = null;
        emit(pc.dim("(已放弃多行输入)\n"));
      } else if (t === ".") {
        const text = multiBuf.join("\n").trim();
        multiBuf = null;
        if (text) await sendText(text);
      } else {
        multiBuf.push(line);
      }
      continue;
    }
    if (!t) continue;

    if (t === "/exit") break;
    if (t === "/help") {
      emit(
        pc.dim(
          `${COMMANDS.join("  ")}\n  /tasks [id前缀|all] 任务列表（agent 会话内仅列当前会话）/详情与最终输出  /result <id前缀> 只看任务结果  /cancel [id前缀] 中断当前或指定任务\n  /status 连接与会话状态  /resume 恢复历史会话（agent 内仅列该 agent 的会话，/resume all 查看全部）  /agent 切换智能体  /agent-new 对话式创建 agent  /chat 回到默认会话\n  /file <路径> 附加图片/md  /multi 多行输入（. 提交 /q 放弃）  /new 新会话（保留当前智能体）  /exit 退出\n`,
        ),
      );
      continue;
    }
    if (t === "/status") {
      const gate = session?.pendingGate;
      emit(
        `后端   ${baseUrl}\n用户   ${meUser.name}（${meUser.role}）\n会话   ${conversationId ? conversationId.slice(0, 8) : "（未创建，发消息时建立）"}\n智能体 ${currentAgent?.name ?? "默认会话"}\n范围   ${currentAgent ? `agent「${currentAgent.name}」（/resume、/tasks 仅列该 agent，all 看全部）` : "全部"}\n连接   ${session ? connState : "-"}${gate ? `\n挂起   ${gate}（等待人工响应）` : ""}\n`,
      );
      continue;
    }
    if (t === "/agent") {
      const picked = await selectAgent();
      if (picked === null && currentAgent === null) continue; // 无 agent 可选，保持原状
      currentAgent = picked;
      resetConversation();
      continue;
    }
    if (t === "/agent-new") {
      // 等价顶层命令 donger agent-new：切到内置 assist 对话式创建 agent/skill
      currentAgent = {
        id: BUILTIN_ASSIST_ID,
        name: BUILTIN_AGENTS[BUILTIN_ASSIST_ID]!,
        _mine: true,
      };
      resetConversation();
      continue;
    }
    if (t === "/chat") {
      if (currentAgent === null) {
        emit(pc.dim("已在默认会话（chat 模式）\n"));
        continue;
      }
      currentAgent = null;
      resetConversation();
      continue;
    }
    if (t === "/new") {
      // D4 语义：保留当前 agent，下一条消息强制新建（绕过 get-or-create）
      resetConversation();
      forceNewOnce = true;
      continue;
    }
    if (t === "/resume" || t.startsWith("/resume ")) {
      const arg = t.slice(7).trim();
      const [list, agents] = await Promise.all([
        api.listConversations(meUser.id).catch(() => []),
        api.listAgents().catch(() => []),
      ]);
      // 全量视图需标注归属 agent（含内置）；agent 视图同源冗余，不带
      const nameOf = (id: string): string =>
        BUILTIN_AGENTS[id] ?? agents.find((a) => a.id === id)?.name ?? "";
      const { items: sorted, scope } = filterResumeScope(list, currentAgent, arg);
      if (sorted.length === 0) {
        emit(
          scope === "agent"
            ? pc.dim(
                `agent「${currentAgent?.name}」暂无历史会话；直接发消息创建，或 /resume all 查看全部\n`,
              )
            : pc.dim("（暂无历史会话）\n"),
        );
        continue;
      }
      emit(
        pc.dim(
          scope === "agent"
            ? `── agent「${currentAgent?.name}」的会话（/resume all 查看全部）──\n`
            : "── 全部会话 ──\n",
        ),
      );
      sorted.forEach((c, i) => {
        const title = (c.title || "（无标题）").replace(/\s+/g, " ");
        const owner = scope === "all" ? `${nameOf(c.agentId) || "（默认）"}  ` : "";
        write(
          pc.dim(
            `  [${i + 1}] ${truncate(title, 40)}  ${owner}${c.updatedAt.replace("T", " ").slice(0, 16)} ${c.id.slice(0, 8)}\n`,
          ),
        );
      });
      const pick = Number.parseInt((await ask("选择会话编号（回车取消）: ")).trim(), 10);
      const hit =
        Number.isInteger(pick) && pick >= 1 && pick <= sorted.length ? sorted[pick - 1] : undefined;
      if (hit) {
        // 按会话归属反查 agent（而非「当前选中」），提示行/后续会话才能正确显示；
        // agent 视图下反查结果即当前 agent（列表已按其过滤），幂等
        const targetAgent = hit.agentId
          ? (agents.find((a) => a.id === hit.agentId) ??
            (BUILTIN_AGENTS[hit.agentId]
              ? { id: hit.agentId, name: BUILTIN_AGENTS[hit.agentId]!, _mine: true }
              : null))
          : null;
        await switchTo({ conversationId: hit.id, agent: targetAgent });
      } else {
        emit(pc.yellow("编号无效，已取消恢复（再次 /resume 可重选）\n"));
      }
      continue;
    }
    if (t.startsWith("/file ")) {
      if (pendingFiles.length >= 5) {
        emit(pc.yellow("最多 5 个附件\n"));
        continue;
      }
      const { path: filePath, question } = parseFileArgs(t.slice(6).trim());
      try {
        await ensureConversation();
        const f = await api.upload(conversationId, filePath);
        pendingFiles.push(f);
        emit(pc.dim(`📎 已附加 ${f.name}（${pendingFiles.length}/5）\n`));
        if (question) {
          // 一行直达：/file <路径> <提问> —— 附件随这条消息发送
          await sendText(question);
        }
      } catch (e) {
        emit(formatError(e));
      }
      continue;
    }
    if (t === "/file") {
      emit(
        pc.dim(
          pendingFiles.length > 0
            ? `已附加 ${pendingFiles.length} 个：${pendingFiles.map((f) => f.name).join("、")}\n用法 /file <本地路径>（图片/md，≤2MB，最多 5 个）\n`
            : "用法 /file <本地路径>（图片/md，≤2MB，最多 5 个，随下一条消息发送）\n",
        ),
      );
      continue;
    }
    if (t.startsWith("/cancel")) {
      await handleCancelNow(t);
      continue;
    }
    if (t === "/tasks" || t.startsWith("/tasks ")) {
      const idPrefix = t.slice(6).trim();
      const scopeAll = idPrefix === "all";
      try {
        if (idPrefix && !scopeAll) {
          const task = (await resolveTaskId(idPrefix)) as
            | {
                id: string;
                status: string;
                phase?: string;
                agentId?: string;
                prompt?: string;
                error?: string;
                threadId?: string;
              }
            | undefined;
          if (!task) throw new Error(`未找到任务 "${idPrefix}"`);
          emit(
            pc.dim(
              `任务 ${task.id.slice(0, 8)}  ${task.status}${task.phase ? `/${task.phase}` : ""}${task.agentId ? `  agent ${task.agentId.slice(0, 8)}` : ""}\n`,
            ),
          );
          if (task.error) emit(pc.yellow(`失败原因：${task.error}\n`));
          if (task.threadId) {
            const msgs = (await api.history(task.threadId).catch(() => [])).filter(
              (m) => m.role === "bot" && m.text.trim(),
            );
            const last = msgs.at(-1);
            if (last) emit(`\n${renderMarkdown(last.text, isTTY)}\n`);
          }
        } else {
          const [created, running, done, failed, canceled] = await Promise.all([
            api.call("GET", "/api/tasks?status=created"),
            api.call("GET", "/api/tasks?status=running"),
            api.call("GET", "/api/tasks?status=done"),
            api.call("GET", "/api/tasks?status=failed"),
            api.call("GET", "/api/tasks?status=canceled"),
          ]);
          const all = filterTasksScope(
            [
              ...asArr(running),
              ...asArr(created),
              ...asArr(failed),
              ...asArr(canceled),
              ...asArr(done),
            ],
            meUser.id,
            // 会话收窄只在 agent 上下文生效；chat 模式传空跳过
            currentAgent ? conversationId : "",
            scopeAll ? "all" : "",
          )
            .sort((a, b) => s(b.createdAt).localeCompare(s(a.createdAt)))
            .slice(0, 8);
          if (all.length === 0) {
            emit(
              currentAgent
                ? pc.dim("（当前范围暂无任务；/tasks all 查看全部）\n")
                : pc.dim("（暂无任务）\n"),
            );
            continue;
          }
          if (currentAgent) {
            emit(
              pc.dim(
                `── ${conversationId ? "当前会话" : `agent「${currentAgent.name}」`}的任务（/tasks all 查看全部）──\n`,
              ),
            );
          }
          for (const task of all) {
            const st =
              s(task.status) === "running"
                ? pc.yellow("running ")
                : s(task.status) === "failed"
                  ? pc.red("failed  ")
                  : s(task.status) === "created"
                    ? pc.cyan("created ")
                    : s(task.status) === "canceled"
                      ? pc.dim("canceled")
                      : pc.dim("done    ");
            emit(
              `${st} ${(s(task.phase) || "-").padEnd(8)} ${truncate(s(task.prompt), 36)}  ${pc.dim(s(task.id).slice(0, 8))}\n`,
            );
          }
          emit(
            pc.dim(
              "（/tasks <id前缀> 看详情与最终输出；/result <id前缀> 只看结果；/cancel <id前缀> 取消；/tasks all 查看全部任务）\n",
            ),
          );
        }
      } catch (e) {
        emit(formatError(e));
      }
      continue;
    }
    if (t.startsWith("/result ")) {
      try {
        const task = (await resolveTaskId(t.slice(8).trim())) as
          | { threadId?: string; status?: string; error?: string }
          | undefined;
        if (!task) throw new Error("任务不存在");
        if (task.status === "failed") {
          emit(pc.red(`任务失败：${s(task.error) || "未知原因"}\n`));
          continue;
        }
        const msgs = (await api.history(task.threadId ?? "").catch(() => [])).filter(
          (m) => m.role === "bot" && m.text.trim(),
        );
        const last = msgs.at(-1);
        if (!last) {
          emit(pc.dim("（尚无 bot 输出）\n"));
          continue;
        }
        emit(`\n${renderMarkdown(last.text, isTTY)}\n`);
      } catch (e) {
        emit(formatError(e));
      }
      continue;
    }
    if (t === "/result") {
      emit(pc.dim("用法 /result <任务id前缀>（/tasks 列表可复制）\n"));
      continue;
    }
    if (t === "/multi") {
      multiBuf = [];
      emit(pc.dim("多行输入模式：逐行粘贴/输入，单独一行 . 提交发送，/q 放弃\n"));
      continue;
    }

    if (fromQueue) {
      // 后端 result 事件先于 orchestrator 收尾到达，稍候再发避免 busy 拒绝
      await new Promise((r) => setTimeout(r, 800));
    }
    await sendText(t);
  }
  session?.stop();
  rl.close();
}

/** one-shot 问答（ask 命令）：发消息 → 流式输出 → 回合结束退出。审批自动驳回、凭证提交空值（安全默认）。 */
export async function runAsk(opts: ChatOptions, text: string): Promise<number> {
  const { api } = opts;
  let agent: AgentSummary | undefined;
  if (opts.agent) {
    const agents = await api.listAgents();
    agent = agents.find((a) => a.id === opts.agent || a.name === opts.agent);
    if (!agent) throw new Error(`未找到 agent "${opts.agent}"`);
  }
  const createdDefault = !agent;
  const conversationId = agent
    ? await api.agentConversation(agent.id)
    : (await api.createConversation((await api.me()).user.id)).id;

  const out = opts.output ?? process.stdout;
  const tty = process.stdout.isTTY === true;
  // 断言初值：赋值发生在闭包里，字面量 null 会被 TS 收窄成 never
  let buf = null as string[] | null; // TTY 下缓冲增量，结束后统一渲染
  const session = Session.start(api, opts.baseUrl, opts.token, conversationId, {
    onDelta: (t) => {
      if (tty) {
        if (buf === null) buf = [];
        buf.push(t);
      } else {
        out.write(t);
      }
    },
    onPrint: (t) => {
      if (buf !== null && buf.length > 0) {
        out.write(`\n${renderMarkdown(buf.join(""), tty)}\n`);
        buf = null;
      }
      out.write(`\n${renderMarkdown(t, tty)}\n`);
    },
    onRoundEnd: () => {},
  });
  const ok = await session.send(text);
  session.stop();
  if (buf !== null && buf.length > 0) {
    out.write(`\n${renderMarkdown(buf.join(""), tty)}\n`);
  }
  if (createdDefault) {
    // 一次性问答会话用后即归档，避免空壳堆积
    await api.call("DELETE", `/api/conversations/${conversationId}`).catch(() => {});
  }
  return ok ? 0 : 1;
}
