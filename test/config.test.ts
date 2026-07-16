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
    expect(c.builtinSkillsDir).toBe(join("./repos", "skills"));
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

  it("BUILTIN_SKILLS_DIR 可选：默认 <repoRoot>/skills，设了覆盖", () => {
    expect(loadConfig(base).builtinSkillsDir).toBe(join("./repos", "skills"));
    expect(loadConfig({ ...base, BUILTIN_SKILLS_DIR: "/path/to/skills" }).builtinSkillsDir).toBe(
      "/path/to/skills",
    );
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

describe("config agent 扩展", () => {
  it("默认 secretKeySeed 派生自 jwtSecret 并告警", () => {
    const warns: string[] = [];
    const origEmit = process.emitWarning;
    process.emitWarning = ((msg: unknown) => {
      warns.push(String(msg));
    }) as typeof process.emitWarning;
    try {
      const cfg = loadConfig({ ...base, JWT_SECRET: "js" });
      expect(cfg.secretKeySeed).toBe("js");
      expect(warns.some((w) => w.includes("SECRET_KEY"))).toBe(true);
    } finally {
      process.emitWarning = origEmit;
    }
  });

  it("SECRET_KEY 优先于 JWT_SECRET", () => {
    const origEmit = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      const cfg = loadConfig({ ...base, SECRET_KEY: "sk", JWT_SECRET: "js" });
      expect(cfg.secretKeySeed).toBe("sk");
    } finally {
      process.emitWarning = origEmit;
    }
  });

  it("解析 AGENT_LLM_PRESETS", () => {
    const cfg = loadConfig({
      ...base,
      AGENT_LLM_PRESETS: "GLM4|glm-4.6|https://a;Qwen|qwen|https://b",
    });
    expect(cfg.agentLlmPresets).toEqual([
      { id: "0", name: "GLM4", model: "glm-4.6", baseUrl: "https://a" },
      { id: "1", name: "Qwen", model: "qwen", baseUrl: "https://b" },
    ]);
  });

  it("非法 AGENT_LLM_PRESETS 抛错", () => {
    expect(() => loadConfig({ ...base, AGENT_LLM_PRESETS: "only-name" })).toThrow();
  });
});

describe("config Git 授权", () => {
  it("解析 OAuth 与 Git 运行参数", () => {
    const cfg = loadConfig({
      ...base,
      PUBLIC_BASE_URL: "https://donger.example/",
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
      GIT_CLONE_TIMEOUT_MS: "90000",
      GIT_AUTH_CACHE_TTL_MS: "300000",
    });
    expect(cfg.publicBaseUrl).toBe("https://donger.example");
    expect(cfg.gitOAuth.github).toEqual({ clientId: "gh-id", clientSecret: "gh-secret" });
    expect(cfg.gitCloneTimeoutMs).toBe(90_000);
    expect(cfg.gitAuthCacheTtlMs).toBe(300_000);
  });
});
