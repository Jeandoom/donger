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
    expect(c.dbPath).toBe("./data/donger.db");
    expect(c.port).toBe(3000);
    expect(c.logLevel).toBe("info");
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
});
