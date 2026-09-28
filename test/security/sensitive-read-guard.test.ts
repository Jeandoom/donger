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

  it("拒绝消息含触发 token 与根路径", () => {
    const hit = matchSensitiveRead("cat D:\\srv\\data\\donger.db", "C:\\w", policy(deny));
    expect(hit).toBeDefined();
    const msg = sensitiveReadDenyMessage(hit!);
    expect(msg).toContain("donger.db");
  });
});
