import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteEventFiringStore } from "../../src/adapters/sqlite-event-firing-store.js";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { buildFeedbackCreatedPayload } from "../../src/domain/event-payloads.js";
import type { NotificationIntent } from "../../src/domain/notification.js";
import type { WorkflowInput } from "../../src/domain/workflow.js";
import { EventDispatcher } from "../../src/orchestrator/event-dispatcher.js";
import { SystemEventDispatcher } from "../../src/orchestrator/system-event-dispatcher.js";

const logger = pino({ level: "silent" });

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const FEEDBACK_CTX = buildFeedbackCreatedPayload({
  id: "fb-7",
  category: "ui",
  status: "open",
  content: "按钮失灵",
  submitterId: "submitter-7",
  submitterName: "提交人",
  imageCount: 0,
  createdAt: "2026-10-20T00:00:00Z",
});

interface Setup {
  workflowStore: SqliteWorkflowStore;
  runStore: SqliteWorkflowRunStore;
  dispatcher: EventDispatcher;
  handleMessage: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  feedbackStore: { get: ReturnType<typeof vi.fn>; listReplies: ReturnType<typeof vi.fn>; addReply: ReturnType<typeof vi.fn> };
  sourceDeliver: ReturnType<typeof vi.fn>;
}

function setup(over: { handleMessageError?: Error } = {}): Setup {
  const db = new Database(":memory:");
  const eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const runStore = new SqliteWorkflowRunStore(db);
  runStore.migrate();
  const firingStore = new SqliteEventFiringStore(db);
  firingStore.migrate();
  const handleMessage = over.handleMessageError
    ? vi.fn().mockRejectedValue(over.handleMessageError)
    : vi.fn().mockResolvedValue("conv-x");
  const notify = vi.fn().mockResolvedValue({});
  const feedbackStore = {
    get: vi.fn().mockResolvedValue({ id: "fb-7", userId: "submitter-7", status: "accepted" }),
    listReplies: vi.fn().mockResolvedValue([]),
    addReply: vi.fn().mockResolvedValue(undefined),
  };
  const sourceDeliver = vi.fn().mockResolvedValue(undefined);
  const dispatcher = new EventDispatcher({
    eventStore,
    workflowStore,
    runStore,
    firingStore,
    orchestrator: { handleMessage },
    conversationStore: { createWithAgent: vi.fn().mockResolvedValue({ id: "conv-x" }) },
    logger,
    messageStore: {
      add: vi.fn().mockResolvedValue({}),
      listByConversation: vi.fn().mockResolvedValue([{ role: "bot", text: "通知正文" }]),
    },
    notifications: { notify } as never,
    feedbackStore: feedbackStore as never,
    // source 回源通道（spec 2026-10-27-platform-message-subscription-design §4.4）
    sourceDeliver,
  });
  const systemEvents = new SystemEventDispatcher({ eventStore, dispatcher, logger });
  dispatcher.setSystemEventSink(systemEvents);
  return { workflowStore, runStore, dispatcher, handleMessage, notify, feedbackStore, sourceDeliver };
}

function baseInput(over: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    ownerId: "admin-1",
    name: "反馈处理",
    eventId: "",
    agentId: "a1",
    promptTemplate: "{{triggerOutput}}",
    enabled: true,
    ...over,
  };
}

async function notifyRunOf(s: Setup, workflowId: string) {
  const runs = await s.runStore.listRuns(workflowId, { limit: 20 });
  return runs.find((r) => r.kind === "notify");
}

describe("notifyPolicy 通知执行器（M2，manualRun 全链路）", () => {
  it("success 命中 + correlation 收件人：派生 notify 轮 → 写手产出 → 站内信投递提交人；lastRun 停在业务轮", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          title: "你的反馈已处理",
          recipients: "correlation",
          channels: ["inapp"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: FEEDBACK_CTX });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");

    // 写手轮：prompt 携带上游结论与反馈号，权限模式跟随工作流
    expect(s.handleMessage).toHaveBeenCalledTimes(2);
    const writerMsg = s.handleMessage.mock.calls[1]?.[0] as {
      text: string;
      unattended: boolean;
      permissionMode: string;
      feedbackCorrelation?: { feedbackId: string };
    };
    expect(writerMsg.unattended).toBe(true);
    // 上游结论=主 run 最终 bot 回复（messageStore mock 文本）
    expect(writerMsg.text).toContain("通知正文");
    expect(writerMsg.text).toContain("fb-7");
    // correlation 结构化透传（2026-10-26 反馈回复断链修复）：写手轮挂 donger-feedback 的依据
    expect(writerMsg.feedbackCorrelation).toEqual({ feedbackId: "fb-7" });

    // 投递：站内信给因果提交人（calls 另含主 run 自身的 loop.run_succeeded）
    const intent = s.notify.mock.calls
      .map((c) => c[0] as NotificationIntent)
      .find((i) => i.event === "workflow.result_notified");
    expect(intent).toBeDefined();
    expect(intent.event).toBe("workflow.result_notified");
    expect(intent.recipients).toEqual([{ kind: "user", userId: "submitter-7" }]);
    expect(intent.title).toBe("你的反馈已处理");
    expect(intent.dedupeKey).toBe(`notify:${nRun!.id}`);

    // 反馈回复兜底：写手未用工具回复 → 平台把通知成稿落为反馈回复（authorRole=system，
    // userId=工作流属主）；提交人≠属主时随发 feedback.replied 站内信
    await waitFor(() => s.feedbackStore.addReply.mock.calls.length > 0);
    const reply = s.feedbackStore.addReply.mock.calls[0]?.[0] as {
      feedbackId: string;
      authorRole: string;
      userId: string;
      content: string;
    };
    expect(reply.feedbackId).toBe("fb-7");
    expect(reply.authorRole).toBe("system");
    expect(reply.userId).toBe("admin-1");
    expect(reply.content).toContain("通知正文");
    const replied = s.notify.mock.calls
      .map((c) => c[0] as NotificationIntent)
      .find((i) => i.event === "feedback.replied");
    expect(replied?.recipients).toEqual([{ kind: "user", userId: "submitter-7" }]);
    expect(replied?.dedupeKey).toContain("fb-7");

    // lastRun 停在业务轮；notify 轮不发完成事件（库中仅两行，无第三轮）
    const wfAfter = await s.workflowStore.get(wf.id);
    expect(wfAfter?.lastRunId).toBe(mainRun.id);
    expect((await s.runStore.listRuns(wf.id, { limit: 20 })).length).toBe(2);
  });

  it("recipients=owner：通知发工作流属主；写手指令缺省模板", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: { enabled: true, on: ["success"], recipients: "owner" },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: "普通定时上下文" });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");
    // calls[0] 是主 run 自身的 loop.run_succeeded；结果通知另起一条
    const intent = s.notify.mock.calls
      .map((c) => c[0] as NotificationIntent)
      .find((i) => i.event === "workflow.result_notified");
    expect(intent?.recipients).toEqual([{ kind: "user", userId: "admin-1" }]);
    expect(intent?.title).toContain("结果通知");
  });

  it("correlation 收件人但载荷无因果键：notify 轮直接 failed，不跑写手不投递", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: { enabled: true, on: ["success"], recipients: "correlation" },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: "定时触发的普通载荷" });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "failed");
    expect(nRun?.error).toContain("无法解析收件人");
    expect(s.handleMessage).toHaveBeenCalledTimes(1);
    // 工作流自身成功会发 loop.run_succeeded 给 owner；结果通知（result_notified）不应发出
    expect(s.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "workflow.result_notified" }),
    );
  });

  it("policy 关闭或终态不命中：不派生 notify 轮", async () => {
    const s = setup();
    const off = await s.workflowStore.create(
      baseInput({ name: "off", notifyPolicy: { enabled: false, on: ["success"] } }) as never,
    );
    const skipped = await s.workflowStore.create(
      baseInput({ name: "skip", notifyPolicy: { enabled: true, on: ["failed"] } }) as never,
    );
    const r1 = await s.dispatcher.manualRun(off.id, { payload: FEEDBACK_CTX });
    const r2 = await s.dispatcher.manualRun(skipped.id, { payload: FEEDBACK_CTX });
    await waitFor(async () => (await s.runStore.getRun(r1.id))?.status === "success");
    await waitFor(async () => (await s.runStore.getRun(r2.id))?.status === "success");
    await new Promise((r) => setTimeout(r, 150));
    expect(await notifyRunOf(s, off.id)).toBeUndefined();
    expect(await notifyRunOf(s, skipped.id)).toBeUndefined();
  });

  it("写手已用工具写反馈回复：兜底不重复落库，结果通知照发", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          title: "已处理",
          recipients: "correlation",
          channels: ["inapp"],
        },
      }) as never,
    );
    // 写手在通知轮运行期间已用 donger-feedback 工具写回复（createdAt ≥ notify startedAt）
    s.feedbackStore.listReplies.mockResolvedValue([
      {
        id: "r-tool",
        feedbackId: "fb-7",
        userId: "admin-1",
        authorRole: "system",
        content: "工具路径写的回复",
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: FEEDBACK_CTX });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");
    await new Promise((r) => setTimeout(r, 120));
    expect(s.feedbackStore.addReply).not.toHaveBeenCalled();
    expect(
      s.notify.mock.calls.some(
        (c) => (c[0] as NotificationIntent).event === "workflow.result_notified",
      ),
    ).toBe(true);
  });

  it("未装配 feedbackStore：通知照发，兜底跳过", async () => {
    const s = setup();
    (s.dispatcher as unknown as { deps: { feedbackStore?: unknown } }).deps.feedbackStore = undefined;
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          title: "已处理",
          recipients: "correlation",
          channels: ["inapp"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: FEEDBACK_CTX });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");
    await new Promise((r) => setTimeout(r, 120));
    expect(s.feedbackStore.addReply).not.toHaveBeenCalled();
    expect(
      s.notify.mock.calls.some(
        (c) => (c[0] as NotificationIntent).event === "workflow.result_notified",
      ),
    ).toBe(true);
  });

  it("failed 命中：业务轮失败后派生 notify 轮，简报携带错误信息", async () => {
    const s = setup({ handleMessageError: new Error("上游执行炸了") });
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: { enabled: true, on: ["failed"], recipients: "owner" },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: "x" });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "failed");
    // 写手轮复用同一 orchestrator mock（恒失败）→ notify 轮也 failed；但写手指令已带错误简报
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => {
      const st = (await s.runStore.getRun(nRun!.id))?.status;
      return st === "success" || st === "failed";
    });
    const writerMsg = s.handleMessage.mock.calls[1]?.[0] as { text: string };
    expect(writerMsg.text).toContain("上游执行炸了");
    expect((await s.runStore.getRun(nRun!.id))?.renderedPrompt).toContain("上游执行炸了");
  });
});

describe("notifyPolicy source 回源通道（spec 2026-10-27 §4.4 D3）", () => {
  const GROUP_MSG_PAYLOAD = JSON.stringify({
    platform: "dingtalk",
    topic: "robot.group",
    eventId: "msg-9",
    occurredAt: "2026-10-28T00:00:00.000Z",
    sender: { id: "staff-1", name: "张三" },
    source: { openConversationId: "cid-group-1", conversationType: "2" },
    text: "@机器人 处理",
    replyAnchor: { platform: "dingtalk", kind: "group", threadId: "cid-group-1" },
  });

  it("锚点在场 + channels 含 source → sourceDeliver 回群投递；站内信仍落（含强制补 inapp）", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          recipients: "owner",
          channels: ["source"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: GROUP_MSG_PAYLOAD });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");

    expect(s.sourceDeliver).toHaveBeenCalledOnce();
    const [anchor, text] = s.sourceDeliver.mock.calls[0] as [
      { platform: string; threadId: string },
      string,
    ];
    expect(anchor).toEqual({ platform: "dingtalk", kind: "group", threadId: "cid-group-1" });
    expect(text).toContain("通知正文");
    // source 请求强制补 inapp：站内信白名单不被跳过
    const notifyIntent = s.notify.mock.calls.find(
      (c) => (c[0] as { event: string }).event === "workflow.result_notified",
    )?.[0] as { channels?: string[] };
    expect(notifyIntent.channels).toContain("inapp");
    expect(notifyIntent.channels).not.toContain("source");
  });

  it("无锚点（手动运行普通载荷）→ source 降级：sourceDeliver 不调用，站内信照发", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          recipients: "owner",
          channels: ["source"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: "普通文本载荷" });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");
    expect(s.sourceDeliver).not.toHaveBeenCalled();
    const notifyIntent = s.notify.mock.calls.find(
      (c) => (c[0] as { event: string }).event === "workflow.result_notified",
    )?.[0] as { channels?: string[] };
    expect(notifyIntent.channels).toContain("inapp");
  });
});

describe("notifyPolicy direct 模式（2026-10-28 直接回复执行结果）", () => {
  const GROUP_MSG_PAYLOAD = JSON.stringify({
    platform: "dingtalk",
    topic: "robot.group",
    eventId: "msg-10",
    occurredAt: "2026-10-28T00:00:00.000Z",
    sender: { id: "staff-1", name: "张三" },
    source: { openConversationId: "cid-group-2", conversationType: "2" },
    text: "@机器人 处理",
    replyAnchor: { platform: "dingtalk", kind: "group", threadId: "cid-group-2" },
  });

  it("success + correlation 收件人：不派生写手轮，主 run 执行结果原样投递并兜底落反馈回复", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          mode: "direct",
          title: "你的反馈已处理",
          recipients: "correlation",
          channels: ["inapp"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: FEEDBACK_CTX });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");

    // 仅主 run 一轮 LLM 调用：写手轮整体跳过
    expect(s.handleMessage).toHaveBeenCalledTimes(1);
    // 站内信正文=主 run 最终回复（messageStore mock 的 bot 文本），收件人=因果提交人
    const intent = s.notify.mock.calls
      .map((c) => c[0] as NotificationIntent)
      .find((i) => i.event === "workflow.result_notified");
    expect(intent?.body).toContain("通知正文");
    expect(intent?.recipients).toEqual([{ kind: "user", userId: "submitter-7" }]);
    // 反馈回复兜底照常：正文=执行结果
    await waitFor(() => s.feedbackStore.addReply.mock.calls.length > 0);
    const reply = s.feedbackStore.addReply.mock.calls[0]?.[0] as { content: string };
    expect(reply.content).toContain("通知正文");
  });

  it("success + source 锚点：执行结果原样回源投递，投递正文存 renderedPrompt", async () => {
    const s = setup();
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["success"],
          mode: "direct",
          recipients: "owner",
          channels: ["source"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: GROUP_MSG_PAYLOAD });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "success");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");

    expect(s.handleMessage).toHaveBeenCalledTimes(1);
    expect(s.sourceDeliver).toHaveBeenCalledOnce();
    const [anchor, text] = s.sourceDeliver.mock.calls[0] as [
      { platform: string; threadId: string },
      string,
    ];
    expect(anchor).toEqual({ platform: "dingtalk", kind: "group", threadId: "cid-group-2" });
    expect(text).toContain("通知正文");
    expect((await s.runStore.getRun(nRun!.id))?.renderedPrompt).toContain("通知正文");
  });

  it("failed：无执行结果时正文降级为错误信息，notify 轮仍成功收口", async () => {
    const s = setup({ handleMessageError: new Error("上游执行炸了") });
    const wf = await s.workflowStore.create(
      baseInput({
        notifyPolicy: {
          enabled: true,
          on: ["failed"],
          mode: "direct",
          recipients: "owner",
          channels: ["inapp"],
        },
      }) as never,
    );
    const mainRun = await s.dispatcher.manualRun(wf.id, { payload: "x" });
    await waitFor(async () => (await s.runStore.getRun(mainRun.id))?.status === "failed");
    const nRun = await waitFor(() => notifyRunOf(s, wf.id));
    await waitFor(async () => (await s.runStore.getRun(nRun!.id))?.status === "success");
    expect(s.handleMessage).toHaveBeenCalledTimes(1);
    const intent = s.notify.mock.calls
      .map((c) => c[0] as NotificationIntent)
      .find((i) => i.event === "workflow.result_notified");
    expect(intent?.body).toContain("上游执行炸了");
  });
});
