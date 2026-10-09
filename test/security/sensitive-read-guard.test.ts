import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchSensitiveRead,
  type SensitiveReadPolicy,
  sensitiveReadDenyMessage,
} from "../../src/domain/sensitive-read-guard.js";

// 2026-09-24 审计 H1/D3 回归锚点：服务端要害路径读守卫。
// 审批门未覆盖的 Bash/Read 直读（cat 生产库/部署目录/跨用户工作区）是
// 注入渗出主通道；守卫 = denyRoots 拦截 + allowReadRoots 豁免（allow 优先）。

const policy = (deny: string[], allow: string[] = []): SensitiveReadPolicy => ({
  denyRoots: deny,
  allowReadRoots: allow,
});

describe("matchSensitiveRead", () => {
  const deny = ["D:\\srv\\donger\\.deploy", "D:\\srv\\data", "D:\\code\\donger"];

  it("绝对路径直读要害文件 → 命中", () => {
    const hit = matchSensitiveRead("cat D:\\srv\\data\\donger.db", "C:\\w", policy(deny));
    expect(hit).toBeDefined();
  });

  it("正斜杠形态同样命中（Windows 路径归一）", () => {
    expect(matchSensitiveRead("cat D:/srv/data/donger.db", "C:\\w", policy(deny))).toBeDefined();
  });

  it("大小写不敏感（Windows 语义）", () => {
    expect(matchSensitiveRead("cat d:\\SRV\\DATA\\donger.db", "C:\\w", policy(deny))).toBeDefined();
  });

  it("相对路径 + .. 穿越进 deny 根 → 命中", () => {
    const hit = matchSensitiveRead(
      "cat ..\\..\\..\\srv\\data\\donger.db",
      "D:\\srv\\data\\users\\u1\\sessions\\c1\\workspace",
      policy(deny),
    );
    expect(hit).toBeDefined();
  });

  it("deny 根目录本身（git -C .deploy …）→ 命中", () => {
    expect(
      matchSensitiveRead("git -C D:/srv/donger/.deploy status", "C:\\w", policy(deny)),
    ).toBeDefined();
  });

  it("命令拼接/引号变体仍逐 token 命中", () => {
    expect(
      matchSensitiveRead("echo hi && cat 'D:\\srv\\data\\donger.db'", "C:\\w", policy(deny)),
    ).toBeDefined();
    expect(
      matchSensitiveRead("head -c 100 D:\\srv\\data\\donger.db | base64", "C:\\w", policy(deny)),
    ).toBeDefined();
  });

  it("本人工作区落在 deny 根之下 → allow 优先放行", () => {
    const home = "D:\\code\\donger\\data\\users\\u1";
    const p = policy(["D:\\code\\donger"], [home]);
    expect(
      matchSensitiveRead("cat D:\\code\\donger\\data\\users\\u1\\a.txt", "C:\\w", p),
    ).toBeUndefined();
  });

  it("allow 只豁免自己：他人工作区仍拦截", () => {
    const p = policy(["D:\\code\\donger"], ["D:\\code\\donger\\data\\users\\u1"]);
    expect(
      matchSensitiveRead("cat D:\\code\\donger\\data\\users\\u2\\secret.txt", "C:\\w", p),
    ).toBeDefined();
  });

  it("普通工作区命令不误伤", () => {
    const p = policy(deny, ["D:\\code\\donger\\data\\users\\u1"]);
    expect(
      matchSensitiveRead(
        "node .tmp/run.js && python ../..\\x.py",
        join("D:\\code\\donger\\data\\users\\u1", "sessions", "c1", "workspace"),
        p,
      ),
    ).toBeUndefined();
    expect(matchSensitiveRead("git log --oneline", "C:\\w", p)).toBeUndefined();
    expect(matchSensitiveRead("echo hello world", "C:\\w", p)).toBeUndefined();
  });

  it("空 denyRoots 恒放行（未装配=不启用守卫）", () => {
    expect(matchSensitiveRead("cat D:\\srv\\data\\donger.db", "C:\\w", policy([]))).toBeUndefined();
  });

  it("Read 工具路径探测同样命中", () => {
    expect(matchSensitiveRead("D:\\srv\\data\\donger.db", undefined, policy(deny))).toBeDefined();
  });

  it("命中结果带 resolved 绝对路径（供调用方判存在性）", () => {
    const hit = matchSensitiveRead(
      "cat ..\\..\\..\\srv\\data\\donger.db",
      "D:\\srv\\data\\users\\u1\\workspace",
      policy(deny),
    );
    expect(hit?.resolved).toBe("D:\\srv\\data\\srv\\data\\donger.db");
  });

  it("拒绝消息含触发 token 与根路径", () => {
    const hit = matchSensitiveRead("cat D:\\srv\\data\\donger.db", "C:\\w", policy(deny));
    expect(hit).toBeDefined();
    const msg = sensitiveReadDenyMessage(hit!);
    expect(msg).toContain("donger.db");
  });

  it("不存在的路径报「路径不存在」而非「保护路径」（2026-09-28 生产误导修复）", () => {
    const hit = matchSensitiveRead(
      "cat D:\\srv\\data\\users\\sessions\\x.png",
      "C:\\w",
      policy(deny),
    );
    if (!hit) throw new Error("应命中");
    const missing = sensitiveReadDenyMessage(hit, false);
    expect(missing).toContain("路径不存在");
    expect(missing).not.toContain("保护路径");
    const existing = sensitiveReadDenyMessage(hit, true);
    expect(existing).toContain("保护路径");
  });
});

// 2026-10-09 拍板②（c385dc71 越权复盘）：读边界系统级升级——agent 只能读本人用户
// 目录（allowReadRoots）内的内容，目录外一律拒绝（不走审批、权限模式不豁免）。
describe("matchSensitiveRead confine 模式（系统级读边界）", () => {
  const home = "D:\\deploy\\donger\\data\\workspace\\users\\u1";
  const cwd = join(home, "agents", "a1", "workspace");
  const confine = (
    allow: string[] = [home],
    deny: string[] = ["D:\\deploy\\donger\\data", "D:\\deploy\\donger"],
  ) => ({
    denyRoots: deny,
    allowReadRoots: allow,
    mode: "confine" as const,
  });

  it("用户目录外直读（D:\\git、他人主目录、盘根列举）→ 越界命中", () => {
    for (const cmd of [
      "cat D:\\git\\copilot-skills\\README.md",
      "ls /c/Users/admin/.claude/projects",
      "for base in /d/ /e/ /c/Users/admin; do find $base -maxdepth 3; done",
    ]) {
      const hit = matchSensitiveRead(cmd, cwd, confine());
      expect(hit, cmd).toBeDefined();
      expect(hit?.kind, cmd).toBe("outside-allowed");
    }
  });

  it("本人目录内（含 MSYS 记法、.. 回退不出界）→ 放行", () => {
    expect(
      matchSensitiveRead(
        "cat D:\\deploy\\donger\\data\\workspace\\users\\u1\\a.txt",
        cwd,
        confine(),
      ),
    ).toBeUndefined();
    expect(
      matchSensitiveRead("cat ../../../agents/a1/workspace/x.md", cwd, confine()),
    ).toBeUndefined();
    expect(matchSensitiveRead("grep -rn x ./notes.md", cwd, confine())).toBeUndefined();
  });

  it(".. 穿越出本人目录且出全部保护根 → 越界命中", () => {
    // cwd=data\workspace\users\u1\agents\a1\workspace，八层回退到 D:\deploy
    const hit = matchSensitiveRead("cat ..\\..\\..\\..\\..\\..\\..\\..\\git\\x.md", cwd, confine());
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("outside-allowed");
  });

  it("denyRoots 命中优先报「保护路径」（critical），目录外报「读取越界」", () => {
    const critical = matchSensitiveRead("cat D:\\deploy\\donger\\.env", "C:\\w", confine());
    if (critical?.kind !== "critical") throw new Error("应命中 critical");
    expect(sensitiveReadDenyMessage(critical, true)).toContain("保护路径");
    const outside = matchSensitiveRead("cat D:\\git\\x.md", "C:\\w", confine());
    if (outside?.kind !== "outside-allowed") throw new Error("应命中 outside-allowed");
    const msg = sensitiveReadDenyMessage(outside, true);
    expect(msg).toContain("读取越界");
    expect(msg).toContain("系统级限制");
  });

  it("KB 平台目录不在本人目录下 → 命中（kb_* 工具通道收口）", () => {
    const hit = matchSensitiveRead(
      "grep -rn x /d/deploy/donger/data/workspace/kb/65a3f6ad/memory",
      cwd,
      confine(),
    );
    expect(hit).toBeDefined();
  });

  it("MSYS 虚拟设备不误伤（2>/dev/null）；~/ 宿主 home 越界命中", () => {
    expect(
      matchSensitiveRead("grep -rn x ./a.md 2>/dev/null | head -3", cwd, confine()),
    ).toBeUndefined();
    expect(matchSensitiveRead("cat ~/.ssh/id_rsa", cwd, confine())).toBeDefined();
  });

  it("allow 为空时全拒（防御性装配错误不静默放行）", () => {
    expect(matchSensitiveRead("cat ./notes.md", cwd, confine([]))).toBeDefined();
  });

  it("缺省 mode=critical 保持旧行为：目录外非要害路径放行", () => {
    expect(
      matchSensitiveRead("cat D:\\git\\x.md", "C:\\w", policy(["D:\\deploy\\donger\\data"])),
    ).toBeUndefined();
  });
});

// 2026-10-09 拍板①（同轮）：MSYS 盘符记法归一——Git Bash 的 /d/foo ≡ D:\foo，
// Node resolve 曾把前者解析成 D:\d\foo 幻影路径致守卫比对全落空（c385dc71 实证：
// Windows 记法 .env 被拦、MSYS 记法平台数据目录直读放行）。win32 专属行为。
describe.skipIf(process.platform !== "win32")("matchSensitiveRead MSYS 记法归一（win32）", () => {
  const deny = ["D:\\deploy\\donger\\data"];
  const critical = (allow: string[] = []) => policy(deny, allow);

  it("critical：MSYS 记法的要害目录直读 → 命中（c385dc71 回归锚点）", () => {
    const hit = matchSensitiveRead(
      "grep -rn x /d/deploy/donger/data/workspace/kb/65a3f6ad/",
      "C:\\w",
      critical(),
    );
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("critical");
  });

  it("critical：MSYS 记法全盘列举（find /d/ /e/ /c/Users）→ 越出 deny 根不误报", () => {
    // 盘根不在 denyRoots：critical 模式放行（收口由 confine 承担），但不得解析成幻影路径
    expect(
      matchSensitiveRead("for b in /d/ /e/; do find $b; done", "C:\\w", critical()),
    ).toBeUndefined();
  });

  it("confine：MSYS 记法的本人目录引用放行（归一是 confine 可用的前置）", () => {
    const home = "D:\\deploy\\donger\\data\\workspace\\users\\u1";
    const p = { ...critical([home]), mode: "confine" as const };
    expect(
      matchSensitiveRead(
        "cd /d/deploy/donger/data/workspace/users/u1/agents/a1/workspace && ls",
        "C:\\w",
        p,
      ),
    ).toBeUndefined();
  });

  it("confine：MSYS 记法的目录外路径（/d/git、/c/Users/admin）→ 越界命中", () => {
    const home = "D:\\deploy\\donger\\data\\workspace\\users\\u1";
    const p = { ...critical([home]), mode: "confine" as const };
    const hit = matchSensitiveRead("cat /d/git/copilot-skills/README.md", "C:\\w", p);
    expect(hit).toBeDefined();
    expect(hit?.resolved.toLowerCase()).toBe("d:/git/copilot-skills/readme.md");
    expect(matchSensitiveRead("ls /c/Users/admin", "C:\\w", p)).toBeDefined();
  });

  it("UNC（//server/share）不做盘符改写", () => {
    expect(matchSensitiveRead("ls //srv/share/x", "C:\\w", critical())).toBeUndefined();
  });
});
