import { describe, expect, it } from "vitest";
import {
  blockingIssues,
  emptyAgent,
  inferProviderFromUrl,
  inferRepoNameFromUrl,
  REPO_NAME_PATTERN,
  scenarioIssues,
} from "./model";

function repo(
  overrides: Partial<{
    id: string;
    name: string;
    url: string;
    provider: "github" | "gitee" | "jihulab";
    required: boolean;
    shallow: boolean;
    syncMode: "fastForward" | "cloneOnce";
  }>,
) {
  return {
    id: "r1",
    name: "",
    url: "",
    provider: "github" as const,
    required: true,
    shallow: true,
    syncMode: "fastForward" as const,
    ...overrides,
  };
}

describe("blockingIssues 保存阻断项 live 校验", () => {
  it("无 MCP 错误且无仓库时无阻断", () => {
    expect(blockingIssues(emptyAgent, null)).toEqual([]);
  });

  it("MCP JSON 解析错计入工具区", () => {
    const issues = blockingIssues(emptyAgent, "Unexpected token }");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.section).toBe("agent-sec-tools");
  });

  it("全空的新增仓库卡不计错（避免刚添加就见红）", () => {
    const form = { ...emptyAgent, gitRepositories: [repo({})] };
    expect(blockingIssues(form, null)).toEqual([]);
  });

  it("填了 URL 但目录名非法时计入资源区；合法目录名不计", () => {
    const bad = {
      ...emptyAgent,
      gitRepositories: [repo({ url: "https://github.com/a/b", name: "" })],
    };
    const issues = blockingIssues(bad, null);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.section).toBe("agent-sec-resources");

    const good = {
      ...emptyAgent,
      gitRepositories: [repo({ url: "https://github.com/a/b", name: "b" })],
    };
    expect(blockingIssues(good, null)).toEqual([]);
  });

  it("显式非法目录名（中文/越界长度）计入资源区", () => {
    const form = { ...emptyAgent, gitRepositories: [repo({ name: "带中文" })] };
    const issues = blockingIssues(form, null);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.section).toBe("agent-sec-resources");
    expect(issues[0]?.message).toContain("带中文");
  });
});

describe("scenarioIssues 场景装配前置校验", () => {
  it("无场景时不产生任何警示", () => {
    expect(scenarioIssues(emptyAgent)).toEqual([]);
  });

  it("code-dev 未绑定仓库时在基本区警示并指向资源处理", () => {
    const issues = scenarioIssues({ ...emptyAgent, scenario: "code-dev" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.section).toBe("agent-sec-basic");
    expect(issues[0]?.message).toContain("Git 仓库");
  });

  it("code-dev 已绑定仓库则无警示", () => {
    const form = {
      ...emptyAgent,
      scenario: "code-dev" as const,
      gitRepositories: [
        {
          id: "r1",
          name: "donger",
          provider: "github" as const,
          url: "https://github.com/a/b.git",
          required: true,
          shallow: true,
          syncMode: "fastForward" as const,
        },
      ],
    };
    expect(scenarioIssues(form)).toEqual([]);
  });

  it("kb-qa 使用全部工具时警示需只读白名单", () => {
    const issues = scenarioIssues({ ...emptyAgent, scenario: "kb-qa" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.section).toBe("agent-sec-tools");
    expect(issues[0]?.message).toContain("只读");
  });

  it("kb-qa 切换白名单模式后无警示", () => {
    const form = {
      ...emptyAgent,
      scenario: "kb-qa" as const,
      tools: { mode: "whitelist" as const, whitelist: ["read"] },
    };
    expect(scenarioIssues(form)).toEqual([]);
  });

  it("research 白名单缺 kb_write 时警示", () => {
    const form = {
      ...emptyAgent,
      scenario: "research" as const,
      tools: { mode: "whitelist" as const, whitelist: ["read", "bash"] },
    };
    const issues = scenarioIssues(form);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("kb_write");
  });

  it("research 全部工具模式（含 kb_write）无警示", () => {
    expect(scenarioIssues({ ...emptyAgent, scenario: "research" })).toEqual([]);
  });

  it("research 白名单含 kb_write 无警示", () => {
    const form = {
      ...emptyAgent,
      scenario: "research" as const,
      tools: { mode: "whitelist" as const, whitelist: ["kb_write", "kb_read"] },
    };
    expect(scenarioIssues(form)).toEqual([]);
  });
});

describe("inferProviderFromUrl 平台推断", () => {
  it("三平台 HTTPS 域名精确匹配", () => {
    expect(inferProviderFromUrl("https://github.com/a/b.git")).toBe("github");
    expect(inferProviderFromUrl("https://gitee.com/a/b.git")).toBe("gitee");
    expect(inferProviderFromUrl("https://jihulab.com/a/b.git")).toBe("jihulab");
  });

  it("子域名/自建域名/非 HTTPS/非法 URL 返回 undefined", () => {
    expect(inferProviderFromUrl("https://ghe.company.com/a/b.git")).toBeUndefined();
    expect(inferProviderFromUrl("http://github.com/a/b.git")).toBeUndefined();
    expect(inferProviderFromUrl("not-a-url")).toBeUndefined();
  });
});

describe("inferRepoNameFromUrl 目录名推断", () => {
  it("取路径尾段并去掉 .git 后缀", () => {
    expect(inferRepoNameFromUrl("https://github.com/example/donger.git")).toBe("donger");
  });

  it("非法字符转连字符、掐掉头部符号（URL 编码不解码，与原实现一致）", () => {
    expect(inferRepoNameFromUrl("https://github.com/a/_my.app%20v2.git")).toBe("my.app-20v2");
  });

  it("解析失败返回空串", () => {
    expect(inferRepoNameFromUrl("garbage")).toBe("");
  });
});

describe("REPO_NAME_PATTERN 目录名约束（与后端同源）", () => {
  it.each(["backend", "web-ui", "a.b_c-d", "x".repeat(64)])("合法：%s", (name) => {
    expect(REPO_NAME_PATTERN.test(name)).toBe(true);
  });
  it.each(["", ".hidden", "-lead", "带中文", "x".repeat(65), "a b"])("非法：%s", (name) => {
    expect(REPO_NAME_PATTERN.test(name)).toBe(false);
  });
});
