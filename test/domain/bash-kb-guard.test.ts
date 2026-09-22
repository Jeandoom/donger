import { describe, expect, it } from "vitest";
import { bashKbWriteGuard, kbRootPathVariants } from "../../src/domain/bash-kb-guard.js";

/** KB 目录 Bash 写守卫（spec §9，D6）：写模式+库根变体 → blocked；只读放行 */

const WIN_ROOT = "D:\\code\\kbdata\\kb\\kb-1";
const roots = [WIN_ROOT];

describe("kbRootPathVariants", () => {
  it("生成 Windows/正斜杠/MSYS/WSL 形态变体", () => {
    const variants = kbRootPathVariants(WIN_ROOT);
    expect(variants).toContain("d:\\code\\kbdata\\kb\\kb-1");
    expect(variants).toContain("d:/code/kbdata/kb/kb-1");
    expect(variants).toContain("/d/code/kbdata/kb/kb-1");
    expect(variants).toContain("/mnt/d/code/kbdata/kb/kb-1");
  });
});

describe("bashKbWriteGuard", () => {
  it("重定向写库目录 → blocked（MSYS 形态）", () => {
    expect(bashKbWriteGuard("cat x > /d/code/kbdata/kb/kb-1/evil.md", roots).blocked).toBe(true);
  });

  it("Windows 路径形态重定向 → blocked", () => {
    expect(
      bashKbWriteGuard('echo x >> "D:/code/kbdata/kb/kb-1/notes/a.md"', roots).blocked,
    ).toBe(true);
  });

  it("rm/cp/mv/tee/sed -i 写库目录 → blocked", () => {
    expect(bashKbWriteGuard(`rm -rf '${WIN_ROOT}\\sub'`, roots).blocked).toBe(true);
    expect(bashKbWriteGuard(`cp a.md d:/code/kbdata/kb/kb-1/b.md`, roots).blocked).toBe(true);
    expect(bashKbWriteGuard(`cat a | tee /d/code/kbdata/kb/kb-1/c.md`, roots).blocked).toBe(true);
    expect(bashKbWriteGuard(`sed -i 's/a/b/' D:/code/kbdata/kb/kb-1/x.md`, roots).blocked).toBe(
      true,
    );
  });

  it("只读命令（cat/ls/grep 库目录）放行", () => {
    expect(bashKbWriteGuard("ls /d/code/kbdata/kb/kb-1", roots).blocked).toBe(false);
    expect(bashKbWriteGuard(`cat "D:/code/kbdata/kb/kb-1/readme.md"`, roots).blocked).toBe(false);
    expect(bashKbWriteGuard("grep -r 退款 /d/code/kbdata/kb/kb-1 | head", roots).blocked).toBe(
      false,
    );
  });

  it("写其它目录（非库根）放行", () => {
    expect(bashKbWriteGuard("echo x > /d/elsewhere/a.md", roots).blocked).toBe(false);
    expect(bashKbWriteGuard("rm -rf ./build", roots).blocked).toBe(false);
  });

  it("空守卫根清单一律放行", () => {
    expect(bashKbWriteGuard("rm -rf /d/code/kbdata/kb/kb-1", []).blocked).toBe(false);
  });

  it("库根是其它目录前缀时不误伤（前缀完整性）", () => {
    // /d/code/kbdata/kb/kb-10 以 kb-1 为前缀但不是其子路径
    expect(bashKbWriteGuard("ls /d/code/kbdata/kb/kb-10/readme.md", roots).blocked).toBe(false);
    expect(bashKbWriteGuard("rm -rf /d/code/kbdata/kb/kb-10", roots).blocked).toBe(false);
  });
});
