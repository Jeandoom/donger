// Resident session spike（specs/2026-09-12-resident-session-spike.md）：
// A/B 对比同一会话连续两轮的 TTFT 与总耗时——
//   A. 现行 per-turn 模式：每轮独立 query()（spawn + resume 全量重建）
//   B. resident 模式：单 query() + AsyncIterable prompt 常驻，第二轮消息经同一消息流注入
// 需要真实 LLM 端点：E2E_LIVE=1 node scripts/spike-resident-session.mjs
// 环境变量与主服务一致（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / LLM_MODEL）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.E2E_LIVE !== "1") {
  console.error("需要真实 LLM 端点：E2E_LIVE=1 node scripts/spike-resident-session.mjs");
  process.exit(1);
}

const { query } = await import("@anthropic-ai/claude-agent-sdk");

const model = process.env.LLM_MODEL || "glm-4.6";
const cwd = mkdtempSync(join(tmpdir(), "resident-spike-"));
const TURNS = ["用一句话回答：1+1等于几？", "再答一次：3+3等于几？也用一句话。"];
const now = () => performance.now();

/**
 * 逐事件驱动一轮直到 result，返回 {ttft, total, sessionId}。
 * next() 由调用方提供（per-turn 模式传 null：SDK 自迭代）。
 */
async function runTurn(makeIter, label) {
  const iter = makeIter();
  const t0 = now();
  let ttft = null;
  let sessionId;
  for await (const m of iter) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
    if (
      ttft === null &&
      (m.type === "stream_event" || m.type === "assistant" || m.type === "user")
    ) {
      ttft = now() - t0;
    }
    if (m.type === "result") {
      const total = now() - t0;
      console.log(`  ${label}: ttft=${ttft?.toFixed(0) ?? "?"}ms total=${total.toFixed(0)}ms`);
      return { ttft: ttft ?? total, total, sessionId };
    }
  }
  throw new Error(`${label}: 未收到 result`);
}

// ---- A. 现行 per-turn 模式：每轮独立 query（spawn + resume 全量重建）----
console.log(`== A. per-turn 模式（现行架构）model=${model} ==`);
{
  let sessionId;
  for (const [i, text] of TURNS.entries()) {
    const r = await runTurn(
      () =>
        query({
          prompt: text,
          options: {
            cwd,
            model,
            maxTurns: 4,
            env: { ...process.env },
            ...(sessionId ? { resume: sessionId } : {}),
          },
        }),
      `turn${i + 1}`,
    );
    sessionId = r.sessionId;
  }
}

// ---- B. resident 模式：单 query + AsyncIterable prompt，进程跨轮存活 ----
console.log(`== B. resident 模式（单进程常驻）==`);
{
  // 可反复注入的 AsyncIterable prompt：push 入队，iterator 持续消费
  const queue = [];
  let wake = () => {};
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          while (queue.length === 0) await new Promise((r) => (wake = r));
          wake = () => {};
          return { value: queue.shift(), done: false };
        },
      };
    },
  };
  const push = (text) => {
    queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    wake();
  };
  const q = query({
    prompt: stream,
    options: { cwd, model, maxTurns: 4, env: { ...process.env } },
  });
  const sharedIter = q[Symbol.asyncIterator]();
  // 显式拉取直到本轮 result。不用 for-await+break：break 会触发迭代器 return() 语义，
  // 实测会把常驻输出流提前关掉（turn2 next() 返回 undefined）
  const pullUntilResult = async (label, t0) => {
    let ttft = null;
    for (let i = 0; i < 200; i++) {
      const r = await sharedIter.next();
      if (r?.done === true || r?.value === undefined) throw new Error(`${label}: 输出流提前结束`);
      const m = r.value;
      if (ttft === null && (m.type === "stream_event" || m.type === "assistant")) {
        ttft = now() - t0;
      }
      if (m.type === "result") {
        console.log(
          `  ${label}: ttft=${ttft?.toFixed(0) ?? "?"}ms total=${(now() - t0).toFixed(0)}ms`,
        );
        return;
      }
    }
    throw new Error(`${label}: 拉取上限内未收到 result`);
  };
  for (const [i, text] of TURNS.entries()) {
    const t0 = now();
    push(text);
    await pullUntilResult(`turn${i + 1}`, t0);
  }
  q.close();
}
console.log(
  "结论：对比 turn2 的 ttft/total——resident 省去 spawn + resume 全量重建，二轮起应显著低于 per-turn。",
);
