import type { AttachmentFile, DongerApi } from "./api.js";
import { classifyEvent } from "./chat-events.js";
import { streamSSE } from "./sse.js";
import type { SSEEvent } from "./types.js";

export type ConnStatus = "connected" | "reconnecting" | "offline";

export interface CredentialItem {
  key: string;
  label: string;
  description?: string;
  secret: boolean;
}

export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
}

export interface SessionEvents {
  onDelta(text: string): void;
  onPrint(text: string): void;
  /** 思考流增量（暗淡实时显示；与 onDelta/onPrint 交替时由消费方负责收行） */
  onThinking?(text: string): void;
  /** 中间过程行（工具调用/失败等） */
  onActivity?(text: string): void;
  /** 审批决策（缺省 = 非交互安全默认：自动驳回） */
  onApproval?(gateId: string, title: string, summary: string): Promise<ApprovalResponse>;
  /** 凭证收集（缺省 = 提交空值，任务将以缺凭证失败） */
  onCredential?(items: CredentialItem[]): Promise<Record<string, string>>;
  onRoundEnd(ok: boolean, text: string): void;
  /** 连接状态变化（reconnecting 携带第几次重试） */
  onStatus?(status: ConnStatus, attempt?: number): void;
}

const BACKOFF_CAP_MS = 30_000;

/** 重连退避：第 n 次 → 1s,2s,4s,…封顶 30s（纯函数，单测覆盖） */
export function nextBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (Math.max(1, attempt) - 1));
}

/** 非交互模式审批默认：安全起见自动驳回（纯函数，单测覆盖） */
export function autoApprovalResponse(): ApprovalResponse {
  return { approved: false, reason: "非交互模式自动驳回" };
}

/** 非交互模式凭证默认：提交空值，任务将以缺凭证失败（纯函数，单测覆盖） */
export function emptyCredentialValues(items: CredentialItem[]): Record<string, string> {
  return Object.fromEntries(items.map((i) => [i.key, ""]));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * 单会话连接层：常驻 SSE 泵 + 断线指数退避重连 + 回合等待。
 * 断线重连成功后，若正处回合等待中则查一次历史判定回合是否已结束（SSE 期间 result 丢失的场景）。
 */
export class Session {
  private readonly aborter = new AbortController();
  private readonly streaming = { messageId: null as string | null };
  private roundWaiter: ((ok: boolean) => void) | null = null;
  private attempt = 0;
  private stopped = false;
  private connStatus: ConnStatus = "offline";
  private connWaiters: Array<() => void> = [];
  private gateName: string | null = null;

  private constructor(
    private readonly api: DongerApi,
    private readonly baseUrl: string,
    private readonly token: string,
    readonly conversationId: string,
    private readonly events: SessionEvents,
  ) {}

  static start(
    api: DongerApi,
    baseUrl: string,
    token: string,
    conversationId: string,
    events: SessionEvents,
  ): Session {
    const s = new Session(api, baseUrl, token, conversationId, events);
    void s.pump();
    return s;
  }

  get status(): ConnStatus {
    return this.connStatus;
  }

  /** 发送一条消息并等待回合结束（result/error）。抛 ApiError 由上层分类展示。 */
  async send(text: string, files?: AttachmentFile[]): Promise<boolean> {
    const done = new Promise<boolean>((resolve) => {
      this.roundWaiter = resolve;
    });
    await this.api.sendMessage(this.conversationId, text, files);
    return done;
  }

  /** 是否有回合在等待中（Ctrl+C 判断中断 vs 退出用） */
  get busy(): boolean {
    return this.roundWaiter !== null;
  }

  /** 当前挂起的人工门（审批/凭证），/status 展示用 */
  get pendingGate(): string | null {
    return this.gateName;
  }

  stop(): void {
    this.stopped = true;
    this.aborter.abort();
  }

  /** 等待 SSE 首次连接成功（超时放行，避免首条消息事件在建立前丢失） */
  connected(timeoutMs = 5000): Promise<void> {
    if (this.connStatus === "connected") return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = (): void => resolve();
      this.connWaiters.push(waiter);
      setTimeout(() => {
        const i = this.connWaiters.indexOf(waiter);
        if (i >= 0) this.connWaiters.splice(i, 1);
        resolve();
      }, timeoutMs);
    });
  }

  private setConn(status: ConnStatus, attempt?: number): void {
    this.connStatus = status;
    this.events.onStatus?.(status, attempt);
    if (status === "connected") {
      for (const w of this.connWaiters.splice(0)) w();
    }
  }

  private async pump(): Promise<void> {
    for (;;) {
      let hadEvents = false;
      try {
        for await (const ev of streamSSE(
          `${this.baseUrl}/api/conversations/${this.conversationId}/stream`,
          this.token,
          this.aborter.signal,
        )) {
          if (!hadEvents) {
            const reconnected = this.attempt > 0;
            this.attempt = 0;
            this.setConn("connected");
            if (reconnected) await this.afterReconnect();
            hadEvents = true;
          }
          await this.handleEvent(ev);
        }
        if (this.stopped) return;
        throw new Error("SSE 流关闭");
      } catch {
        if (this.stopped) return;
        this.attempt += 1;
        this.setConn("reconnecting", this.attempt);
        await sleep(nextBackoffMs(this.attempt), this.aborter.signal);
      }
    }
  }

  /**
   * 重连成功后：若正等待回合结果，说明 SSE 断线期间 result 事件丢了。
   * 消息无时间戳，取最后一聊消息判断：最后一条是 bot → 视为回合已结束。
   */
  private async afterReconnect(): Promise<void> {
    if (!this.roundWaiter) return;
    try {
      const msgs = await this.api.history(this.conversationId);
      const last = msgs.at(-1);
      if (last && last.role === "bot") {
        const waiter = this.roundWaiter;
        this.roundWaiter = null;
        this.events.onRoundEnd(true, "");
        waiter(true);
      }
    } catch {
      // 补拉失败不打断重连流程，继续等 SSE 事件
    }
  }

  private async handleEvent(ev: SSEEvent): Promise<void> {
    const action = classifyEvent(ev, this.streaming);
    switch (action.kind) {
      case "delta":
        this.events.onDelta(action.text);
        break;
      case "thinking":
        this.events.onThinking?.(action.text);
        break;
      case "activity":
        this.events.onActivity?.(action.text);
        break;
      case "print":
        this.events.onPrint(action.text);
        break;
      case "round_end": {
        this.gateName = null;
        this.events.onRoundEnd(action.ok, action.text);
        const waiter = this.roundWaiter;
        this.roundWaiter = null;
        waiter?.(action.ok);
        break;
      }
      case "approval": {
        this.gateName = action.title; // title 已含「审批门：」前缀
        const resp =
          (await this.events.onApproval?.(action.gateId, action.title, action.summary)) ??
          autoApprovalResponse();
        this.gateName = null;
        await this.api
          .respondApproval(action.gateId, resp.approved, resp.reason)
          .catch((e: Error) => this.events.onPrint(`⚠️ 审批提交失败：${e.message}`));
        break;
      }
      case "credential": {
        this.gateName = "凭证输入";
        const values =
          (await this.events.onCredential?.(action.items)) ?? emptyCredentialValues(action.items);
        this.gateName = null;
        await this.api
          .submitCredential(action.reqId, values)
          .catch((e: Error) => this.events.onPrint(`⚠️ 凭证提交失败：${e.message}`));
        break;
      }
      case "ignore":
        break;
    }
  }
}
