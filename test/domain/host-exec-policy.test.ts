import { describe, expect, it } from "vitest";
import {
  collectPromptAllowSections,
  HostExecPolicyInputSchema,
  type HostExecPolicyRule,
  resolveHostExecPolicy,
  validatePolicyPattern,
} from "../../src/domain/host-exec-policy.js";

const READ_ONLY = ["systemctl is-active", "curl -s", "journalctl -u"].join("\n");

function rule(overrides: Partial<HostExecPolicyRule> & { id: string }): HostExecPolicyRule {
  return {
    hostCode: "*",
    tool: "host_exec",
    scopeKind: "global",
    matchKind: "prefix",
    matchValue: READ_ONLY,
    decision: "allow",
    unattended: "inherit",
    enabled: true,
    createdAt: "2026-10-12T00:00:00Z",
    ...overrides,
  };
}

const BASE_QUERY = {
  hostCode: "ssh-homedb",
  tool: "host_exec" as const,
  command: "systemctl is-active stock-analysis",
  userId: "u1",
  role: "admin",
  unattended: false,
};

describe("resolveHostExecPolicy", () => {
  it("无命中/空规则 → undefined（回审批门，fail-closed 默认 ask）", () => {
    expect(resolveHostExecPolicy([], BASE_QUERY)).toBeUndefined();
    expect(
      resolveHostExecPolicy([rule({ id: "r1" })], { ...BASE_QUERY, command: "rm -rf /" }),
    ).toBeUndefined();
    expect(
      resolveHostExecPolicy([rule({ id: "r1", hostCode: "other-host" })], BASE_QUERY),
    ).toBeUndefined();
  });

  it("prefix 命中走防逃逸口径：组合段逐段命中、替换/重定向拒绝", () => {
    const rules = [rule({ id: "r1" })];
    expect(resolveHostExecPolicy(rules, BASE_QUERY)?.decision).toBe("allow");
    expect(
      resolveHostExecPolicy(rules, {
        ...BASE_QUERY,
        command: "systemctl is-active a && curl -s b",
      })?.decision,
    ).toBe("allow");
    expect(
      resolveHostExecPolicy(rules, {
        ...BASE_QUERY,
        command: "systemctl is-active $(evil)",
      }),
    ).toBeUndefined();
    expect(
      resolveHostExecPolicy(rules, {
        ...BASE_QUERY,
        command: "systemctl is-active a > /tmp/x",
      }),
    ).toBeUndefined();
  });

  it("deny 先行于一切 allow（黑名单不被 global allow 覆盖）", () => {
    const rules = [
      rule({ id: "allow-global", matchKind: "pattern", matchValue: ".*" }),
      rule({ id: "deny", matchKind: "pattern", matchValue: "mkfs", decision: "deny" }),
    ];
    expect(resolveHostExecPolicy(rules, { ...BASE_QUERY, command: "ls -la" })?.policyId).toBe(
      "allow-global",
    );
    expect(
      resolveHostExecPolicy(rules, { ...BASE_QUERY, command: "mkfs.ext4 /dev/sda" })?.policyId,
    ).toBe("deny");
  });

  it("主机精确 > '*'；scope 特异度 user > agent > role > global", () => {
    const rules = [
      rule({ id: "star-global" }),
      rule({ id: "host-agent", hostCode: "ssh-homedb", scopeKind: "agent", scopeRef: "a1" }),
    ];
    expect(resolveHostExecPolicy(rules, { ...BASE_QUERY, agentId: "a1" })?.policyId).toBe(
      "host-agent",
    );
    expect(resolveHostExecPolicy(rules, { ...BASE_QUERY, agentId: "a2" })?.policyId).toBe(
      "star-global",
    );

    const scopes = [
      rule({ id: "role", scopeKind: "role", scopeRef: "admin" }),
      rule({ id: "user", scopeKind: "user", scopeRef: "u1" }),
      rule({ id: "global" }),
      rule({ id: "agent", scopeKind: "agent", scopeRef: "a1" }),
    ];
    expect(resolveHostExecPolicy(scopes, { ...BASE_QUERY, agentId: "a1" })?.policyId).toBe("user");
  });

  it("tool 过滤：host_exec 规则不作用于 host_logs_clean；'*' 两者皆生效", () => {
    const logsQuery = { ...BASE_QUERY, tool: "host_logs_clean" as const, command: "" };
    expect(
      resolveHostExecPolicy([rule({ id: "he", tool: "host_exec" })], logsQuery),
    ).toBeUndefined();
    expect(resolveHostExecPolicy([rule({ id: "both", tool: "*" })], logsQuery)?.policyId).toBe(
      "both",
    );
    // logs_clean 固定模板无自由命令面：规则命中即放行（不判定命令内容）
    expect(
      resolveHostExecPolicy([rule({ id: "lc", tool: "host_logs_clean" })], logsQuery)?.policyId,
    ).toBe("lc");
  });

  it("无人值守档：inherit 跟随 decision；ask 条目 allow 升格 / allow 条目 skip 降为跳过", () => {
    const unattended = { ...BASE_QUERY, unattended: true };
    expect(
      resolveHostExecPolicy([rule({ id: "r", unattended: "inherit" })], unattended)?.decision,
    ).toBe("allow");
    expect(
      resolveHostExecPolicy([rule({ id: "r", decision: "ask", unattended: "allow" })], unattended)
        ?.decision,
    ).toBe("allow");
    expect(
      resolveHostExecPolicy(
        [rule({ id: "r", decision: "ask", unattended: "inherit" })],
        unattended,
      ),
    ).toBeUndefined();
    expect(
      resolveHostExecPolicy([rule({ id: "r", unattended: "skip" })], unattended)?.decision,
    ).toBe("skip");
    // 有人值守轮 skip 档不影响：照常 allow
    expect(
      resolveHostExecPolicy([rule({ id: "r", unattended: "skip" })], BASE_QUERY)?.decision,
    ).toBe("allow");
  });

  it("enabled=false 不参与裁决；pattern 规则坏正则视同未命中", () => {
    expect(resolveHostExecPolicy([rule({ id: "r", enabled: false })], BASE_QUERY)).toBeUndefined();
    expect(
      resolveHostExecPolicy(
        [rule({ id: "bad", matchKind: "pattern", matchValue: "([unclosed" })],
        BASE_QUERY,
      ),
    ).toBeUndefined();
    expect(
      resolveHostExecPolicy(
        [rule({ id: "ok", matchKind: "pattern", matchValue: "^git -C /srv/\\w+ pull" })],
        { ...BASE_QUERY, command: "git -C /srv/app pull --ff-only" },
      )?.policyId,
    ).toBe("ok");
  });
});

describe("collectPromptAllowSections", () => {
  it("按主机分组；'*' 规则并入每台具体主机；deny 主机整组不公示", () => {
    const rules = [
      rule({ id: "star", matchValue: "uptime" }),
      rule({ id: "homedb", hostCode: "ssh-homedb", matchValue: "systemctl is-active" }),
      rule({
        id: "deny-other",
        hostCode: "ssh-prod",
        matchKind: "pattern",
        matchValue: ".*",
        decision: "deny",
      }),
      rule({
        id: "allow-other",
        hostCode: "ssh-prod",
        matchValue: "uptime",
      }),
    ];
    const sections = collectPromptAllowSections(rules, ["ssh-homedb", "ssh-prod"], {
      userId: "u1",
      role: "admin",
      unattended: false,
    });
    expect(sections).toEqual([
      { hostCode: "ssh-homedb", prefixes: ["uptime", "systemctl is-active"] },
    ]);
  });

  it("scope 不匹配与 host_logs_clean 专属规则不进提示；unattended skip 条目排除", () => {
    const rules = [
      rule({ id: "other-agent", scopeKind: "agent", scopeRef: "a2" }),
      rule({ id: "lc-only", tool: "host_logs_clean" }),
      rule({ id: "skip-unatt", unattended: "skip" }),
    ];
    expect(
      collectPromptAllowSections(rules, ["ssh-homedb"], {
        agentId: "a1",
        userId: "u1",
        role: "admin",
        unattended: true,
      }),
    ).toEqual([]);
    expect(
      collectPromptAllowSections(rules, ["ssh-homedb"], {
        agentId: "a1",
        userId: "u1",
        role: "admin",
        unattended: false,
      }),
    ).toEqual([{ hostCode: "ssh-homedb", prefixes: READ_ONLY.split("\n") }]);
  });
});

describe("HostExecPolicyInputSchema", () => {
  it("M1 枚举收窄：deny 与 skip 拒收（守卫未接线防配置面漂移）", () => {
    expect(
      HostExecPolicyInputSchema.safeParse({
        hostCode: "*",
        tool: "host_exec",
        scopeKind: "global",
        matchKind: "prefix",
        matchValue: "uptime",
        decision: "deny",
        unattended: "inherit",
      }).success,
    ).toBe(false);
    expect(
      HostExecPolicyInputSchema.safeParse({
        hostCode: "*",
        tool: "host_exec",
        scopeKind: "global",
        matchKind: "prefix",
        matchValue: "uptime",
        decision: "allow",
        unattended: "skip",
      }).success,
    ).toBe(false);
  });

  it("global 不带 scopeRef；非 global 必带；prefix 空集拒收", () => {
    const base = {
      hostCode: "*",
      tool: "host_exec",
      matchKind: "prefix",
      matchValue: "uptime",
      decision: "allow",
      unattended: "inherit",
    };
    expect(HostExecPolicyInputSchema.safeParse({ ...base, scopeKind: "global" }).success).toBe(
      true,
    );
    expect(
      HostExecPolicyInputSchema.safeParse({ ...base, scopeKind: "global", scopeRef: "x" }).success,
    ).toBe(false);
    expect(HostExecPolicyInputSchema.safeParse({ ...base, scopeKind: "agent" }).success).toBe(
      false,
    );
    expect(
      HostExecPolicyInputSchema.safeParse({ ...base, scopeKind: "agent", scopeRef: "a1" }).success,
    ).toBe(true);
    expect(
      HostExecPolicyInputSchema.safeParse({ ...base, scopeKind: "global", matchValue: " \n " })
        .success,
    ).toBe(false);
  });

  it("validatePolicyPattern 拒收不可编译正则", () => {
    expect(validatePolicyPattern("^ok$")).toBeUndefined();
    expect(validatePolicyPattern("([unclosed")).toContain("不可编译");
    expect(validatePolicyPattern("x".repeat(201))).toContain("200");
  });
});
