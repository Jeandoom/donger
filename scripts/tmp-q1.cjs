/* 监听工作流切换：dedup.enabled=true + prompt 切 claim 语义 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const Database = require("better-sqlite3");
const { SignJWT } = require("jose");
const BASE = "https://localhost:3330";
const OWNER = "ea93a449-b49b-4a9c-a226-27f1cf0d3ff3";
const WF_ID = "a17c492e-4473-45ff-ac86-64583a4a7b9f";
const AGENT_ID = "69cb0c5c-bc51-45b0-9d28-dc746ea16bec";

const db = new Database("/db/donger.db", { readonly: true });
const secret = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get().value;
const wf = db.prepare("SELECT data FROM workflows WHERE id=?").get(WF_ID);
const cur = JSON.parse(wf.data);
db.close();

const PROMPT = `你是 TB bug 自动分析助理。当前时间 {{firedAt}}。严格按以下步骤用 teambition-mcp 与 workflow-dedup 工具执行：

1) 监听候选（执行者/参与人/被@ 三路合并）：
   a. task.query TQL：executorId = "6151397de95d2841a594d67b" ORDER BY updated DESC，pageSize=30
   b. task.query TQL：involveMembers = "6151397de95d2841a594d67b" ORDER BY updated DESC，pageSize=30
   两路结果按 taskId 去重合并；只保留 isDone=false 且 updated 在最近 35 分钟内的任务（与 {{firedAt}} 比较）。
   另对每条候选查动态（task.activity，显式传 actions="comment"）：mentions 含 "6151397de95d2841a594d67b"（被 @）的任务不受 updated 窗口限制，一并纳入。
2) 对每个纳入任务：先调 workflow_dedup_claim（key=taskId）——
   - 返回「认领成功」→ 继续处理；
   - 返回「已被认领」→ 跳过（此前轮次已处理）。
   兜底：若任务动态里已有【AI助理回复】开头的评论也跳过（双保险）。
3) 对认领成功的任务：读取标题 content 与描述 note 作为问题上下文，做 bug 分析，结论包含：问题理解 / 可能原因（按可能性排序）/ 建议排查步骤 / 影响面与建议。若信息不足，给出需要补充的信息清单。
4) 回复：用 task_comment 在该任务下写评论，内容必须以「【AI助理回复】」开头，后接分析结论。
   写评论失败时调 workflow_dedup_release（key=taskId）释放，下轮可重试。
5) 输出本轮汇报：处理了哪些任务（编号+taskId）、跳过了哪些及原因；无候选时汇报「本轮无待处理任务」。`;

(async () => {
  const token = await new SignJWT({ jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  const body = {
    ownerId: OWNER,
    name: cur.name,
    description: cur.description ?? undefined,
    eventId: cur.eventId,
    agentId: cur.agentId,
    promptTemplate: PROMPT,
    enabled: cur.enabled,
    permissionMode: cur.permissionMode ?? "full_access",
    notifyPolicy: cur.notifyPolicy ?? undefined,
    dedup: { enabled: true },
  };
  const res = await fetch(`${BASE}/api/workflows/${WF_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  console.log("[workflow-put]", res.status, (await res.text()).slice(0, 150));
})();
