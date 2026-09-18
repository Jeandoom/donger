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

  it("kb_search：关键词命中带 文件:行号；glob 过滤；无命中提示", async () => {
    const root = freshRoot();
    const tools = kbToolDefinitions({ kbRoot: root });
    const r = await findTool(tools, "kb_search").handler({ query: "退款" });
    const text = r.content[0]?.text ?? "";
    expect(text).toContain("knowledges/faq/订单.md:2");
    expect(text).toContain("knowledges/research.md:2");
    const mdOnly = await findTool(tools, "kb_search").handler({
      query: "note",
      glob: "*.md",
    });
    expect(mdOnly.content[0]?.text).toContain("无命中");
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
    const escape = await findTool(tools, "kb_write").handler({
      path: "../evil.md",
      content: "x",
    });
    expect(escape.isError).toBe(true);
  });
});
