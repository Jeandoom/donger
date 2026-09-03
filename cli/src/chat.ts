import { createInterface, cursorTo, clearLine } from "node:readline";
import pc from "picocolors";
import type { ApiError, DongerApi } from "./api.js";
import { Session, type ConnStatus, type SessionEvents } from "./session.js";
import type { AgentSummary } from "./types.js";

export const CLI_VERSION = "0.1.0";

export interface ChatOptions {
  api: DongerApi;
  baseUrl: string;
  token: string;
  /** 直接指定 agent（id 或 name）；缺省交互选择 */
  agent?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const COMMANDS = ["/help", "/status", "/resume", "/agent", "/new", "/cancel", "/exit"];

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

  function emit(s: string): void {
    stopSpinner();
    if (isTTY) {
      cursorTo(out, 0);
      clearLine(out, 0);
    }
    write(s);
    if (askPending && isTTY) {
      rl.setPrompt(currentPrompt);
      rl.prompt(true);
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

  rl.on("line", (l: string) => {
    const r = pendingResolve;
    if (r) {
      pendingResolve = null;
      askPending = false;
      r(l);
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
  let conversationId = "";
  // 断言初值保留联合类型：赋值发生在闭包（switchTo）里，字面量 null 会被 TS 收窄成 never
  let currentAgent = null as AgentSummary | null;
  let session = null as Session | null;
  let connState: ConnStatus = "offline";
  let reconnecting = false;
  let lastSigintAt = 0;

  const events: SessionEvents = {
    onDelta: (t) => emit(t),
    onPrint: (t) => emit(`\n${t}\n`),
    onApproval: async (gateId, title, summary) => {
      emit(pc.yellow(`\n🔔 审批门：${title}\n${summary}\n`));
      emit(pc.dim("（60 秒内未响应，后端将取消本次审批）\n"));
      void gateId;
      const ans = (await ask(pc.yellow("通过? [y/N]: "))).trim();
      const approved = /^y/i.test(ans);
      return { approved, reason: approved ? undefined : "CLI 驳回" };
    },
    onCredential: async (items) => {
      emit(pc.yellow("\n🔑 需要补充凭证：\n"));
      const values: Record<string, string> = {};
      for (const item of items) {
        const hint = item.secret ? pc.dim("（输入不可见）") : "";
        const desc = item.description ? `（${item.description}）` : "";
        values[item.key] = await ask(`${item.label}${desc}${hint}: `, { secret: item.secret });
      }
      return values;
    },
    onRoundEnd: (ok, text) => emit(ok ? pc.green("\n✅ 完成\n") : pc.red(`\n❌ ${text}\n`)),
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

  async function switchTo(target: {
    conversationId: string;
    agent: AgentSummary | null;
  }): Promise<void> {
    session?.stop();
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

  async function selectAgent(): Promise<AgentSummary | null> {
    const agents = await api.listAgents().catch(() => []);
    if (agents.length === 0) return null;
    if (agents.length === 1) return agents[0]!;
    agents.forEach((a, i) => {
      write(
        pc.dim(
          `  [${i + 1}] ${a.name}${a._mine ? "" : "（shared）"}${a.description ? ` - ${a.description}` : ""}\n`,
        ),
      );
    });
    const ans = (await ask(`选择 agent [1-${agents.length}]，回车用默认会话: `)).trim();
    const n = Number.parseInt(ans, 10);
    return Number.isInteger(n) && n >= 1 && n <= agents.length ? agents[n - 1]! : null;
  }

  async function openDefault(agent: AgentSummary | null): Promise<void> {
    if (agent) {
      await switchTo({ conversationId: await api.agentConversation(agent.id), agent });
    } else {
      await switchTo({
        conversationId: (await api.createConversation(meUser.id)).id,
        agent: null,
      });
    }
  }

  // ── 启动横幅（I8）──
  write(`${pc.bold("donger CLI")} ${pc.dim(`v${CLI_VERSION}`)} → ${baseUrl}\n`);
  write(pc.dim(`用户 ${meUser.name}（${meUser.role}）\n`));
  let agent = await (async (): Promise<AgentSummary | null> => {
    if (opts.agent) {
      const agents = await api.listAgents().catch(() => []);
      const hit = agents.find((a) => a.id === opts.agent || a.name === opts.agent);
      if (hit) return hit;
      write(pc.yellow(`⚠️ 未找到 agent "${opts.agent}"\n`));
      return null;
    }
    return selectAgent();
  })();
  await openDefault(agent);
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

  // ── 主循环 ──
  for (;;) {
    const line = await ask(promptText());
    if (forceExit || (line === "" && eof)) break;
    const t = line.trim();
    if (!t) continue;

    if (t === "/exit") break;
    if (t === "/help") {
      emit(
        pc.dim(
          `${COMMANDS.join("  ")}\n  /status 连接与会话状态  /resume 恢复历史会话  /agent 切换智能体\n  /new 新会话（保留当前智能体）  /cancel 中断当前任务  /exit 退出\n`,
        ),
      );
      continue;
    }
    if (t === "/status") {
      emit(
        `后端   ${baseUrl}\n用户   ${meUser.name}（${meUser.role}）\n会话   ${conversationId.slice(0, 8)}\n智能体 ${currentAgent?.name ?? "默认会话"}\n连接   ${connState}\n`,
      );
      continue;
    }
    if (t === "/agent") {
      agent = await selectAgent();
      await openDefault(agent);
      continue;
    }
    if (t === "/new") {
      // D4 修复：/new 强制新建会话（保留当前 agent），不走 get-or-create
      await openDefault(currentAgent);
      continue;
    }
    if (t === "/resume") {
      const list = await api.listConversations(meUser.id).catch(() => []);
      const sorted = [...list]
        .filter((c) => !c.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 10);
      if (sorted.length === 0) {
        emit(pc.dim("（暂无历史会话）\n"));
        continue;
      }
      sorted.forEach((c, i) => {
        write(
          pc.dim(
            `  [${i + 1}] ${c.title || "（无标题）"} ${c.updatedAt.replace("T", " ").slice(0, 16)} ${c.id.slice(0, 8)}\n`,
          ),
        );
      });
      const pick = Number.parseInt((await ask("选择会话编号（回车取消）: ")).trim(), 10);
      const hit = Number.isInteger(pick) && pick >= 1 && pick <= sorted.length
        ? sorted[pick - 1]
        : undefined;
      if (hit) {
        const targetAgent = hit.agentId ? agent : null;
        await switchTo({ conversationId: hit.id, agent: targetAgent });
      }
      continue;
    }
    if (t === "/cancel") {
      await api.cancel(conversationId).catch(() => {});
      continue;
    }

    startSpinner();
    try {
      await session!.send(t);
    } catch (e) {
      emit(formatError(e));
    }
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
  const conversationId = agent
    ? await api.agentConversation(agent.id)
    : (await api.createConversation((await api.me()).user.id)).id;

  const out = opts.output ?? process.stdout;
  const session = Session.start(api, opts.baseUrl, opts.token, conversationId, {
    onDelta: (t) => out.write(t),
    onPrint: (t) => out.write(`${t}\n`),
    onRoundEnd: () => {},
  });
  const ok = await session.send(text);
  session.stop();
  return ok ? 0 : 1;
}
