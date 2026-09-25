import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * ZCode Protocol stdio 客户端（specs/2026-09-25-zcode-engine-integration.md §3）：
 * `zcode app-server` 的 NDJSON 行协议（JSON-RPC 2.0 形状子集，无需握手）。
 *
 * 双向面：
 * - 宿主 → agent：session/create|subscribe|send|resume|stop 等请求（id 匹配响应）；
 * - agent → 宿主：`session/event` 等通知（事件流）+ `interaction/*`、
 *   `session/requestRuntimePreferences` 反向请求（带 server 侧 id，宿主必须应答，
 *   不应答 15s 超时使 session/create 失败 -32022）。
 */

export interface ZcodeProtocolRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface ZcodeProtocolResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ZcodeProtocolNotification {
  method: string;
  params?: unknown;
}

/** 反向请求（agent → 宿主）的会话事件载荷（session/event 通知的 params） */
export interface ZcodeSessionEventParams {
  type: string;
  eventId?: string;
  sessionId?: string;
  turnId?: string;
  seq?: number;
  timestamp?: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 宿主对反向请求的处理器：返回值作为该请求的 result 应答 */
export type ZcodeReverseHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface ZcodeConnectionHandlers {
  /** 会话事件（session/event 通知） */
  onSessionEvent?: (params: ZcodeSessionEventParams) => void;
  /** 其余通知（state.updated / v4/telemetry 等，观测用） */
  onNotification?: (notification: ZcodeProtocolNotification) => void;
  /**
   * 反向请求统一入口：runtimePreferences / requestPermission / requestUserInput /
   * browserList|Execute / 其余未知方法。实现方必须对未知方法返回安全兜底值
   * （permission→deny），协议层不做二次防护。
   */
  onRequest: ZcodeReverseHandler;
  onStderr?: (chunk: string) => void;
  onExit?: (code: number | null) => void;
}

export interface ZcodeSpawnOptions {
  /** CLI 入口（.cjs/.js 用 node 执行，其余按可执行文件直接 spawn） */
  cliPath: string;
  args?: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  requestTimeoutMs?: number;
}

export interface ZcodeConnection {
  /** 发送请求并等响应；超时/进程退出 reject */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** 发送通知（无 id，不等响应） */
  notify(method: string, params?: unknown): void;
  /** 优雅终止子进程 */
  close(): void;
  /** 子进程退出码（close 后可读） */
  readonly exitCode: number | null;
}

export type ZcodeConnectionFactory = (
  options: ZcodeSpawnOptions,
  handlers: ZcodeConnectionHandlers,
) => ZcodeConnection;

export class ZcodeProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZcodeProtocolError";
  }
}

/** 真实连接：spawn CLI 子进程 + NDJSON 行解析（单测注入假实现不经此路径） */
export function defaultZcodeConnectionFactory(
  options: ZcodeSpawnOptions,
  handlers: ZcodeConnectionHandlers,
): ZcodeConnection {
  const isScript = /\.(cjs|mjs|js)$/i.test(options.cliPath);
  const child: ChildProcess = spawn(
    isScript ? process.execPath : options.cliPath,
    isScript
      ? [options.cliPath, "app-server", ...(options.args ?? [])]
      : ["app-server", ...(options.args ?? [])],
    {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;
  let stderrTail = "";
  let exited = false;

  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  const rejectAll = (err: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  const rl = createInterface({ input: child.stdout ?? process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pending.get(msg.id as number | string);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id as number | string);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string; data?: unknown };
        entry.reject(
          new ZcodeProtocolError(err.message ?? "ZCode protocol error", err.code ?? -1, err.data),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method !== "string") return;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === "session/event") {
      handlers.onSessionEvent?.(params as ZcodeSessionEventParams);
      return;
    }
    if (msg.id !== undefined) {
      // 反向请求：agent 等宿主应答；处理器抛错按 deny 语义回空错误结果由上层兜底
      void Promise.resolve()
        .then(() => handlers.onRequest(msg.method as string, params))
        .then((result) => {
          child.stdin?.write(`${JSON.stringify({ id: msg.id, result: result ?? {} })}\n`);
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          child.stdin?.write(
            `${JSON.stringify({ id: msg.id, result: { decision: "deny", reason } })}\n`,
          );
        });
      return;
    }
    handlers.onNotification?.({ method: msg.method, params });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    handlers.onStderr?.(chunk.toString());
  });
  child.on("exit", (code) => {
    exited = true;
    rejectAll(
      new Error(
        `zcode app-server 已退出（code=${code}）${stderrTail ? `：${stderrTail.slice(-300)}` : ""}`,
      ),
    );
    handlers.onExit?.(code);
  });
  child.on("error", (err) => {
    rejectAll(err);
  });

  return {
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (exited) return Promise.reject(new Error("zcode app-server 已退出"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ZCode 请求超时（${timeoutMs}ms）：${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        child.stdin?.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
      });
    },
    notify(method: string, params?: unknown): void {
      child.stdin?.write(`${JSON.stringify({ method, params: params ?? {} })}\n`);
    },
    close(): void {
      try {
        // session/stop 优雅打断；短宽限后强杀（stdin 关闭也会使 app-server 退出）
        child.stdin?.end();
      } catch {
        // stdin 已关（进程先退出）属正常
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已退出
        }
      }, 500);
    },
    get exitCode(): number | null {
      return child.exitCode;
    },
  };
}
