// 临时分析脚本 v3：分离 dispatcher 路由轮成本与 agent 轮自身冷启动（只读）。
// 锚点：M=用户消息持久化时刻；播报 bot 消息（如「📨 已分派给…」）= dispatcher 轮结束；
// B=transcript enqueue（agent 进程收消息）；C=dequeue；D=resume 加载后首条新消息；E=首条 llm_output。
import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";

const db = new Database(join(homedir(), ".donger", "donger.db"), { readonly: true });
const T = (s) => new Date(s).getTime();

const entriesByConv = db.prepare(
  "SELECT payload, created_at FROM transcript_entries WHERE conv_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at",
);
const lastUserMsg = db.prepare(
  "SELECT createdAt FROM messages WHERE conversationId=? AND role='user' AND createdAt<=? ORDER BY createdAt DESC LIMIT 1",
);
const botMsgsBetween = db.prepare(
  "SELECT createdAt FROM messages WHERE conversationId=? AND role='bot' AND createdAt>? AND createdAt<=? ORDER BY createdAt ASC LIMIT 1",
);
const audits = db
  .prepare(
    "SELECT conversationId, taskId, type, durationMs, recordedAt FROM audit_events WHERE type IN ('llm_output','result') ORDER BY conversationId, recordedAt",
  )
  .all();

const byTask = new Map();
for (const a of audits) {
  if (!byTask.has(a.taskId)) byTask.set(a.taskId, []);
  byTask.get(a.taskId).push(a);
}

const direct = { cold: [], load: [], first: [] }; // 直发（绑 agent 会话，无 dispatcher）
const routed = { disp: [], cold: [], load: [], first: [] }; // 经 dispatcher
let skipped = 0;
const loadVsSize = [];

for (const [, evs] of byTask) {
  const res = evs.find((e) => e.type === "result" && e.durationMs);
  const firstOut = evs.find((e) => e.type === "llm_output");
  if (!res || !firstOut) {
    skipped++;
    continue;
  }
  const F = T(res.recordedAt);
  const ents = entriesByConv
    .all(res.conversationId, new Date(F - res.durationMs - 5000).toISOString(), res.recordedAt)
    .map((e) => ({ t: T(e.created_at), p: e.payload }));
  const firstMsg = ents.find((e) => e.p.includes('"parentUuid"'));
  if (!firstMsg) {
    skipped++;
    continue;
  }
  const enq = [...ents].reverse().find((e) => e.t <= firstMsg.t && e.p.includes('"operation":"enqueue"'));
  const deq = [...ents].reverse().find((e) => e.t <= firstMsg.t && e.p.includes('"operation":"dequeue"'));
  if (!enq || !deq) {
    skipped++;
    continue;
  }
  const m = lastUserMsg.get(res.conversationId, new Date(enq.t + 2000).toISOString());
  if (!m) {
    skipped++;
    continue;
  }
  const M = T(m.createdAt);
  const priorResult = evs.find((e) => e.type === "result" && T(e.recordedAt) < enq.t && T(e.recordedAt) > M);
  if (priorResult) {
    skipped++; // 重试轮剔除
    continue;
  }
  const bot = botMsgsBetween.get(res.conversationId, m.createdAt, new Date(enq.t).toISOString());
  const B = enq.t,
    C = deq.t,
    D = firstMsg.t,
    E = T(firstOut.recordedAt);
  const load = D - C;
  const first = E - D;
  const size = db
    .prepare("SELECT COUNT(*) c FROM transcript_entries WHERE conv_id=? AND created_at < ?")
    .get(res.conversationId, new Date(C).toISOString()).c;
  loadVsSize.push({ size, load });
  if (bot) {
    routed.disp.push(T(bot.createdAt) - M);
    routed.cold.push(B - T(bot.createdAt));
    routed.load.push(load);
    routed.first.push(first);
  } else {
    direct.cold.push(B - M);
    direct.load.push(load);
    direct.first.push(first);
  }
}

function stats(a) {
  if (!a.length) return "n=0";
  const s = [...a].sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `n=${s.length} p10=${p(0.1)} p50=${p(0.5)} p90=${p(0.9)} max=${s[s.length - 1]}`;
}

console.log("跳过(无result/transcript不全/重试):", skipped);
console.log("");
console.log("== 直发轮（绑 agent 会话，无 dispatcher） ==");
console.log("M→B [prepare+spawn+CLI启动]           :", stats(direct.cold), "ms");
console.log("C→D [resume加载+上下文重建]           :", stats(direct.load), "ms");
console.log("D→E [首条LLM消息生成]                 :", stats(direct.first), "ms");
console.log("");
console.log("== dispatcher 路由轮 ==");
console.log("M→播报 [dispatcher整轮(含自身spawn+路由LLM)]:", stats(routed.disp), "ms");
console.log("播报→B [agent轮 prepare+spawn+CLI启动]     :", stats(routed.cold), "ms");
console.log("C→D [resume加载+上下文重建]                :", stats(routed.load), "ms");
console.log("D→E [首条LLM消息生成]                      :", stats(routed.first), "ms");
console.log("");
console.log("== resume 加载耗时 vs 会话已有条目数 ==");
loadVsSize.sort((a, b) => a.size - b.size);
for (const [label, pred] of [
  ["<=20", (s) => s <= 20],
  ["21-50", (s) => s > 20 && s <= 50],
  ["51-100", (s) => s > 50 && s <= 100],
  [">100", (s) => s > 100],
]) {
  const g = loadVsSize.filter((x) => pred(x.size)).map((x) => x.load);
  if (g.length) console.log(label.padStart(5), stats(g));
}
db.close();
