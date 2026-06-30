import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveStaticFile } from "../../src/adapters/web-channel";

function makeWebRoot(): string {
  return mkdtempSync(join(tmpdir(), "webroot-"));
}

/** 写文件并自动创建父目录（writeFileSync 不会自动建目录） */
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("resolveStaticFile", () => {
  let root: string;
  beforeEach(() => {
    root = makeWebRoot();
  });

  it("有 dist 时，/ 返回 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/");
    expect(r?.kind).toBe("file");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
    expect(existsSync(r?.absPath ?? "")).toBe(true);
  });

  it("有 dist 时，/index.html 返回 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/index.html");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("有 dist 时，未知路径走 SPA fallback 到 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/agents");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("有 dist 时，/assets 下真实文件直返", () => {
    write(root, "dist/index.html", "built");
    write(root, "dist/assets/app.js", "// js");
    const r = resolveStaticFile(root, "/assets/app.js");
    expect(r?.absPath).toBe(join(root, "dist", "assets", "app.js"));
  });

  it("有 dist 时，/assets 缺失文件返回 null（404）", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/assets/missing.js");
    expect(r).toBeNull();
  });

  it("无 dist 时，/ 返回 null（未构建）", () => {
    const r = resolveStaticFile(root, "/");
    expect(r).toBeNull();
  });

  it("无 dist 时，未知路径返回 null", () => {
    const r = resolveStaticFile(root, "/agents");
    expect(r).toBeNull();
  });
});
