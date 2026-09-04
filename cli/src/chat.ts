import { clearLine, createInterface, cursorTo } from "node:readline";
import pc from "picocolors";
import type { ApiError, AttachmentFile, DongerApi } from "./api.js";
import { renderMarkdown } from "./render.js";
import { type ConnStatus, Session, type SessionEvents } from "./session.js";
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

const COMMANDS = [
  "/help",
  "/status",
  "/resume",
  "/agent",
  "/new",
  "/file",
  "/multi",
  "/cancel",
  "/exit",
];

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
  const pendingFiles: AttachmentFile[] = [];
  let conversationId = "";
  // 断言初值保留联合类型：赋值发生在闭包（switchTo）里，字面量 null 会被 TS 收窄成 never
  let currentAgent = null as AgentSummary | null;
  let session = null as Session | null;
  let connState: ConnStatus = "offline";
  let reconnecting = false;
  let lastSigintAt = 0;
  let forceNewOnce = false;
  // TTY 下缓冲流式增量，回合结束统一渲染 markdown（增量无法渲染；非 TTY 保持实时流式原文）
  let streamBuf: string[] | null = null;
  function flushStream(): void {
    if (streamBuf !== null && streamBuf.length > 0) {
      emit(`\n${renderMarkdown(streamBuf.join(""), isTTY)}\n`);
    }
    streamBuf = null;
  }

  const events: SessionEvents = {
    onDelta: (t) => {
      if (isTTY) {
        streamBuf ??= [];
        streamBuf.push(t);
      } else {
        emit(t);
      }
    },
    onPrint: (t) => {
      flushStream();
      emit(`\n${renderMarkdown(t, isTTY)}\n`);
    },
    onApproval: async (gateId, title, summary) => {
      flushStream();
      emit(pc.yellow(`\n🔔 审批门：${title}\n${summary}\n`));
      emit(pc.dim("（60 秒内未响应，后端将取消本次审批）\n"));
      void gateId;
      const ans = (await ask(pc.yellow("通过? [y/N]: "))).trim();
      const approved = /^y/i.test(ans);
      return { approved, reason: approved ? undefined : "CLI 驳回" };
    },
    onCredential: async (items) => {
      flushStream();
      emit(pc.yellow("\n🔑 需要补充凭证：\n"));
      const values: Record<string, string> = {};
      for (const item of items) {
        const hint = item.secret ? pc.dim("（输入不可见）") : "";
        const desc = item.description ? `（${item.description}）` : "";
        values[item.key] = await ask(`${item.label}${desc}${hint}: `, { secret: item.secret });
      }
      return values;
    },
    onRoundEnd: (ok, text) => {
      flushStream();
      emit(ok ? pc.green("\n✅ 完成\n") : pc.red(`\n❌ ${text}\n`));
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

  async function switchTo(target: {
    conversationId: string;
    agent: AgentSummary | null;
  }): Promise<void> {
    session?.stop();
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

  /** 回到未创建态（/new、/agent 切换后） */
  function resetConversation(): void {
    session?.stop();
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
  // 同步到会话状态：ensureConversation/promptText 读的是 currentAgent（此前只在 switchTo 里赋值）
  currentAgent = agent;
  write(pc.dim(`就绪（agent：${agent?.name ?? "默认会话"}），发送首条消息时创建会话\n`));
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
  let multiBuf: string[] | null = null;
  async function sendText(t: string): Promise<void> {
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
    }
  }

  for (;;) {
    const line = await ask(multiBuf ? pc.dim("…multi> ") : promptText());
    if (forceExit || (line === "" && eof)) break;
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
          `${COMMANDS.join("  ")}\n  /status 连接与会话状态  /resume 恢复历史会话  /agent 切换智能体\n  /file <路径> 附加图片/md  /multi 多行输入（. 提交 /q 放弃）  /new 新会话（保留当前智能体）  /cancel 中断  /exit 退出\n`,
        ),
      );
      continue;
    }
    if (t === "/status") {
      emit(
        `后端   ${baseUrl}\n用户   ${meUser.name}（${meUser.role}）\n会话   ${conversationId ? conversationId.slice(0, 8) : "（未创建，发消息时建立）"}\n智能体 ${currentAgent?.name ?? "默认会话"}\n连接   ${session ? connState : "-"}\n`,
      );
      continue;
    }
    if (t === "/agent") {
      agent = await selectAgent();
      resetConversation();
      continue;
    }
    if (t === "/new") {
      // D4 语义：保留当前 agent，下一条消息强制新建（绕过 get-or-create）
      resetConversation();
      forceNewOnce = true;
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
        const title = (c.title || "（无标题）").replace(/\s+/g, " ");
        write(
          pc.dim(
            `  [${i + 1}] ${truncate(title, 40)} ${c.updatedAt.replace("T", " ").slice(0, 16)} ${c.id.slice(0, 8)}\n`,
          ),
        );
      });
      const pick = Number.parseInt((await ask("选择会话编号（回车取消）: ")).trim(), 10);
      const hit =
        Number.isInteger(pick) && pick >= 1 && pick <= sorted.length ? sorted[pick - 1] : undefined;
      if (hit) {
        const targetAgent = hit.agentId ? agent : null;
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
      try {
        await ensureConversation();
        const f = await api.upload(conversationId, t.slice(6).trim());
        pendingFiles.push(f);
        emit(pc.dim(`📎 已附加 ${f.name}（${pendingFiles.length}/5）\n`));
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
    if (t === "/cancel") {
      if (!conversationId) {
        emit(pc.dim("尚无进行中的会话，无需中断\n"));
        continue;
      }
      await api.cancel(conversationId).catch(() => {});
      emit(pc.dim("(已发送中断请求)\n"));
      continue;
    }
    if (t === "/multi") {
      multiBuf = [];
      emit(pc.dim("多行输入模式：逐行粘贴/输入，单独一行 . 提交发送，/q 放弃\n"));
      continue;
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
