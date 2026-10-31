/**
 * 技术验证 spike（spec 2026-10-27-platform-message-subscription-design §技术验证）：
 * 1) 生产库 module_configs.dingtalk 读取+解密（复用 SqliteModuleConfigStore）
 * 2) gettoken 实测
 * 3) POST /v1.0/robot/groupMessages/send 权限探测（假 openConversationId，只看 errcode 判权限/参数）
 * 4) 基线对照：oToMessages/batchSend（生产已用，应报参数错误而非权限错误）
 * 5) `--stream-dump[=秒数]`：短连 Stream 收群消息回调并打字段（验证群 conversationId 是否即
 *    openConversationId——RobotMessageBase 类型缺该字段）。⚠️ 运行期间与生产通道分流，
 *    时间窗内消息可能被本进程抢收，生产收不到；默认 60 秒，选无人用机器人的时机跑。
 * 安全：全程不打印 appSecret/token/sessionWebhook；错误体截断，只保留 errcode/errmsg/sub_code。
 */
import Database from "better-sqlite3";
import { SqliteModuleConfigStore } from "../src/adapters/sqlite-module-config-store.js";
import { getAccessToken } from "../src/util/dingtalk-api.js";

const DB_PATH = "D:/deploy/donger/data/donger.db";
const GROUP_SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
const SINGLE_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

function sanitize(body: unknown): string {
  const j = (body ?? {}) as Record<string, unknown>;
  const pick: Record<string, unknown> = {};
  for (const k of ["errcode", "errmsg", "code", "message", "sub_code", "sub_message", "requestId"]) {
    if (j[k] !== undefined) pick[k] = j[k];
  }
  const s = JSON.stringify(pick);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

/** stream-dump 用的脱敏：敏感键打码、长串截断（conversationId 保留全值——它就是验证对象） */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}…(${v.length})` : v;
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /webhook|token|secret/i.test(k) ? "***" : redact(val, depth + 1);
    }
    return out;
  }
  return v;
}

async function probe(url: string, token: string, payload: Record<string, unknown>, label: string) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON 保留原文截断 */
    }
    console.log(`[${label}] HTTP ${res.status} ${sanitize(body)}`);
  } catch (e) {
    console.log(`[${label}] 请求异常: ${(e as Error).message}`);
  }
}

/** --stream-dump：短连 Stream 收群消息，打脱敏回调字段后退出 */
async function streamDump(cfg: { appKey: string; appSecret: string }, seconds: number) {
  const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream");
  const client = new DWClient({ clientId: cfg.appKey, clientSecret: cfg.appSecret, debug: false });
  client.registerCallbackListener(TOPIC_ROBOT, (msg) => {
    try {
      const robot = JSON.parse(msg.data) as Record<string, unknown>;
      console.log(`[robot-callback] conversationType=${robot.conversationType} msgId=${robot.msgId}`);
      console.log(JSON.stringify(redact(robot), null, 2));
      console.log(
        `[robot-callback] ⬆ conversationId=${robot.conversationId} —— 若群场景下以它调 groupMessages/send 成功，即为 openConversationId`,
      );
    } catch (e) {
      console.log(`[robot-callback] 解析失败: ${(e as Error).message}`);
    }
    client.socketCallBackResponse(msg.headers.messageId, {});
  });
  await client.connect();
  console.log(`[stream] 已连接（分流风险窗口 ${seconds}s，期间生产通道可能收不到消息）… 在测试群 @ 机器人发一条消息`);
  setTimeout(() => {
    client.disconnect();
    console.log("[stream] 时间窗结束，已断开");
    process.exit(0);
  }, seconds * 1000);
}

async function main() {
  const dumpArg = process.argv.find((a) => a.startsWith("--stream-dump"));
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const keyRow = db.prepare("SELECT value FROM app_config WHERE key = 'module_config_secret_key'").get() as
    | { value: string }
    | undefined;
  if (!keyRow) {
    console.log("[config] app_config.module_config_secret_key 不存在");
    return;
  }
  const store = new SqliteModuleConfigStore(db, keyRow.value);
  const cfg = store.getDingTalk();
  if (!cfg) {
    console.log("[config] dingtalk 配置不存在或解密失败");
    return;
  }
  console.log(
    `[config] dingtalk 就绪: appKey=${cfg.appKey.slice(0, 4)}*** robotCode=${cfg.robotCode ? `${cfg.robotCode.slice(0, 4)}***` : "(空)"}`,
  );

  if (dumpArg) {
    const seconds = Number(dumpArg.split("=")[1]) || 60;
    await streamDump(cfg, seconds);
    return;
  }

  let token: string;
  try {
    token = await getAccessToken(cfg.appKey, cfg.appSecret);
    console.log("[gettoken] 成功（token 已缓存，不打印）");
  } catch (e) {
    console.log(`[gettoken] 失败: ${(e as Error).message}`);
    return;
  }

  // 群回复 API 权限探测：假 openConversationId → 期望「参数/会话不存在」而非「无权限」
  await probe(GROUP_SEND_URL, token, {
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: "spike" }),
    openConversationId: "cidSpikeInvalid00000000",
    robotCode: cfg.robotCode ?? cfg.appKey,
  }, "groupMessages/send");

  // 基线：生产在用的单聊发送，假 staffId → 应报参数错误（证明错误形态可比对）
  await probe(SINGLE_SEND_URL, token, {
    robotCode: cfg.robotCode ?? cfg.appKey,
    userIds: ["spikeInvalidStaffId"],
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: "spike" }),
  }, "oToMessages/batchSend 基线");

  db.close();
}

main().catch((e) => {
  console.error("spike 失败:", (e as Error).message);
  process.exit(1);
});
