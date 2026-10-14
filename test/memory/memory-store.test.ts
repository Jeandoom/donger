import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/memory-store.js";

let dir: string;
beforeEach(() => {
  dir = join(tmpdir(), `donger-mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MemoryStore", () => {
  it("append → search 命中", () => {
    const m = new MemoryStore(dir);
    m.append({ summary: "GLM 的 thinking 需关闭", detail: "GLM-5.2 不支持 thinking.type=enabled" });
    m.append({ summary: "钉钉 msgKey 小写", detail: "sampleText 不是 SampleTextMessage" });
    const hits = m.search("GLM");
    expect(hits.length).toBe(1);
    expect(hits[0]?.summary).toContain("GLM");
  });

  it("search 大小写不敏感 + 匹配 detail", () => {
    const m = new MemoryStore(dir);
    m.append({ summary: "部署经验", detail: "用 Docker 隔离更安全" });
    expect(m.search("docker").length).toBe(1);
    expect(m.search("DOCKER").length).toBe(1);
  });

  it("list 全部 + 按 filename 倒序", () => {
    const m = new MemoryStore(dir);
    m.append({ summary: "第一条", detail: "a" });
    m.append({ summary: "第二条", detail: "b" });
    const all = m.list();
    expect(all.length).toBe(2);
    expect(all[0]?.summary).toBe("第二条"); // 最新在前
  });

  it("list 带 filename", () => {
    const m = new MemoryStore(dir);
    const fn = m.append({ summary: "测试", detail: "x" });
    const all = m.list();
    expect(all[0]?.filename).toBe(fn);
  });

  it("remove 删除一条", () => {
    const m = new MemoryStore(dir);
    const fn = m.append({ summary: "待删", detail: "x" });
    expect(m.list().length).toBe(1);
    m.remove(fn);
    expect(m.list().length).toBe(0);
  });

  it("不命中返回空", () => {
    const m = new MemoryStore(dir);
    m.append({ summary: "hello", detail: "world" });
    expect(m.search("不存在的关键词")).toEqual([]);
  });

  it("空目录 list 返回空数组", () => {
    const m = new MemoryStore(dir);
    expect(m.list()).toEqual([]);
  });

  // ---- 目录分层（知识体系轮 P1）：auto/ 子目录承接 legacy 倾倒 ----

  it("append 到 auto/ 子目录：list/search 递归可见，curated/ 不参与", () => {
    const m = new MemoryStore(dir);
    m.append({ summary: "旧顶层条目", detail: "top" });
    m.append({ summary: "auto 倾倒条目", detail: "dump" }, { subdir: "auto" });
    // curated/ 与 archive/ 不参与注入
    mkdirSync(join(dir, "curated"), { recursive: true });
    writeFileSync(join(dir, "curated", "1-x.md"), "# 精选条目\n\n Katz\n", "utf8");
    const all = m.list();
    expect(all.length).toBe(2);
    expect(all.map((e) => e.summary).sort()).toEqual(["auto 倾倒条目", "旧顶层条目"]);
    expect(all.find((e) => e.summary === "auto 倾倒条目")?.filename).toMatch(/^auto\//);
    expect(m.search("dump").length).toBe(1);
    expect(m.search("Katz")).toEqual([]);
  });

  it("auto/ 子目录按时间戳倒序混排（新倾倒在前）", () => {
    const m = new MemoryStore(dir);
    m.append({ summary: "倾倒1", detail: "a" }, { subdir: "auto" });
    m.append({ summary: "倾倒2", detail: "b" }, { subdir: "auto" });
    const all = m.list();
    expect(all.map((e) => e.summary)).toEqual(["倾倒2", "倾倒1"]);
  });

  it("remove 支持 auto/ 前缀文件名", () => {
    const m = new MemoryStore(dir);
    const fn = m.append({ summary: "待删", detail: "x" }, { subdir: "auto" });
    expect(fn).toMatch(/^auto\//);
    m.remove(fn);
    expect(m.list()).toEqual([]);
  });

  // ---- curated 通道（知识体系轮 P2）----

  it("readCuratedIndex：不存在返回 null；存在返回文本与行数", () => {
    const m = new MemoryStore(dir);
    expect(m.readCuratedIndex()).toBeNull();
    mkdirSync(join(dir, "curated"), { recursive: true });
    writeFileSync(join(dir, "curated", "INDEX.md"), "- [部署执行器](a.md) — 钩子\n", "utf8");
    const idx = m.readCuratedIndex();
    expect(idx?.lines).toBe(1);
    expect(idx?.text).toContain("部署执行器");
    expect(idx?.truncated).toBe(false);
  });

  it("readCuratedIndex：超 200 行截断到 200 并标记", () => {
    const m = new MemoryStore(dir);
    mkdirSync(join(dir, "curated"), { recursive: true });
    const many = Array.from({ length: 230 }, (_, i) => `- [条目${i}](f${i}.md) — 钩子`);
    writeFileSync(join(dir, "curated", "INDEX.md"), many.join("\n"), "utf8");
    const idx = m.readCuratedIndex();
    expect(idx?.lines).toBe(230);
    expect(idx?.truncated).toBe(true);
    expect(idx?.text.split("\n").length).toBe(200);
  });

  it("listCurated 排除 INDEX.md；countLegacyTopLevel 只数顶层文件", () => {
    const m = new MemoryStore(dir);
    mkdirSync(join(dir, "curated"), { recursive: true });
    writeFileSync(join(dir, "curated", "INDEX.md"), "", "utf8");
    writeFileSync(join(dir, "curated", "2-a.md"), "# 精选A\n\nx", "utf8");
    writeFileSync(join(dir, "1-top.md"), "# 旧顶层\n\nx", "utf8");
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(join(dir, "archive", "0-old.md"), "# 归档\n\nx", "utf8");
    expect(m.listCurated().map((c) => c.filename)).toEqual(["curated/2-a.md"]);
    expect(m.listCurated()[0]?.summary).toBe("精选A");
    expect(m.countLegacyTopLevel()).toBe(1);
  });

  it("migrateLegacyToArchive：顶层 md 移入 archive/，curated 不动", () => {
    const m = new MemoryStore(dir);
    mkdirSync(join(dir, "curated"), { recursive: true });
    writeFileSync(join(dir, "curated", "keep.md"), "# keep\n", "utf8");
    writeFileSync(join(dir, "a.md"), "# a\n", "utf8");
    writeFileSync(join(dir, "b.md"), "# b\n", "utf8");
    const moved = m.migrateLegacyToArchive();
    expect(moved).toBe(2);
    expect(existsSync(join(dir, "archive", "a.md"))).toBe(true);
    expect(existsSync(join(dir, "archive", "b.md"))).toBe(true);
    expect(existsSync(join(dir, "curated", "keep.md"))).toBe(true);
    expect(m.countLegacyTopLevel()).toBe(0);
  });
});
