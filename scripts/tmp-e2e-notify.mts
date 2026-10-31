// 一次性 e2e：反馈处理闭环 + notifyPolicy 通知 + 通道语义（跑完即删）
// 前置：服务已起（HTTP 3410 隔离库），web/dist 已构建
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3410";
const DB_PATH = process.env.E2E_DB ?? ".data/e2e-notify.db";
const ADMIN_EMAIL = "admin@e2e.local";
const ADMIN_PASSWORD = "e2e-Passw0rd!";

let failures = 0;
function check(name: string, cond: unknown, detail?: unknown): void {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`,
  );
}
async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, json };
}

async function waitFor(
  name: string,
  fn: () => Promise<boolean>,
  timeoutMs = 150_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) {
        console.log(`PASS ${name}`);
        return true;
      }
    } catch {
      /* 轮询中容错 */
    }
    if (Date.now() > deadline) {
      console.log(`FAIL ${name}（等待超时）`);
      failures += 1;
      return false;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ===== 0. setup admin + 登录 + 自签 userB token =====
const setupStatus = await api(null, "GET", "/api/setup/status");
console.log("setup status:", JSON.stringify(setupStatus.json).slice(0, 120));
if (setupStatus.json?.setupRequired) {
  const r = await api(null, "POST", "/api/setup/admin", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  check("setup admin", r.status === 200 || r.status === 201, r);
}
const login = await api(null, "POST", "/api/auth/login", {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
});
const adminToken: string | undefined = login.json?.token ?? login.json?.accessToken;
check("admin 登录", Boolean(adminToken), login);

const db = new Database(DB_PATH, { readonly: false });
const jwtSecret = (
  db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get() as any
)?.value;
check("读库 jwt_secret", Boolean(jwtSecret));
const userBId = "e2e-user-b";
// users 表形状：data 列存 User JSON（无 name 列）；homeDir 相对 workspace
const nowIso = new Date().toISOString();
db.prepare(
  "INSERT OR IGNORE INTO users (id, staffId, data, role, updatedAt) VALUES (?,?,?,?,?)",
).run(
  userBId,
  null,
  JSON.stringify({
    id: userBId,
    name: "e2e提交人",
    role: "user",
    homeDir: "e2e-user-b",
    createdAt: nowIso,
    updatedAt: nowIso,
  }),
  "user",
  nowIso,
);
db.close();

function selfSign(uid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ jti: crypto.randomUUID(), sub: uid, iat: now, exp: now + 3600 }),
  ).toString("base64url");
  const sig = createHmac("sha256", jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}
const userBToken = selfSign(userBId);
const me = await api(userBToken, "GET", "/api/auth/me");
check(
  "userB 自签 token 鉴权",
  me.status === 200 && Boolean(me.json?.id ?? me.json?.user?.id),
  me,
);

// ===== 1. 资产：测试 agent / 事件 / 工作流（M1 沉淀 + M2 通知一体）=====
const agent = await api(adminToken, "POST", "/api/agents", {
  name: "e2e-沉淀员",
  description: "e2e：立即沉淀反馈结论",
  systemPrompt:
    "你是测试沉淀员。收到消息后立即调用 feedback_add_reply 工具：content 固定为「e2e 自动处理结论：问题已确认并收口」，markStatus=resolved；然后回复一句「已沉淀」。",
  tools: { mode: "whitelist", whitelist: ["mcp__donger-feedback"] },
  skills: [],
  mcpServers: [],
  credentials: [],
  gitRepositories: [],
  connectorIds: [],
  extensionDirectories: [],
});
const agentId = agent.json?.id ?? agent.json?.agent?.id;
check("创建测试 agent", Boolean(agentId), agent);

const ev = await api(adminToken, "POST", "/api/events", {
  name: "e2e-反馈事件",
  type: "system",
  system: { name: "feedback.created" },
});
const eventId = ev.json?.id ?? ev.json?.event?.id;
check("创建 feedback.created 事件", Boolean(eventId), ev);

const wf = await api(adminToken, "POST", "/api/workflows", {
  name: "e2e-反馈闭环",
  eventId,
  agentId,
  permissionMode: "full_access",
  promptTemplate: "{{triggerOutput}}",
  notifyPolicy: {
    enabled: true,
    on: ["success"],
    title: "你的反馈已处理",
    channels: ["inapp"],
    recipients: "correlation",
  },
});
const wfId = wf.json?.id ?? wf.json?.workflow?.id;
check("创建工作流（含 notifyPolicy）", Boolean(wfId), wf);
const en = await api(adminToken, "POST", `/api/workflows/${wfId}/enable`);
check("启用工作流", en.status === 200, en);

// ===== 2. userB 提交反馈 → 全链路 =====
const fb = await api(userBToken, "POST", "/api/feedback", {
  category: "logic",
  content: "e2e：导出按钮点击无反应",
});
const fbId = fb.json?.id ?? fb.json?.feedback?.id;
check("userB 提交反馈", Boolean(fbId), fb);

const runsDone = await waitFor("业务轮+通知轮双双完成", async () => {
  const r = await api(adminToken, "GET", `/api/workflows/${wfId}/runs?limit=20`);
  const runs = r.json?.runs ?? [];
  return runs.filter((x: any) => x.status === "success").length >= 2;
});
if (runsDone) {
  const runs =
    (await api(adminToken, "GET", `/api/workflows/${wfId}/runs?limit=20`)).json?.runs ?? [];
  check(
    "M-runs 恰两行（workflow+notify，通知轮未发完成事件）",
    runs.length === 2,
    runs.map((x: any) => `${x.kind}:${x.status}`),
  );
  check(
    "M2 通知轮 kind=notify success",
    runs.some((x: any) => x.kind === "notify" && x.status === "success"),
  );
  const wfAfter = (await api(adminToken, "GET", `/api/workflows/${wfId}`)).json;
  const wfAfterBody = wfAfter?.workflow ?? wfAfter;
  const mainRun = runs.find((x: any) => x.kind === "workflow");
  check("M2 通知轮不回写 lastRun", wfAfterBody?.lastRunId === mainRun?.id, {
    lastRunId: wfAfterBody?.lastRunId,
    mainRunId: mainRun?.id,
  });

  const replies =
    (await api(adminToken, "GET", `/api/feedback/${fbId}/replies`)).json?.replies ?? [];
  const sysReply = replies.find((x: any) => x.authorRole === "system");
  check("M1 反馈单出现 system 回复", Boolean(sysReply), replies.map((x: any) => x.authorRole));
  check(
    "M1 system 回复内容来自 agent",
    (sysReply?.content ?? "").includes("e2e 自动处理结论"),
    sysReply?.content,
  );
  const fbAfter = (await api(adminToken, "GET", `/api/feedback/${fbId}`)).json;
  const fbBody = fbAfter?.feedback ?? fbAfter;
  check("M1 状态推进 resolved", fbBody?.status === "resolved", fbBody?.status);

  const notifs = (await api(userBToken, "GET", "/api/notifications?limit=20")).json?.items ?? [];
  check(
    "M1 提交人收到 feedback.replied",
    notifs.some((x: any) => x.event === "feedback.replied"),
    notifs.map((x: any) => x.event),
  );
  check(
    "M2 提交人收到 workflow.result_notified",
    notifs.some(
      (x: any) =>
        x.event === "workflow.result_notified" && (x.title ?? "").includes("你的反馈已处理"),
    ),
    notifs.map((x: any) => `${x.event}:${x.title}`),
  );
}

// ===== 3. M3：通道语义 =====
const status = await api(adminToken, "GET", "/api/admin/notifications/status");
check(
  "M3 通道状态含 email",
  status.json?.channels && "email" in status.json.channels,
  status.json?.channels,
);

const prefs = (await api(userBToken, "GET", "/api/notifications/prefs")).json?.groups ?? [];
const taskGroup = prefs.find((g: any) => g.eventGroup === "task");
check(
  "M3 偏好矩阵含 email 列",
  taskGroup && "email" in (taskGroup.channels ?? {}),
  taskGroup?.channels,
);

// 切 email 通道（SMTP 未配置）→ 通知轮应执行成功但投递 skipped
const wfNow = (await api(adminToken, "GET", `/api/workflows/${wfId}`)).json;
const wfBody = wfNow?.workflow ?? wfNow;
const put = await api(adminToken, "PUT", `/api/workflows/${wfId}`, {
  name: wfBody.name,
  description: wfBody.description,
  eventId: wfBody.eventId,
  agentId: wfBody.agentId,
  permissionMode: wfBody.permissionMode,
  promptTemplate: wfBody.promptTemplate,
  notifyPolicy: {
    enabled: true,
    on: ["success"],
    title: "你的反馈已处理",
    channels: ["email"],
    recipients: "correlation",
  },
});
check("M3 PUT notifyPolicy 收 email 通道", put.status === 200, put);
// 站外通道 opt-in：收件人须先启用 email 偏好，否则通知内核直接跳过（不记投递日志）
const prefOn = await api(userBToken, "PUT", "/api/notifications/prefs", {
  eventGroup: "task",
  channel: "email",
  enabled: true,
});
check("M3 启用 userB 的 email 偏好", prefOn.status === 200 || prefOn.status === 201, prefOn);
const fb2 = await api(userBToken, "POST", "/api/feedback", {
  category: "ui",
  content: "e2e 第二条：深色模式下图表不可见",
});
const fb2Id = fb2.json?.id;
check("userB 提交第二条反馈", Boolean(fb2Id), fb2);
const emailSkipped = await waitFor("M3 email 未配置 → 投递日志 skipped", async () => {
  const d = await api(adminToken, "GET", "/api/admin/notifications/deliveries?limit=50");
  const items = d.json?.deliveries ?? [];
  return items.some((x: any) => x.channel === "email" && x.status === "skipped");
});
if (emailSkipped) {
  const d = (
    await api(adminToken, "GET", "/api/admin/notifications/deliveries?limit=50")
  ).json?.deliveries ?? [];
  const row = d.find((x: any) => x.channel === "email");
  check("M3 skipped 原因=通道未配置", (row?.error ?? "").includes("未配置"), row);
}

// SMTP 配置保存/不回显/白名单保存不动 SMTP
const cfgGet = await api(adminToken, "GET", "/api/admin/auth-configs");
check(
  "M3 auth-configs email.smtp 初始 null",
  cfgGet.json?.email?.smtp === null,
  cfgGet.json?.email,
);
const cfgPut = await api(adminToken, "PUT", "/api/admin/auth-configs/email", {
  signupAllowedDomains: [],
  loginEnabled: false,
  smtp: {
    host: "smtp.e2e.local",
    port: 587,
    secure: false,
    username: "u",
    password: "p-e2e",
    from: "d@e2e.local",
  },
});
check("M3 保存 SMTP", cfgPut.status === 200, cfgPut);
const cfgGet2 = await api(adminToken, "GET", "/api/admin/auth-configs");
check(
  "M3 SMTP 回显无密码且有 smtpPasswordSet",
  cfgGet2.json?.email?.smtp?.host === "smtp.e2e.local" &&
    cfgGet2.json?.email?.smtp?.smtpPasswordSet === true &&
    !JSON.stringify(cfgGet2.json.email).includes("p-e2e"),
  cfgGet2.json?.email?.smtp,
);
const cfgPut2 = await api(adminToken, "PUT", "/api/admin/auth-configs/email", {
  signupAllowedDomains: ["example.com"],
  loginEnabled: false,
});
const cfgGet3 = await api(adminToken, "GET", "/api/admin/auth-configs");
check(
  "M3 仅改白名单不误清 SMTP",
  cfgGet3.json?.email?.smtp?.host === "smtp.e2e.local",
  cfgGet3.json?.email?.smtp,
);

// 前端 bundle 特征串
const { readFileSync, readdirSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
function grepDist(dir: string, needles: string[]): Record<string, boolean> {
  const found: Record<string, boolean> = {};
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) Object.assign(found, grepDist(p, needles));
    else if (f.endsWith(".js")) {
      const text = readFileSync(p, "utf8");
      for (const n of needles) if (text.includes(n)) found[n] = true;
    }
  }
  return found;
}
const hits = grepDist("web/dist/assets", ["结果通知", "自动处理", "SMTP 出站", "邮件"]);
check("前端 bundle 含「结果通知」", hits["结果通知"]);
check("前端 bundle 含「自动处理」", hits["自动处理"]);
check("前端 bundle 含「SMTP 出站」", hits["SMTP 出站"]);
check("前端 bundle 含「邮件」通道", hits["邮件"] === true);

console.log(
  failures === 0 ? "\n===== E2E 全部通过 =====" : `\n===== ${failures} 项失败 =====`,
);
process.exit(failures === 0 ? 0 : 1);
