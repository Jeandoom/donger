import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: "tok",
};

describe("loadConfig", () => {
  it("合法配置 + 全部默认值", () => {
    const c = loadConfig(base);
    expect(c.llm).toEqual({
      model: "glm-4.6",
      baseUrl: base.ANTHROPIC_BASE_URL,
      authToken: "tok",
    });
    expect(c.repoRoot).toBe("./repos");
    expect(c.memoryDir).toBe("./data/memory");
    expect(c.dbPath).toBe(join(homedir(), ".donger", "donger.db"));
    expect(c.port).toBe(3300);
    expect(c.host).toBe("0.0.0.0");
    expect(c.logLevel).toBe("info");
    expect(c.superpowersPluginPath).toBeUndefined();
    expect(c.dingtalk).toBeUndefined();
  });

  it("缺 ANTHROPIC_AUTH_TOKEN 报错", () => {
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: "x" })).toThrow();
  });

  it("ANTHROPIC_BASE_URL 空串报错（min 校验）", () => {
    expect(() => loadConfig({ ...base, ANTHROPIC_BASE_URL: "" })).toThrow();
  });

  it("PORT 字符串被 coerce 为数字", () => {
    expect(loadConfig({ ...base, PORT: "8080" }).port).toBe(8080);
  });

  it("HOST 默认 0.0.0.0，可被 env 覆盖", () => {
    expect(loadConfig(base).host).toBe("0.0.0.0");
    expect(loadConfig({ ...base, HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  it("LOG_LEVEL 自定义生效", () => {
    expect(loadConfig({ ...base, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("非法 LOG_LEVEL 报错", () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: "verbose" })).toThrow();
  });

  it("dingtalk 三件套齐全才填", () => {
    const c = loadConfig({
      ...base,
      DINGTALK_APP_KEY: "k",
      DINGTALK_APP_SECRET: "s",
      DINGTALK_ROBOT_CODE: "r",
    });
    expect(c.dingtalk).toEqual({ appKey: "k", appSecret: "s", robotCode: "r" });
  });

  it("dingtalk 缺一不填", () => {
    expect(loadConfig({ ...base, DINGTALK_APP_KEY: "k" }).dingtalk).toBeUndefined();
  });

  it("SUPERPOWERS_PLUGIN_PATH 可选：设了才填", () => {
    expect(loadConfig(base).superpowersPluginPath).toBeUndefined();
    expect(
      loadConfig({ ...base, SUPERPOWERS_PLUGIN_PATH: "/path/to/superpowers" })
        .superpowersPluginPath,
    ).toBe("/path/to/superpowers");
  });

  it("WORKSPACE_DIR / DB_PATH 默认到 ~/.donger/", () => {
    const c = loadConfig(base);
    expect(c.workspaceDir).toBe(join(homedir(), ".donger", "workspace"));
    expect(c.dbPath).toBe(join(homedir(), ".donger", "donger.db"));
  });

  it("WORKSPACE_DIR / DB_PATH 可被 env 覆盖", () => {
    const c = loadConfig({ ...base, WORKSPACE_DIR: "/tmp/ws", DB_PATH: "/tmp/x.db" });
    expect(c.workspaceDir).toBe("/tmp/ws");
    expect(c.dbPath).toBe("/tmp/x.db");
  });

  it("ADMIN_EXTERNAL_IDS 解析为 Set（逗号分隔、去空白、去空）", () => {
    const c = loadConfig({ ...base, ADMIN_EXTERNAL_IDS: " ext1 , ext2 ,, " });
    expect(c.adminExternalIds).toBeInstanceOf(Set);
    expect([...c.adminExternalIds]).toEqual(["ext1", "ext2"]);
  });

  it("ADMIN_EXTERNAL_IDS 默认空 Set", () => {
    expect([...loadConfig(base).adminExternalIds]).toEqual([]);
  });

  it("向后兼容：ADMIN_STAFF_IDS 被合并进 adminExternalIds 并告警", () => {
    const warns: string[] = [];
    const origEmit = process.emitWarning;
    process.emitWarning = ((msg: unknown) => {
      warns.push(String(msg));
    }) as typeof process.emitWarning;
    try {
      const c = loadConfig({ ...base, ADMIN_STAFF_IDS: "legacy1,legacy2" });
      expect([...c.adminExternalIds]).toEqual(["legacy1", "legacy2"]);
      expect(warns.some((w) => w.includes("ADMIN_STAFF_IDS"))).toBe(true);
    } finally {
      process.emitWarning = origEmit;
    }
  });

  it("ADMIN_EXTERNAL_IDS 与 ADMIN_STAFF_IDS 同时存在则合并去重", () => {
    const origEmit = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      const c = loadConfig({
        ...base,
        ADMIN_EXTERNAL_IDS: "ext1",
        ADMIN_STAFF_IDS: "ext1,legacy2",
      });
      expect([...c.adminExternalIds]).toEqual(["ext1", "legacy2"]);
    } finally {
      process.emitWarning = origEmit;
    }
  });
});
