import { describe, expect, it } from "vitest";
import {
  BUILTIN_DENY_PATTERNS,
  buildHostExecAdoptDraft,
  collectPromptAllowSections,
  HostExecPolicyInputSchema,
  type HostExecPolicyRule,
  resolveHostExecPolicy,
  validateAdoptPrefix,
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
  it("M2 起 deny 开放（审批短路已接线）；skip 仍收窄（M3 接线）", () => {
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
    ).toBe(true);
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

describe("BUILTIN_DENY_PATTERNS", () => {
  const CASES: Array<{ pattern: string; hit: string[]; miss: string[] }> = [
    {
      pattern: BUILTIN_DENY_PATTERNS.find((p) => p.id === "builtin-mkfs")!.pattern,
      hit: ["mkfs.ext4 /dev/sda1", "sudo mkfs -t ext4 /dev/nvme0n1"],
      miss: ["systemctl status mkfssync", "ls /opt/mkfs-tools"],
    },
    {
      pattern: BUILTIN_DENY_PATTERNS.find((p) => p.id === "builtin-dd-device")!.pattern,
      hit: ["dd if=zero.img of=/dev/sda", "dd bs=4M if=x of=/dev/nvme0n1"],
      miss: ["dd if=a of=b.img", "cat /var/log/dd.log"],
    },
    {
      pattern: BUILTIN_DENY_PATTERNS.find((p) => p.id === "builtin-power")!.pattern,
      hit: ["shutdown -h now", "sudo reboot", "systemctl reboot", "init 0"],
      miss: ["systemctl status shutdown-helper", "grep reboot app.log"],
    },
    {
      pattern: BUILTIN_DENY_PATTERNS.find((p) => p.id === "builtin-rm-root")!.pattern,
      hit: ["rm -rf /", "rm -fr / ", "sudo rm --recursive --force /"],
      miss: ["rm -rf /tmp/build", "rm file.txt", "rm -rf ./"],
    },
    {
      pattern: BUILTIN_DENY_PATTERNS.find((p) => p.id === "builtin-forkbomb")!.pattern,
      hit: [":(){ :|:& };:", "bash -c ':() { :|:& };:'"],
      miss: ["echo 'func() { echo hi; };'"],
    },
  ];
  it("黑名单命中预期形态、放过良性形态；全部线性可编译", () => {
    for (const c of CASES) {
      const re = new RegExp(c.pattern);
      for (const h of c.hit) expect(re.test(h), `应命中: ${h}`).toBe(true);
      for (const m of c.miss) expect(re.test(m), `不应命中: ${m}`).toBe(false);
    }
  });
});

describe("buildHostExecAdoptDraft / validateAdoptPrefix", () => {
  it("草稿=前两个空白段；hostCode/命令缺失不出草稿", () => {
    expect(buildHostExecAdoptDraft({ hostCode: "ssh-homedb", command: "git -C /srv pull" }, { agentId: "a1" })).toEqual({
      hostCode: "ssh-homedb",
      prefix: "git -C",
      agentId: "a1",
    });
    expect(buildHostExecAdoptDraft({ command: "uptime" }, {})).toBeUndefined();
    expect(buildHostExecAdoptDraft({ hostCode: "ssh-homedb", command: "  " }, {})).toBeUndefined();
    expect(
      buildHostExecAdoptDraft({ hostCode: "ssh-homedb", command: "a; b" }, {}),
    ).toBeUndefined();
  });

  it("adopt 前缀终验：元字符/超长/空拒收", () => {
    expect(validateAdoptPrefix("systemctl is-active")).toBeUndefined();
    expect(validateAdoptPrefix("git push; rm")).toContain("不能包含");
    expect(validateAdoptPrefix("$(evil)")).toContain("不能包含");
    expect(validateAdoptPrefix("x".repeat(121))).toContain("120");
    expect(validateAdoptPrefix("  ")).toContain("空");
  });
});
