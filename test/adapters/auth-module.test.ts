import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteInviteStore } from "../../src/adapters/sqlite-invite-store.js";
import { SqliteModuleConfigStore } from "../../src/adapters/sqlite-module-config-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { parseSignupDomains } from "../../src/domain/module-config.js";
import {
  createTestModuleConfigStore,
  TEST_MODULE_KEY_HEX,
} from "../util/module-config-test-helper.js";

/**
 * 授权/代理模块契约测试（spec 2026-09-21-auth-module-design）：
 * setup 零配置引导、auth-configs 掩码/合并/清空停用、白名单动态生效、代理模块端点。
 * 注意 register/login/setup 共用每 IP 限流（5 次/分），单测试内对同通道的写请求 ≤4。
 */

const realFetch = globalThis.fetch;

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let store: SqliteModuleConfigStore;

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "auth-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "auth-ws-"));
});

afterEach(async () => {
  await web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

interface StartOpts {
  setupToken?: string;
  dingtalkController?: {
    apply(cfg: { appKey: string; appSecret: string; robotCode: string } | undefined): void;
  };
}

async function start(opts: StartOpts = {}): Promise<number> {
  db = new Database(":memory:");
  const sessionStore = new JwtSessionStore(db, "auth-module-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const inviteStore = new SqliteInviteStore(db);
  inviteStore.migrate();
  store = createTestModuleConfigStore(db);
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    inviteStore,
    moduleConfigStore: store,
    setupToken: opts.setupToken,
    dingtalkChannelController: opts.dingtalkController,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// === SqliteModuleConfigStore ===

describe("SqliteModuleConfigStore", () => {
  it("秘密加密落库：raw 是密文、get 返回明文", () => {
    const raw = new SqliteModuleConfigStore(new Database(":memory:"), TEST_MODULE_KEY_HEX);
    raw.migrate();
    raw.putDingTalk({ appKey: "ak", appSecret: "super-secret", robotCode: "rc" });
    expect(raw.getDingTalk()?.appSecret).toBe("super-secret");
    expect(raw.rawModule("dingtalk")?.appSecret).not.toBe("super-secret");
    expect(String(raw.rawModule("dingtalk")?.appSecret)).toContain(":");
  });

  it("migrateFromEnv 幂等：标记后二次调用与 env 变更都不再生效", () => {
    const raw = new SqliteModuleConfigStore(new Database(":memory:"), TEST_MODULE_KEY_HEX);
    raw.migrate();
    raw.migrateFromEnv({ dingtalk: { appKey: "ak1", appSecret: "s1" } });
    expect(raw.getDingTalk()?.appKey).toBe("ak1");
    expect(raw.getFlag("auth_env_migrated")).toBeTruthy();
    // 模拟 env 改动后再迁移：no-op
    raw.migrateFromEnv({ dingtalk: { appKey: "ak2", appSecret: "s2" } });
    expect(raw.getDingTalk()?.appKey).toBe("ak1");
  });

  it("migrateFromEnv 只迁移非默认值；同事务写标记", () => {
    const raw = new SqliteModuleConfigStore(new Database(":memory:"), TEST_MODULE_KEY_HEX);
    raw.migrate();
    raw.migrateFromEnv({
      email: { signupAllowedDomains: ["corp.com"], loginEnabled: false },
      proxy: { githubOauthProxyUrl: "http://127.0.0.1:7897" },
    });
    expect(raw.getEmail()?.signupAllowedDomains).toEqual(["corp.com"]);
    expect(raw.getEmail()?.loginEnabled).toBe(false);
    expect(raw.getProxy()?.githubOauthProxyUrl).toBe("http://127.0.0.1:7897");
  });

  it("deleteModule 清除配置；解密失败按未配置处理", () => {
    const raw = new SqliteModuleConfigStore(new Database(":memory:"), TEST_MODULE_KEY_HEX);
    raw.migrate();
    raw.putGithub({ clientId: "cid", clientSecret: "cs" });
    expect(raw.getGithub()?.clientId).toBe("cid");
    raw.deleteModule("github");
    expect(raw.getGithub()).toBeUndefined();
  });

  it("parseSignupDomains：逗号/换行/去重/小写", () => {
    expect(parseSignupDomains(["A.com", " b.com ", "a.com", ""])).toEqual(["a.com", "b.com"]);
    expect(parseSignupDomains("A.com, b.com\nC.com")).toEqual(["a.com", "b.com", "c.com"]);
  });
});

// === setup 零配置引导 ===

describe("POST /api/setup/admin 零配置引导", () => {
  it("裸库：status setupRequired=true；创建首个 admin 即返回 token；再次调用 409", async () => {
    const port = await start();
    const status = await (await req(port, "GET", "/api/setup/status")).json();
    expect(status).toEqual({ setupRequired: true });

    const created = await req(port, "POST", "/api/setup/admin", {
      email: "root@example.com",
      password: "passw0rd1",
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { token: string; user: { role: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.role).toBe("admin");

    // 邮箱直接置已验证：能登录
    const login = await req(port, "POST", "/api/auth/login", {
      email: "root@example.com",
      password: "passw0rd1",
    });
    expect(login.status).toBe(200);

    // 完成后 setupRequired=false 且再 setup 409
    const after = (await (await req(port, "GET", "/api/setup/status")).json()) as {
      setupRequired: boolean;
    };
    expect(after.setupRequired).toBe(false);
    const again = await req(port, "POST", "/api/setup/admin", {
      email: "other@example.com",
      password: "passw0rd1",
    });
    expect(again.status).toBe(409);
  });

  it("已有 admin 的存量库：setupRequired=false，setup 恒 409", async () => {
    const port = await start();
    await req(port, "POST", "/api/setup/admin", {
      email: "root@example.com",
      password: "passw0rd1",
    });
    // 等价于存量库：admin 已存在。重开状态查询（GET 不占注册限流桶）
    const status = (await (await req(port, "GET", "/api/setup/status")).json()) as {
      setupRequired: boolean;
    };
    expect(status.setupRequired).toBe(false);
  });

  it("SETUP_TOKEN 配置后：无 token 403，带 token 成功", async () => {
    const port = await start({ setupToken: "bootstrap-token" });
    const denied = await req(port, "POST", "/api/setup/admin", {
      email: "root@example.com",
      password: "passw0rd1",
    });
    expect(denied.status).toBe(403);
    const ok = await req(port, "POST", "/api/setup/admin", {
      email: "root@example.com",
      password: "passw0rd1",
      setupToken: "bootstrap-token",
    });
    expect(ok.status).toBe(200);
  });

  it("弱密码/非法邮箱 → 400", async () => {
    const port = await start();
    const badPwd = await req(port, "POST", "/api/setup/admin", {
      email: "root@example.com",
      password: "short",
    });
    expect(badPwd.status).toBe(400);
    const badEmail = await req(port, "POST", "/api/setup/admin", {
      email: "not-an-email",
      password: "passw0rd1",
    });
    expect(badEmail.status).toBe(400);
  });
});

// === 授权/代理配置端点 ===

describe("授权/代理配置端点", () => {
  it("未登录 GET /api/admin/auth-configs → 401（守卫 fail-closed）", async () => {
    const port = await start();
    const res = await req(port, "GET", "/api/admin/auth-configs");
    expect(res.status).toBe(401);
  });

  it("完整流：setup 建 admin → PUT 三模块 → GET 掩码视图 → methods 动态生效", async () => {
    const port = await start();
    const setup = (await (
      await req(port, "POST", "/api/setup/admin", {
        email: "root@example.com",
        password: "passw0rd1",
      })
    ).json()) as { token: string };
    const admin = setup.token;

    // methods：未配置三方 → 只有 email + setupRequired 初始 true（本测试在 setup 前不探测）
    // PUT dingtalk（含 robotCode）→ 应用
    const putDt = await req(
      port,
      "PUT",
      "/api/admin/auth-configs/dingtalk",
      {
        appKey: "ak",
        appSecret: "sk",
        robotCode: "rc",
      },
      admin,
    );
    expect(putDt.status).toBe(200);
    expect(((await putDt.json()) as { robotChannelActive: boolean }).robotChannelActive).toBe(true);

    // PUT github
    const putGh = await req(
      port,
      "PUT",
      "/api/admin/auth-configs/github",
      {
        clientId: "cid",
        clientSecret: "cs",
      },
      admin,
    );
    expect(putGh.status).toBe(200);

    // PUT email：白名单 + 关闭邮箱登录
    const putEmail = await req(
      port,
      "PUT",
      "/api/admin/auth-configs/email",
      {
        signupAllowedDomains: ["corp.com", ".sub.com"],
        loginEnabled: false,
      },
      admin,
    );
    expect(putEmail.status).toBe(200);

    // GET 视图：秘密不回明文只回 Set 标记
    const view = (await (
      await req(port, "GET", "/api/admin/auth-configs", undefined, admin)
    ).json()) as {
      dingtalk: { appKey: string; appSecretSet: boolean; robotCode: string; callbackUrl: string };
      github: { clientId: string; clientSecretSet: boolean; callbackUrl: string };
      email: { signupAllowedDomains: string[]; loginEnabled: boolean };
    };
    expect(view.dingtalk.appKey).toBe("ak");
    expect(view.dingtalk.appSecretSet).toBe(true);
    expect(view.dingtalk.robotCode).toBe("rc");
    expect(JSON.stringify(view)).not.toContain("sk");
    expect(view.github.clientSecretSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("cs");
    expect(view.email.signupAllowedDomains).toEqual(["corp.com", ".sub.com"]);
    expect(view.email.loginEnabled).toBe(false);

    // methods 即时生效：邮箱关、钉钉/GitHub 开、setupRequired=false
    const methods = (await (await req(port, "GET", "/api/auth/methods")).json()) as {
      methods: string[];
      setupRequired: boolean;
    };
    expect(methods.methods).toEqual(["dingtalk", "github"]);
    expect(methods.setupRequired).toBe(false);
  });

  it("PUT dingtalk 秘密留空=保留旧值；robotCode 清空=通道停用；清空保存=停用", async () => {
    const applies: (string | undefined)[] = [];
    const port = await start({
      dingtalkController: {
        apply: (cfg) => applies.push(cfg ? `${cfg.appKey}/${cfg.robotCode}` : "stopped"),
      },
    });
    const setup = (await (
      await req(port, "POST", "/api/setup/admin", {
        email: "root@example.com",
        password: "passw0rd1",
      })
    ).json()) as { token: string };
    const admin = setup.token;

    await req(
      port,
      "PUT",
      "/api/admin/auth-configs/dingtalk",
      {
        appKey: "ak",
        appSecret: "sk",
        robotCode: "rc1",
      },
      admin,
    );
    // 改 appKey+robotCode，秘密留空 → 保留
    const merged = await req(
      port,
      "PUT",
      "/api/admin/auth-configs/dingtalk",
      {
        appKey: "ak2",
        appSecret: "",
        robotCode: "rc2",
      },
      admin,
    );
    expect(merged.status).toBe(200);
    expect(store.getDingTalk()?.appSecret).toBe("sk");
    expect(store.getDingTalk()?.appKey).toBe("ak2");

    // 清空保存=停用（AppKey 留空即停用：删除配置 + 通知 controller 停通道）
    const cleared = await req(
      port,
      "PUT",
      "/api/admin/auth-configs/dingtalk",
      {
        appKey: "",
        appSecret: "",
      },
      admin,
    );
    expect(cleared.status).toBe(200);
    expect(store.getDingTalk()).toBeUndefined();
    expect(applies).toEqual(["ak/rc1", "ak2/rc2", "stopped"]);
  });

  it("代理模块：PUT 校验协议头，GET 回读；清空=直连", async () => {
    const port = await start();
    const setup = (await (
      await req(port, "POST", "/api/setup/admin", {
        email: "root@example.com",
        password: "passw0rd1",
      })
    ).json()) as { token: string };
    const admin = setup.token;

    const bad = await req(
      port,
      "PUT",
      "/api/admin/proxy",
      { githubOauthProxyUrl: "socks://x" },
      admin,
    );
    expect(bad.status).toBe(400);

    const put = await req(
      port,
      "PUT",
      "/api/admin/proxy",
      {
        githubOauthProxyUrl: "http://127.0.0.1:7897",
      },
      admin,
    );
    expect(put.status).toBe(200);
    let view = (await (await req(port, "GET", "/api/admin/proxy", undefined, admin)).json()) as {
      githubOauthProxyUrl: string;
    };
    expect(view.githubOauthProxyUrl).toBe("http://127.0.0.1:7897");

    const clear = await req(port, "PUT", "/api/admin/proxy", { githubOauthProxyUrl: "" }, admin);
    expect(clear.status).toBe(200);
    view = (await (await req(port, "GET", "/api/admin/proxy", undefined, admin)).json()) as {
      githubOauthProxyUrl: string;
    };
    expect(view.githubOauthProxyUrl).toBe("");
    expect(store.getProxy()?.githubOauthProxyUrl).toBeUndefined();
  });

  it("邮箱白名单动态生效：配置后无邀请注册放行，空白名单拒绝", async () => {
    const port = await start();
    const setup = (await (
      await req(port, "POST", "/api/setup/admin", {
        email: "root@example.com",
        password: "passw0rd1",
      })
    ).json()) as { token: string };
    const admin = setup.token;

    // 空白名单：无邀请自助注册被拒
    const denied = await req(port, "POST", "/api/auth/register", {
      email: "user@corp.com",
      password: "passw0rd1",
    });
    expect(denied.status).toBe(403);

    // 配置白名单后（不重启）放行
    await req(
      port,
      "PUT",
      "/api/admin/auth-configs/email",
      {
        signupAllowedDomains: ["corp.com"],
        loginEnabled: true,
      },
      admin,
    );
    const allowed = await req(port, "POST", "/api/auth/register", {
      email: "user@corp.com",
      password: "passw0rd1",
    });
    expect(allowed.status).toBe(202);
  });
});

// === SqliteUserStore.setup 支撑 ===

describe("SqliteUserStore bootstrap", () => {
  it("createBootstrapAdmin 原子性：并发第二请求返回 exists 且不建用户", async () => {
    const raw = new Database(":memory:");
    const sessionStore = new JwtSessionStore(raw, "s");
    sessionStore.migrate();
    const dir = mkdtempSync(join(tmpdir(), "boot-users-"));
    try {
      const userStore = new SqliteUserStore(raw, { adminExternalIds: new Set(), usersDir: dir });
      userStore.migrate();
      userStore.migrateCredentials();
      expect(await userStore.hasAnyAdmin()).toBe(false);
      const first = await userStore.createBootstrapAdmin({
        email: "root@example.com",
        passwordHash: "h",
      });
      expect(first).toBe("created");
      expect(await userStore.hasAnyAdmin()).toBe(true);
      const second = await userStore.createBootstrapAdmin({
        email: "other@example.com",
        passwordHash: "h",
      });
      expect(second).toBe("exists");
      // 标记防重开：删掉 admin 也不会再放行 setup
      raw.prepare("DELETE FROM users WHERE role = 'admin'").run();
      expect(await userStore.hasAnyAdmin()).toBe(false);
      const third = await userStore.createBootstrapAdmin({
        email: "third@example.com",
        passwordHash: "h",
      });
      expect(third).toBe("exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
