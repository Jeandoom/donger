import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExtensionDirectoryResolver } from "../../src/adapters/local-extension-directory-resolver.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalExtensionDirectoryResolver", () => {
  it("解析真实目录并把缺失路径降级为 unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(root);
    const resolver = new LocalExtensionDirectoryResolver();
    const result = await resolver.resolve([
      { id: "ok", name: "docs", path: root, access: "readWrite" },
      { id: "missing", name: "missing", path: join(root, "none"), access: "readOnly" },
    ]);
    expect(result.available[0]?.path).toBe(root);
    expect(result.unavailable[0]?.id).toBe("missing");
  });

  it("拒绝文件路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-dir-"));
    roots.push(root);
    const file = join(root, "a.txt");
    writeFileSync(file, "x");
    const result = await new LocalExtensionDirectoryResolver().resolve([
      { id: "file", name: "file", path: file, access: "readOnly" },
    ]);
    expect(result.available).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain("不是目录");
  });
});
