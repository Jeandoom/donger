import { createHmac, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteModuleConfigStore } from "../../src/adapters/sqlite-module-config-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * POST /api/webhooks/teambition e2e（spec 2026-10-27-platform-message-subscription-design
 * §4.4/§4.6）：未配置/插件停用 404、验签 fail-closed 401、X-Trigger-From-Me 防环 200、
 * 归一入路由（envelope 断言）、不可归一 200 空应答。
 */

const TB_APP_SECRET = "tb-hook-secret";

let web: WebChannel;
let db: Database.Database;
let routeMock: ReturnType<typeof vi.fn>;

const TB_BODY = JSON.stringify({
  orgId: "org-1",
  timestamp: 1_770_000_000_000,
  event: "task.update",
  eventId: "evt-1",
  data: {
    operatorId: "member-7",
    task: { taskId: "task-9", projectId: "proj-2", content: "上线前回归" },
  },
});

function sign(body: string): string {
  return createHmac("sha256", TB_APP_SECRET).update(body).digest("hex");
}

async function startChannel(
  opts: { withConfig?: boolean; enabled?: boolean } = {},
): Promise<number> {
  db = new Database(":memory:");
  const sessionStore = new JwtSessionStore(db, "tb-wh-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: process.cwd(),
  });
  userStore.migrate();
  const moduleConfigStore = new SqliteModuleConfigStore(db, randomBytes(32).toString("hex"));
  moduleConfigStore.migrate();
  if (opts.withConfig !== false) {
    moduleConfigStore.putTeambition({ appKey: "tb-app", appSecret: TB_APP_SECRET, orgId: "org-1" });
  }
  routeMock = vi.fn().mockResolvedValue({ consumed: true, fired: 1 });
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: process.cwd(),
    sessionStore,
    userStore,
    moduleConfigStore,
    teambitionRouter: {
      route:
        routeMock as unknown as import("../../src/domain/event-payloads.js").PlatformMessageEnvelope extends never
          ? never
          : (
              envelope: import("../../src/domain/event-payloads.js").PlatformMessageEnvelope,
            ) => Promise<{
              consumed: boolean;
              fired: number;
            }>,
    },
    teambitionEnabled: () => opts.enabled !== false,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

function post(port: number, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/webhooks/teambition`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/webhooks/teambition", () => {
  afterEach(async () => {
    await web.stop();
    db.close();
  });

  it("未配置应用 → 404 不暴露", async () => {
    const port = await startChannel({ withConfig: false });
    expect((await post(port, TB_BODY, { "x-signature": sign(TB_BODY) })).status).toBe(404);
  });

  it("插件停用 → 404", async () => {
    const port = await startChannel({ enabled: false });
    expect((await post(port, TB_BODY, { "x-signature": sign(TB_BODY) })).status).toBe(404);
  });

  it("签名缺失/错误 → 401 fail-closed", async () => {
    const port = await startChannel();
    expect((await post(port, TB_BODY)).status).toBe(401);
    expect(
      (
        await post(port, TB_BODY, {
          "x-signature": createHmac("sha256", "wrong").update(TB_BODY).digest("hex"),
        })
      ).status,
    ).toBe(401);
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("X-Trigger-From-Me → 200 防环丢弃，不入路由", async () => {
    const port = await startChannel();
    const r = await post(port, TB_BODY, {
      "x-signature": sign(TB_BODY),
      "x-trigger-from-me": "true",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { skipped?: string }).skipped).toBe("self-triggered");
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("验签通过 → 归一信封入路由（topic/taskId/锚点断言）", async () => {
    const port = await startChannel();
    const r = await post(port, TB_BODY, { "x-signature": sign(TB_BODY) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { consumed?: boolean; fired?: number };
    expect(body).toEqual({ ok: true, consumed: true, fired: 1 });
    expect(routeMock).toHaveBeenCalledOnce();
    const env = routeMock.mock.calls[0]?.[0] as {
      platform: string;
      topic: string;
      eventId: string;
      source: { taskId: string };
      replyAnchor: { platform: string; kind: string; taskId: string };
    };
    expect(env.platform).toBe("teambition");
    expect(env.topic).toBe("task.update");
    expect(env.source.taskId).toBe("task-9");
    expect(env.replyAnchor).toEqual({
      platform: "teambition",
      kind: "task",
      taskId: "task-9",
      orgId: "org-1",
    });
  });

  it("缺 taskId 等不可归一载荷 → 200 空应答不 fire", async () => {
    const port = await startChannel();
    const body = JSON.stringify({ orgId: "org-1", event: "task.update", eventId: "e2" });
    const r = await post(port, body, { "x-signature": sign(body) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { skipped?: string }).skipped).toBe("unshaped");
    expect(routeMock).not.toHaveBeenCalled();
  });
});
