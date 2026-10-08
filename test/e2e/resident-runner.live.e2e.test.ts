// 常驻会话 spike（运行时性能轮 §streaming input 常驻·前置实证）：
// 验证 SDK streaming input 在本机（Windows）的四个前提事实，为「常驻会话池」立项提供数据——
//   ① 多轮复用：同一 AsyncIterable 输入流跨多轮 query，CLI 进程不重生（system/init 只出现一次）
//   ② interrupt()：轮级中断进程不倒，下一轮照常可用
//   ③ sessionStore 兼容：镜像双写可回放（load 喂回上下文）
//   ④ 崩溃降级：常驻进程关闭后，one-shot resume（现状语义）仍可用 = 池全灭系统照常
// 门控：E2E_LIVE=1 且 LLM env 可用才真跑（与 cli live e2e 同约定；未配 token 会显式失败而非
// 假绿——spike 的意义就是拿到真话）。每场景 1-2 次 LLM 调用，单场景分钟级。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

const enabled = process.env.E2E_LIVE === "1";

/** 可编程输入流：push 喂下一轮 user 消息，end() 收流（会话进程随之结束） */
function makeInputStream() {
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  const stream: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        yield queue.shift();
      }
    },
  };
  return {
    stream,
    push(text: string): void {
      queue.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      });
      notify?.();
      notify = undefined;
    },
    end(): void {
      ended = true;
      notify?.();
      notify = undefined;
    },
  };
}

/** 内存 SessionStore（镜像双写接收端）：记录 append/load 调用，entries 全量可取 */
function makeMemorySessionStore() {
  const byKey = new Map<string, unknown[]>();
  const calls = { append: 0, load: 0 };
  return {
    calls,
    async append(key: { sessionId: string }, entries: unknown[]): Promise<void> {
      calls.append += 1;
      byKey.set(key.sessionId, [...(byKey.get(key.sessionId) ?? []), ...entries]);
    },
    async load(key: { sessionId: string }): Promise<unknown[] | null> {
      calls.load += 1;
      return byKey.get(key.sessionId) ?? null;
    },
    async listSessions(): Promise<Array<{ sessionId: string; mtime: number }>> {
      return [...byKey.keys()].map((sessionId) => ({ sessionId, mtime: 0 }));
    },
    async listSubkeys(): Promise<string[]> {
      return [];
    },
    async delete(key: { sessionId: string }): Promise<void> {
      byKey.delete(key.sessionId);
    },
    entriesFor(sessionId: string): unknown[] {
      return byKey.get(sessionId) ?? [];
    },
  };
}

/** 结果通道：init/result 计数 + 顺序等待下一个 result */
function makeCollector(iterator: AsyncIterable<unknown>) {
  let inits = 0;
  const results: Array<Record<string, unknown>> = [];
  const waiters: Array<(r: Record<string, unknown>) => void> = [];
  let tailError: unknown;
  const done = (async () => {
    try {
      for await (const msg of iterator) {
        const m = msg as { type?: string; subtype?: string };
        if (m.type === "system" && m.subtype === "init") inits += 1;
        if (m.type === "result") {
          results.push(m as Record<string, unknown>);
          waiters.shift()?.(m as Record<string, unknown>);
        }
      }
    } catch (error) {
      tailError = error;
    }
  })();
  return {
    get inits() {
      return inits;
    },
    get results() {
      return results;
    },
    get tailError() {
      return tailError;
    },
    nextResult(timeoutMs = 180_000): Promise<Record<string, unknown>> {
      const buffered = results[waiters.length];
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 result 超时")), timeoutMs);
        waiters.push((r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
    },
    settled: done,
  };
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!enabled)("常驻会话 spike（streaming input；需 E2E_LIVE=1 + 可用 LLM）", () => {
  it(
    "① 多轮复用：同一输入流两轮问答，进程不重生（init 仅一次）且上下文连续",
    { timeout: 300_000 },
    async () => {
      const input = makeInputStream();
      const collector = makeCollector(input.stream);
      const cwd = mkdtempSync(join(tmpdir(), "donger-resident-"));
      roots.push(cwd);
      query({ prompt: input.stream as never, options: { cwd } });
      input.push("用一句话回答：1+1等于几？");
      const r1 = await collector.nextResult();
      expect(r1.subtype ?? r1.type).toBeDefined();

      input.push("再往后加10，等于几？一句话回答。");
      const r2 = await collector.nextResult();
      const text = `${String(r2.result ?? "")}${JSON.stringify(r2)}`;
      expect(text).toMatch(/11|十一/);
      // 常驻核心证据：两轮共用一个进程 → system/init 只发一次（one-shot 模式每轮各一次）
      expect(collector.inits).toBe(1);

      input.end();
      await collector.settled;
    },
    300_000,
  );

  it(
    "③④ sessionStore 兼容 + 崩溃降级：镜像双写可回放，常驻流关闭后 one-shot resume 仍可用",
    { timeout: 300_000 },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "donger-resident-"));
      roots.push(cwd);
      const store = makeMemorySessionStore();
      const input = makeInputStream();
      const collector = makeCollector(input.stream);
      query({
        prompt: input.stream as never,
        options: { cwd, sessionStore: store as never },
      });
      input.push("记住暗号：芝麻开门。只回复「已记住」。");
      const r1 = await collector.nextResult();
      const sessionId = String(r1.session_id ?? "");
      expect(sessionId).not.toBe("");
      input.end();
      await collector.settled;

      // 镜像双写实锤：常驻段结束后 store 有该 session 的条目
      expect(store.calls.append).toBeGreaterThan(0);
      expect(store.entriesFor(sessionId).length).toBeGreaterThan(0);

      // 崩溃降级 = 现状 one-shot resume 语义：新进程 + resume + 同一 sessionStore，上下文可回放
      const reopen = query({
        prompt: "我刚才让你记住的暗号是什么？只回复暗号本身。",
        options: { cwd, resume: sessionId, sessionStore: store as never },
      });
      let resumed: Record<string, unknown> | undefined;
      for await (const msg of reopen) {
        const m = msg as { type?: string };
        if (m.type === "result") {
          resumed = m as Record<string, unknown>;
          break;
        }
      }
      expect(resumed).toBeDefined();
      expect(`${String(resumed?.result ?? "")}`).toContain("芝麻");
      expect(store.calls.load).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    "② interrupt：轮级中断后进程不倒，下一轮照常可用",
    { timeout: 300_000 },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "donger-resident-"));
      roots.push(cwd);
      const input = makeInputStream();
      const collector = makeCollector(input.stream);
      const q = query({ prompt: input.stream as never, options: { cwd } });

      input.push("从 1 数到 500，每个数字一行，不要省略，不要解释。");
      // 等首轮确实在产出（assistant 流已开）再打断——直接等 result 会等到自然结束
      await new Promise((r) => setTimeout(r, 8_000));
      (q as { interrupt?: () => Promise<void> | void }).interrupt?.();
      // 中断轮也会收口一个 result（subtype 非成功形态不做强约束，消费掉即可）
      await collector.nextResult(90_000);

      // 中断后同进程继续下一轮：能拿到正常 result 即「进程未倒」
      input.push("用一句话回答：3+4等于几？");
      const r2 = await collector.nextResult();
      expect(`${String(r2.result ?? "")}`).toMatch(/7|七/);
      input.end();
      await collector.settled;
    },
    300_000,
  );
});
