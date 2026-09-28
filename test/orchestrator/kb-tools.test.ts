import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kbToolDefinitions, safeResolveKbPath } from "../../src/orchestrator/kb-tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "donger-kb-tools-"));
  roots.push(root);
  mkdirSync(join(root, "knowledges", "faq"), { recursive: true });
  writeFileSync(join(root, "knowledges", "faq", "订单.md"), "# 订单\n如何退款：联系客服。\n");
  writeFileSync(join(root, "knowledges", "notes.txt"), "misc note\n");
  writeFileSync(join(root, "knowledges", "research.md"), "# 调研\n退款流程 v2 天概览。\n");
  return root;
}

function findTool(tools: ReturnType<typeof kbToolDefinitions>, name: string) {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t;
}

describe("safeResolveKbPath", () => {
  it("允许根内相对路径", () => {
    const root = freshRoot();
    expect(safeResolveKbPath(root, "knowledges/faq/订单.md")).toBe(
      join(root, "knowledges", "faq", "订单.md"),
    );
  });
  it("拒绝 .. 逃逸", () => {
    const root = freshRoot();
    expect(safeResolveKbPath(root, "../outside.md")).toBeUndefined();
    expect(safeResolveKbPath(root, "knowledges/../../x")).toBeUndefined();
  });
  it("拒绝绝对路径指向根外", () => {
    const root = freshRoot();
    expect(safeResolveKbPath(root, join(tmpdir(), "elsewhere.md"))).toBeUndefined();
  });
});

describe("donger-kb 工具", () => {
  it("kb_list：目录树与子目录过滤", async () => {
    const root = freshRoot();
    const tools = kbToolDefinitions({ kbRoot: root });
    const all = await findTool(tools, "kb_list").handler({});
    expect(all.content[0]?.text).toContain("knowledges/faq/订单.md");
    const sub = await findTool(tools, "kb_list").handler({ subdir: "knowledges/faq" });
    expect(sub.content[0]?.text).toContain("订单.md");
    expect(sub.content[0]?.text).not.toContain("notes.txt");
  });

  it("kb_read：读取内容；越界路径拒绝", async () => {
    const root = freshRoot();
    const tools = kbToolDefinitions({ kbRoot: root });
    const r = await findTool(tools, "kb_read").handler({ path: "knowledges/faq/订单.md" });
    expect(r.content[0]?.text).toContain("如何退款");
    const bad = await findTool(tools, "kb_read").handler({ path: "../../etc/passwd" });
    expect(bad.isError).toBe(true);
  });

  it("kb_search：结构化命中（path/line/snippet）；glob 过滤；无命中空数组", async () => {
    const root = freshRoot();
    const tools = kbToolDefinitions({ kbRoot: root });
    const r = await findTool(tools, "kb_search").handler({ query: "退款" });
    const body = JSON.parse(r.content[0]?.text ?? "{}") as {
      total: number;
      truncated: boolean;
      hits: Array<{ path: string; line: number; snippet: string }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.hits.some((h) => h.path === "knowledges/faq/订单.md" && h.line === 2)).toBe(true);
    expect(body.hits.some((h) => h.path === "knowledges/research.md" && h.line === 2)).toBe(true);
    expect(body.hits[0]?.snippet).toBeTruthy();
    const mdOnly = await findTool(tools, "kb_search").handler({
      query: "note",
      glob: "*.md",
    });
    const mdBody = JSON.parse(mdOnly.content[0]?.text ?? "{}") as { total: number };
    expect(mdBody.total).toBe(0);
  });

  it("kb_write：自动建目录写入并可读回；写根目录拒绝；越界拒绝", async () => {
    const root = freshRoot();
    const tools = kbToolDefinitions({ kbRoot: root });
    const r = await findTool(tools, "kb_write").handler({
      path: "knowledges/research/2026-09-09-凭证集调研.md",
      content: "# 调研\n来源：内部评审，2026-09-09。",
    });
    expect(r.isError).toBeUndefined();
    const read = await findTool(tools, "kb_read").handler({
      path: "knowledges/research/2026-09-09-凭证集调研.md",
    });
    expect(read.content[0]?.text).toContain("来源：内部评审");
    const rootWrite = await findTool(tools, "kb_write").handler({
      path: ".",
      content: "x",
    });
    expect(rootWrite.isError).toBe(true);
    const escWrite = await findTool(tools, "kb_write").handler({
      path: "../evil.md",
      content: "x",
    });
    expect(escWrite.isError).toBe(true);
  });
});

describe("donger-kb 工具 v2（按库寻址，spec §8）", () => {
  function twoMountTools(onChange?: Parameters<typeof kbToolDefinitions>[0]["onChange"]) {
    const rootA = freshRoot();
    const rootB = freshRoot();
    writeFileSync(join(rootA, "a.md"), "# A\n库A内容\n", "utf8");
    writeFileSync(join(rootB, "b.md"), "# B\n库B内容\n", "utf8");
    return kbToolDefinitions({
      mounts: [
        { kbId: "kb-a", name: "库A", root: rootA, writable: true },
        { kbId: "kb-b", name: "库B", root: rootB, writable: false },
      ],
      defaultKbId: "kb-a",
      onChange,
    });
  }

  it("kb_list 多库无参 → 挂载清单（含只读标记）", async () => {
    const tools = twoMountTools();
    const r = await findTool(tools, "kb_list").handler({});
    const text = r.content[0]?.text ?? "";
    expect(text).toContain("kbId=kb-a");
    expect(text).toContain("可写");
    expect(text).toContain("kbId=kb-b");
    expect(text).toContain("只读");
  });

  it("kb_read 缺省回落 defaultKbId；指定 kbId 读对应库", async () => {
    const tools = twoMountTools();
    const a = await findTool(tools, "kb_read").handler({ path: "a.md" });
    expect(a.content[0]?.text).toContain("库A内容");
    const b = await findTool(tools, "kb_read").handler({ kbId: "kb-b", path: "b.md" });
    expect(b.content[0]?.text).toContain("库B内容");
    const unknown = await findTool(tools, "kb_read").handler({ kbId: "kb-x", path: "a.md" });
    expect(unknown.isError).toBe(true);
  });

  it("kb_write 缺省写主库并回调记账；只读库拒绝", async () => {
    const changes: Array<{ kbId: string; path: string; action: string }> = [];
    const tools = twoMountTools(async (e) => {
      changes.push({ kbId: e.kbId, path: e.path, action: e.action });
    });
    const write = await findTool(tools, "kb_write").handler({
      path: "new/条目.md",
      content: "# 新条目",
    });
    expect(write.isError).toBeUndefined();
    expect(changes).toEqual([{ kbId: "kb-a", path: "new/条目.md", action: "create" }]);
    const ro = await findTool(tools, "kb_write").handler({
      kbId: "kb-b",
      path: "x.md",
      content: "x",
    });
    expect(ro.isError).toBe(true);
    expect(ro.content[0]?.text).toContain("只读");
  });

  it("kb_write expectedHash 乐观锁：hash 不匹配拒绝", async () => {
    const tools = twoMountTools();
    const bad = await findTool(tools, "kb_write").handler({
      path: "a.md",
      content: "overwrite",
      expectedHash: "deadbeef",
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("重新 kb_read");
  });

  it("kb_delete 可写库删除+记账；只读库拒绝", async () => {
    const changes: Array<{ path: string; action: string }> = [];
    const tools = twoMountTools(async (e) => {
      changes.push({ path: e.path, action: e.action });
    });
    const del = await findTool(tools, "kb_delete").handler({ path: "a.md" });
    expect(del.isError).toBeUndefined();
    expect(changes).toEqual([{ path: "a.md", action: "delete" }]);
    const ro = await findTool(tools, "kb_delete").handler({ kbId: "kb-b", path: "b.md" });
    expect(ro.isError).toBe(true);
  });

  it('kb_search "all" 跨库检索并带 kbId 溯源', async () => {
    const tools = twoMountTools();
    const r = await findTool(tools, "kb_search").handler({ query: "内容", kbId: "all" });
    const body = JSON.parse(r.content[0]?.text ?? "{}") as {
      hits: Array<{ kbId: string; path: string }>;
    };
    expect(body.hits.some((h) => h.kbId === "kb-a" && h.path === "a.md")).toBe(true);
    expect(body.hits.some((h) => h.kbId === "kb-b" && h.path === "b.md")).toBe(true);
  });

  it("kb_search FTS 优先：ftsSearch 命中文件做行级定位；0 命中回落 grep", async () => {
    const root = freshRoot();
    const tools = kbToolDefinitions({
      kbRoot: root,
      ftsSearch: (kbIds, query) =>
        // 影子索引只返回一个命中文件（模拟索引先过滤），行级定位仍能给出多行命中
        query.includes("退款") ? [{ kbId: kbIds[0] ?? "", path: "knowledges/research.md" }] : [],
    });
    const r = await findTool(tools, "kb_search").handler({ query: "退款" });
    const body = JSON.parse(r.content[0]?.text ?? "{}") as {
      hits: Array<{ path: string }>;
    };
    expect(body.hits.every((h) => h.path === "knowledges/research.md")).toBe(true);
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
  });
});
