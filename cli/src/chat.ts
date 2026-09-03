import { createInterface } from "node:readline";
import type { DongerApi } from "./api.js";
import { classifyEvent } from "./chat-events.js";
import { streamSSE } from "./sse.js";
import type { AgentSummary } from "./types.js";

export interface ChatOptions {
  api: DongerApi;
  baseUrl: string;
  token: string;
  /** 直接指定 agent（id 或 name）；缺省交互选择 */
  agent?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * chat REPL：选 agent → get-or-create 会话 → 订阅 SSE → 读发消息循环。
 * 斜杠命令：/exit /agent /new /cancel。
 */
export async function runChat(opts: ChatOptions): Promise<void> {
  const out = opts.output ?? process.stdout;
  const rl = createInterface({
    input: opts.input ?? process.stdin,
    output: out === process.stdout ? process.stdout : undefined,
    terminal: false,
  });
  const write = (s: string): void => {
    out.write(s);
  };

  // ask 串行队列：消息输入与审批/凭证提示共用一个 readline，避免并发争抢
  let askTail: Promise<unknown> = Promise.resolve();
  const ask = (prompt: string): Promise<string> => {
    const next = askTail.then(
      () =>
        new Promise<string>((resolve) => {
          rl.question(prompt, resolve);
        }),
    );
    askTail = next.catch(() => {});
    return next;
  };

  const selectAgent = async (preferred?: string): Promise<AgentSummary | undefined> => {
    const agents = await opts.api.listAgents();
    if (preferred) {
      const hit = agents.find((a) => a.id === preferred || a.name === preferred);
      if (hit) return hit;
      write(`⚠️ 未找到 agent "${preferred}"，改用默认会话\n`);
    }
    if (agents.length === 0) return undefined;
    if (agents.length === 1) return agents[0]!;
    agents.forEach((a, i) => {
      write(
        `  [${i + 1}] ${a.name}${a._mine ? "" : "（shared）"}${a.description ? ` - ${a.description}` : ""}\n`,
      );
    });
    const ans = await ask(`选择 agent [1-${agents.length}]，回车用默认会话: `);
    const n = Number.parseInt(ans, 10);
    return Number.isInteger(n) && n >= 1 && n <= agents.length ? agents[n - 1] : undefined;
  };

  let abort = new AbortController();
  let roundWaiter: ((ok: boolean) => void) | null = null;
  const streaming = { messageId: null as string | null };

  /** 启动常驻 SSE 泵：渲染事件、内联处理审批/凭证、回合结束时唤醒主循环 */
  const startPump = (conversationId: string): void => {
    abort = new AbortController();
    void (async () => {
      try {
        for await (const ev of streamSSE(
          `${opts.baseUrl}/api/conversations/${conversationId}/stream`,
          opts.token,
          abort.signal,
        )) {
          const action = classifyEvent(ev, streaming);
          switch (action.kind) {
            case "delta":
              write(action.text);
              break;
            case "print":
              write(`\n${action.text}\n`);
              break;
            case "round_end": {
              write(action.ok ? "\n✅ 完成\n" : `\n❌ ${action.text}\n`);
              roundWaiter?.(action.ok);
              roundWaiter = null;
              break;
            }
            case "approval": {
              write(`\n🔔 审批门：${action.title}\n${action.summary}\n`);
              const ok = /^y/i.test((await ask("通过? [y/N]: ")).trim());
              await opts.api
                .respondApproval(action.gateId, ok, ok ? undefined : "CLI 驳回")
                .catch((e: Error) => write(`⚠️ 审批提交失败：${e.message}\n`));
              break;
            }
            case "credential": {
              write("\n🔑 需要补充凭证：\n");
              const values: Record<string, string> = {};
              for (const item of action.items) {
                values[item.key] = await ask(
                  `${item.label}${item.description ? `（${item.description}）` : ""}: `,
                );
              }
              await opts.api
                .submitCredential(action.reqId, values)
                .catch((e: Error) => write(`⚠️ 凭证提交失败：${e.message}\n`));
              break;
            }
            case "ignore":
              break;
          }
        }
      } catch {
        // SSE 断开（含主动 abort），静默结束
      }
    })();
  };

  /** 切换目标（agent 或默认会话）：停旧泵 → get-or-create → 起新泵，返回会话 ID */
  const startConversation = async (preferred?: string): Promise<string> => {
    abort.abort();
    const agent = await selectAgent(preferred);
    let conversationId: string;
    if (agent) {
      conversationId = await opts.api.agentConversation(agent.id);
      write(`已就绪：agent「${agent.name}」会话 ${conversationId}\n`);
    } else {
      const me = await opts.api.me();
      conversationId = (await opts.api.createConversation(me.user.id)).id;
      write(`已就绪：默认会话 ${conversationId}\n`);
    }
    startPump(conversationId);
    return conversationId;
  };

  let conversationId = await startConversation(opts.agent);
  write("输入消息开始对话；/agent 切换智能体，/new 新会话，/cancel 中断，/exit 退出\n");

  for (;;) {
    const line = (await ask("you> ")).trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/agent" || line === "/new") {
      conversationId = await startConversation();
      continue;
    }
    if (line === "/cancel") {
      await opts.api.cancel(conversationId).catch(() => {});
      continue;
    }
    const done = new Promise<boolean>((resolve) => {
      roundWaiter = resolve;
    });
    await opts.api.sendMessage(conversationId, line);
    await done;
  }
  abort.abort();
  rl.close();
}
