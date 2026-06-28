import { existsSync, rmSync } from "node:fs";
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
});
