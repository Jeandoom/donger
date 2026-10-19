/**
 * 断流重放 e2e（spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md M4 验收 9）
 *
 * SSE 帧带单调 id → 浏览器 EventSource 重连自动携带 Last-Event-ID：
 *  1. 断线窗口内的缓冲事件按序重放（id 连续可接上）——结构化事件零丢失；
 *  2. 缺口超出缓冲裁剪线 → stream_resync 让客户端全量补拉；
 *  3. 无 Last-Event-ID 的首连不带重放（行为不变）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { User, UserStore } from "../../src/ports/user-store.js";

// stream 路由走 owner 守卫：会话/用户仓必须可解析（本地免认证 viewer=local）
const CONV = { id: "conv-sse", title: "sse", userId: "local", channelId: "web" };
function convStore(): ConversationStore {
  return {
    async create() { return CONV as never; },
    async get() { return CONV as never; },
    async getLatest() { return CONV as never; },
    async listByUser() { return [CONV as never]; },
    async update(_id, patch) { Object.assign(CONV, patch); },
  };
}
function userStore(): UserStore {
  const u = { id: "local", name: "local", role: "admin", homeDir: mkdtempSync(join(tmpdir(), "donger-sse-u-")), createdAt: "t", updatedAt: "t" } as User;
  return {
    async get(id) { return id === u.id ? u : undefined; },
    async list() { return [u]; },
    async getOrCreateByIdentity() { return u; },
    async isAdminByExternalId() { return false; },
    async findByIdentity() { return undefined; },
    async addIdentity() {}, async getIdentities() { return []; },
    async updateProfile() {}, async updateRole() {}, async updateSidebarPrefs() {},
    async setPasswordCredential() {}, async getPasswordCredential() { return undefined; },
  };
}

interface Frame {
  id?: number;
  type: string;
  data: Record<string, unknown>;
}

/**
 * 原始 SSE 读流：帧解析带 id 行（与浏览器 EventSource 同协议）。
 * 返回前等连接确认帧（空 text 无 id，server 在 subscribeSSE 之后才写）——
 * 保证调用方随后的 send 必然命中已注册的订阅者。
 */
async function subscribeRaw(
  port: number,
  conversationId: string,
  lastEventId?: number,
): Promise<{ frames: Frame[]; close(): void }> {
  const controller = new AbortController();
  const frames: Frame[] = [];
  const headers: Record<string, string> = {};
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversationId}/stream`, {
    signal: controller.signal,
    headers,
  });
  const connected = new Promise<void>((resolve) => {
    const check = (): void => {
      if (frames.some((f) => f.type === "text" && f.data.text === "")) resolve();
      else setTimeout(check, 20);
    };
    check();
  });
  void (async () => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split("\n");
          const idLine = lines.find((l) => l.startsWith("id: "))?.slice(4);
          const dataLine = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine) as Record<string, unknown>;
            frames.push({
              ...(idLine !== undefined ? { id: Number.parseInt(idLine, 10) } : {}),
              type: String(data.type),
              data,
            });
          } catch {
            // 心跳注释行
          }
        }
      }
  })().catch(() => undefined);
  await connected;
  return { frames, close: () => controller.abort() };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("SSE 断流重放（M4 e2e）", () => {
  let web: WebChannel;
  afterEach(async () => {
    await web?.stop();
  });

  async function boot(): Promise<number> {
    web = new WebChannel({
      port: 0,
      workspaceDir: mkdtempSync(join(tmpdir(), "donger-sse-ws-")),
      usageStore: new InMemoryUsageStore(),
      conversationStore: convStore(),
      userStore: userStore(),
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("server not listening");
    return port;
  }

  it("断线窗口事件按序重放：id 连续、结构化事件零丢失", async () => {
    const port = await boot();
    const first = await subscribeRaw(port, "conv-sse");
    // 两条带 id 的广播（首条连接确认空 text 无 id）
    await web.send("conv-sse", { text: "消息一" });
    await web.send("conv-sse", { text: "消息二" });
    await waitFor(() => (first.frames.filter((f) => f.id !== undefined).length >= 2 ? true : undefined));
    const seq1 = first.frames.find((f) => f.data.text === "消息一")?.id;
    const seq2 = first.frames.find((f) => f.data.text === "消息二")?.id;
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    first.close();

    // 断线窗口：再来一条
    await web.send("conv-sse", { text: "断线期间的消息" });

    // 带 Last-Event-ID=2 重连：只重放 seq 3
    const reconnected = await subscribeRaw(port, "conv-sse", seq2);
    await waitFor(() =>
      reconnected.frames.some((f) => f.data.text === "断线期间的消息") ? true : undefined,
    );
    const replayed = reconnected.frames.filter((f) => f.data.text === "断线期间的消息");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.id).toBe(3);
    // 已消费的 seq1/seq2 不重放（恰好一次）
    expect(
      reconnected.frames.filter(
        (f) => f.data.text === "消息一" || f.data.text === "消息二",
      ),
    ).toHaveLength(0);
    reconnected.close();
  });

  it("游标不可接上（服务重启计数重置/缺口超缓冲）→ stream_resync 全量补拉兜底", async () => {
    const port = await boot();
    const first = await subscribeRaw(port, "conv-sse");
    await web.send("conv-sse", { text: "消息A" });
    await waitFor(() => (first.frames.some((f) => f.data.text === "消息A") ? true : undefined));
    first.close();
    await web.send("conv-sse", { text: "消息B" });
    // 游标远超当前 seq（真实场景：服务重启后计数器从 1 重新计数，老客户端 lastId 很大）
    // → replayable 为空 → 不可接上 → resync，客户端全量补拉
    const stale = await subscribeRaw(port, "conv-sse", 100);
    await waitFor(() => (stale.frames.some((f) => f.type === "stream_resync") ? true : undefined));
    const resync = stale.frames.find((f) => f.type === "stream_resync");
    expect(resync?.data.lastSeq).toBe(100);
    stale.close();
  });
});
