import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cjkSpace, createKbFts, ftsPhrase, migrateKbFts } from "../../src/util/kb-fts.js";

/**
 * FTS 三列式影子表（R-A）：中文 0 命中回归——默认 unicode61 对中文整串成 token，
 * seg=cjkSpace 逐字切分 + ftsPhrase 短语化后必须命中；短语保证字序；空/纯符号查询回落。
 */

let db: Database.Database;
let fts: ReturnType<typeof createKbFts>;
const tmpDirs: string[] = [];

beforeEach(() => {
  db = new Database(":memory:");
  migrateKbFts(db);
  fts = createKbFts(db);
});

afterEach(() => {
  db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cjkSpace / ftsPhrase", () => {
  it("cjkSpace：CJK 逐字空格化，英文词保持，空白归一", () => {
    expect(cjkSpace("退款流程")).toBe("退 款 流 程");
    expect(cjkSpace("退款refund流程")).toBe("退 款 refund 流 程");
    expect(cjkSpace("  a  b ")).toBe("a b");
  });

  it("ftsPhrase：CJK 段短语化、非 CJK 词剥语法字符、段间 AND", () => {
    expect(ftsPhrase("退款流程")).toBe('"退 款 流 程"');
    expect(ftsPhrase("退款 refund 流程")).toBe('"退 款" "refund" "流 程"');
    // FTS5 语法字符被剥（防注入查询语法）
    expect(ftsPhrase("退款* OR x")).toContain('"退 款"');
    expect(ftsPhrase("退款* OR x")).not.toContain("*");
    expect(ftsPhrase("*!")).toBe("");
  });
});

describe("kb_fts 影子索引", () => {
  it("中文检索命中（0 命中回归）：子串、跨行、整词序", () => {
    fts.upsert("kb1", "faq/退款.md", "# 退款政策\n如何退款：联系客服。\n其他内容");
    fts.upsert("kb1", "notes.md", "今天天气不错");
    // 子串命中
    expect(fts.search(["kb1"], "退款").map((r) => r.path)).toContain("faq/退款.md");
    // 词序必须连续：倒序查不到（短语语义）
    expect(fts.search(["kb1"], "款退").map((r) => r.path)).not.toContain("faq/退款.md");
    // 不同库隔离
    expect(fts.search(["kb2"], "退款")).toEqual([]);
    // 英文词
    fts.upsert("kb1", "g.md", "how to refund: contact support");
    expect(fts.search(["kb1"], "refund").map((r) => r.path)).toContain("g.md");
  });

  it("delete 后不再命中；upsert 幂等替换", () => {
    fts.upsert("kb1", "a.md", "退款说明");
    fts.upsert("kb1", "a.md", "全新内容关于发票");
    // 旧词不再命中（替换而非追加）
    expect(fts.search(["kb1"], "退款")).toEqual([]);
    expect(fts.search(["kb1"], "发票").length).toBe(1);
    fts.delete("kb1", "a.md");
    expect(fts.search(["kb1"], "发票")).toEqual([]);
  });

  it("空查询/纯符号查询返回空（调用方回落 grep）", () => {
    fts.upsert("kb1", "a.md", "退款");
    expect(fts.search(["kb1"], "")).toEqual([]);
    expect(fts.search(["kb1"], "***")).toEqual([]);
  });

  it("真实文件树回填后可检索（迁移场景）", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-fts-backfill-"));
    tmpDirs.push(root);
    mkdirSync(join(root, "memory"), { recursive: true });
    const content = "# 经验\n凭证集按访问者解析。\n";
    fts.upsert("kbp", "memory/2026-01-01-note.md", content);
    expect(fts.search(["kbp"], "凭证集").length).toBe(1);
  });
});
