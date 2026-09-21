import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExtensionDirectoryResolver } from "../../src/adapters/local-extension-directory-resolver.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalExtensionDirectoryResolver（锚定用户工作区根）", () => {
  it("相对路径解析到 anchor 下，缺失路径降级 unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(home);
    mkdirSync(join(home, "docs"), { recursive: true });
    const resolver = new LocalExtensionDirectoryResolver();
    const result = await resolver.resolve(
      [
        { id: "ok", name: "docs", path: "docs", access: "readWrite" },
        { id: "missing", name: "missing", path: join(home, "none"), access: "readOnly" },
      ],
      home,
    );
    expect(result.available[0]?.path).toBe(join(home, "docs"));
    expect(result.unavailable[0]?.id).toBe("missing");
  });

  it("存量绝对路径条目降级并给出改写提示", async () => {
    const home = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(home);
    const result = await new LocalExtensionDirectoryResolver().resolve(
      [{ id: "abs", name: "abs", path: join(tmpdir(), "whatever"), access: "readWrite" }],
      home,
    );
    expect(result.available).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain("相对路径");
  });

  it("拒绝文件路径", async () => {
    const home = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(home);
    const file = join(home, "a.txt");
    writeFileSync(file, "x");
    const result = await new LocalExtensionDirectoryResolver().resolve(
      [{ id: "file", name: "file", path: "a.txt", access: "readOnly" }],
      home,
    );
    expect(result.available).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain("不是目录");
  });

  it(".. 上跳与路径中的 .. 分量被锚点复判拦截", async () => {
    const home = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(home);
    const result = await new LocalExtensionDirectoryResolver().resolve(
      [
        { id: "up1", name: "up1", path: "..", access: "readWrite" },
        { id: "up2", name: "up2", path: "docs/../../elsewhere", access: "readWrite" },
      ],
      home,
    );
    expect(result.available).toEqual([]);
    expect(result.unavailable).toHaveLength(2);
  });

  it("workspace 内 symlink/junction 指向锚点外 → unavailable（防逃逸）", async () => {
    const home = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(home);
    const outside = mkdtempSync(join(tmpdir(), "extension-outside-"));
    roots.push(outside);
    mkdirSync(join(home, "docs"), { recursive: true });
    // win32 junction 无需管理员；POSIX 走目录 symlink
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, join(home, "escape"), linkType);
    const result = await new LocalExtensionDirectoryResolver().resolve(
      [{ id: "esc", name: "escape", path: "escape", access: "readWrite" }],
      home,
    );
    expect(result.available).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain("越界");
  });

  it("锚点自身不可用 → 全部降级", async () => {
    const missing = join(tmpdir(), `extension-anchor-missing-${Date.now()}`);
    const result = await new LocalExtensionDirectoryResolver().resolve(
      [{ id: "d", name: "docs", path: "docs", access: "readWrite" }],
      missing,
    );
    expect(result.available).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain("工作区根目录不可用");
  });
});
