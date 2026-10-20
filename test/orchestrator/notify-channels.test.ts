import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { EmailNotificationAdapter } from "../../src/adapters/notif-email.js";
import { SqliteNotificationStore } from "../../src/adapters/sqlite-notification-store.js";
import type { NotificationIntent } from "../../src/domain/notification.js";
import { NotificationService } from "../../src/orchestrator/notification-service.js";
import type {
  NotificationChannelAdapter,
  OutboundNotification,
} from "../../src/ports/notification-channel.js";

const logger = { error: vi.fn(), warn: vi.fn() } as never;

function makeSvc(
  adapters: NotificationChannelAdapter[],
  over: { userEmail?: string } = {},
): { svc: NotificationService; db: Database.Database } {
  const db = new Database(":memory:");
  const store = new SqliteNotificationStore(db);
  store.migrate();
  const svc = new NotificationService({
    store,
    adapters,
    retryDelaysMs: [0, 0],
    getUserEmail: async () => over.userEmail,
  });
  return { svc, db };
}

function fakeAdapter(id: "dingtalk" | "webhook" | "email"): {
  adapter: NotificationChannelAdapter;
  sent: OutboundNotification[];
} {
  const sent: OutboundNotification[] = [];
  return {
    sent,
    adapter: {
      id,
      available: () => true,
      send: async (address, n) => {
        sent.push(n);
        return { ok: true };
      },
    },
  };
}

const baseIntent: NotificationIntent = {
  event: "workflow.result_notified",
  recipients: [{ kind: "user", userId: "u1" }],
  title: "结果通知",
  body: "正文",
};

describe("通知通道白名单（M3 notifyPolicy.channels 语义）", () => {
  it("channels 缺省=站内落库+全部站外按偏好分发", async () => {
    const dt = fakeAdapter("dingtalk");
    const { svc, db } = makeSvc([dt.adapter]);
    await svc.notify(baseIntent);
    expect(await svc.unreadCount("u1")).toBe(1);
    expect(dt.sent).toHaveLength(0); // 用户未订阅 dingtalk 偏好 → 不发
    db.close();
  });

  it("channels 不含 inapp：跳过站内落库；含 dingtalk 时仅该站外通道候选", async () => {
    const dt = fakeAdapter("dingtalk");
    const hook = fakeAdapter("webhook");
    const { svc, db } = makeSvc([dt.adapter, hook.adapter]);
    await svc.notify({ ...baseIntent, channels: ["dingtalk"] });
    expect(await svc.unreadCount("u1")).toBe(0);
    expect(dt.sent).toHaveLength(0); // 偏好未启用仍不发（交集语义）
    db.close();
  });

  it("channels 含站外 + 用户偏好已启用：仅白名单内通道投递", async () => {
    // email 通道地址解析不依赖地址簿（getUserEmail 直给），最干净的白名单观测面
    const em = fakeAdapter("email");
    const { svc, db } = makeSvc([em.adapter], { userEmail: "u@example.com" });
    await svc.setPref("u1", { eventGroup: "task", channel: "email", enabled: true });
    await svc.notify({ ...baseIntent, channels: ["email"] });
    await new Promise((r) => setTimeout(r, 30));
    expect(em.sent).toHaveLength(1);
    // 同偏好下切到未授权白名单 → 不投
    await svc.notify({ ...baseIntent, channels: ["dingtalk"] });
    await new Promise((r) => setTimeout(r, 30));
    expect(em.sent).toHaveLength(1);
    db.close();
  });
});

describe("email 通道（M3）", () => {
  it("注册邮箱身份即投递地址；未注册邮箱 → skipped 不报错", async () => {
    const em = fakeAdapter("email");
    const withAddr = makeSvc([em.adapter], { userEmail: "u@example.com" });
    await withAddr.svc.setPref("u1", { eventGroup: "task", channel: "email", enabled: true });
    await withAddr.svc.notify(baseIntent);
    await new Promise((r) => setTimeout(r, 30));
    expect(em.sent).toHaveLength(1);

    const em2 = fakeAdapter("email");
    const noAddr = makeSvc([em2.adapter]);
    await noAddr.svc.setPref("u2", { eventGroup: "task", channel: "email", enabled: true });
    await noAddr.svc.notify({
      ...baseIntent,
      recipients: [{ kind: "user", userId: "u2" }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(em2.sent).toHaveLength(0);
    const deliveries = await noAddr.svc.listDeliveries(20);
    // NotificationDelivery 不带 userId；该 svc 实例仅 u2 一位收件人，够定位
    expect(deliveries.some((d) => d.channel === "email" && d.status === "skipped")).toBe(true);
  });

  it("adapter：SMTP 未配置 available()=false；配置后经 nodemailer 投递", async () => {
    const unconfigured = new EmailNotificationAdapter(() => undefined);
    expect(unconfigured.available()).toBe(false);
    const r = await unconfigured.send("x@example.com", {
      id: "n1",
      event: "workflow.result_notified",
      severity: "info",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SMTP 未配置");
  });

  it("adapter：配置齐备时构造 transport 并发送（nodemailer mock）", async () => {
    vi.resetModules();
    const sendMail = vi.fn().mockResolvedValue({});
    vi.doMock("nodemailer", () => ({
      default: { createTransport: vi.fn(() => ({ sendMail })) },
    }));
    const { EmailNotificationAdapter: FreshAdapter } = await import(
      "../../src/adapters/notif-email.js"
    );
    const adapter = new FreshAdapter(() => ({
      signupAllowedDomains: [],
      loginEnabled: false,
      smtp: {
        host: "smtp.example.com",
        port: 587,
        username: "u",
        password: "p",
        from: "d@example.com",
      },
    }));
    expect(adapter.available()).toBe(true);
    const outcome = await adapter.send("to@example.com", {
      id: "n1",
      event: "workflow.result_notified",
      severity: "info",
      title: "标题",
      body: "正文",
    });
    expect(outcome.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]?.[0] as { from: string; to: string; subject: string };
    expect(arg.from).toBe("d@example.com");
    expect(arg.to).toBe("to@example.com");
    expect(arg.subject).toContain("标题");
    vi.doUnmock("nodemailer");
    vi.resetModules();
  });
});
