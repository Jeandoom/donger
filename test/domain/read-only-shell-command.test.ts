import { describe, expect, it } from "vitest";
import { isReadOnlyShellCommand } from "../../src/domain/read-only-shell-command.js";

describe("isReadOnlyShellCommand", () => {
  it("git 只读子命令 → true（含 -C 路径与 rtk 包装）", () => {
    expect(isReadOnlyShellCommand("git fetch origin release-202608-1")).toBe(true);
    expect(isReadOnlyShellCommand('git -C repos/aix-py ls-remote --heads origin')).toBe(true);
    expect(isReadOnlyShellCommand("git log --oneline -5")).toBe(true);
    expect(isReadOnlyShellCommand("git rev-parse HEAD")).toBe(true);
  });

  it("git 写操作子命令 → false（branch/remote 带参数可写，保守归写）", () => {
    expect(isReadOnlyShellCommand("git push origin master")).toBe(false);
    expect(isReadOnlyShellCommand("git clone https://x.com/a/b.git")).toBe(false);
    expect(isReadOnlyShellCommand("git commit -m x")).toBe(false);
    expect(isReadOnlyShellCommand("git branch new-branch")).toBe(false);
    expect(isReadOnlyShellCommand("rtk git branch -a")).toBe(false);
    expect(isReadOnlyShellCommand("git remote add up https://x.com/a/b.git")).toBe(false);
  });

  it("curl GET 型 → true，带请求体/非 GET 方法 → false", () => {
    expect(isReadOnlyShellCommand('curl -s "https://jihulab.com/api/v4/branches"')).toBe(true);
    expect(isReadOnlyShellCommand('rtk curl "https://api.open-meteo.com/v1/forecast?lat=1"')).toBe(
      true,
    );
    expect(isReadOnlyShellCommand('curl -X POST -d "{}" https://x.com/api')).toBe(false);
    expect(isReadOnlyShellCommand('curl -d @body.json https://x.com/api')).toBe(false);
    expect(isReadOnlyShellCommand("curl -T file.txt https://x.com/up")).toBe(false);
    expect(isReadOnlyShellCommand("curl --request DELETE https://x.com/api/1")).toBe(false);
  });

  it("组合命令：任一段有写操作即整体不算只读", () => {
    expect(isReadOnlyShellCommand("git log && git push origin main")).toBe(false);
    expect(isReadOnlyShellCommand("git status; curl -s https://x.com")).toBe(true);
  });

  it("非 git/curl 命令 → false（门行为不变）", () => {
    expect(isReadOnlyShellCommand("ls -la")).toBe(false);
    expect(isReadOnlyShellCommand("npm run deploy")).toBe(false);
    expect(isReadOnlyShellCommand("")).toBe(false);
  });
});
