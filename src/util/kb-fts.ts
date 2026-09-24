import type { Database } from "better-sqlite3";

/**
 * 知识库 FTS5 三列式影子表（spec 2026-09-22-knowledge-base-design §6，R-A 修复）：
 *   kb_fts(kbId UNINDEXED, path UNINDEXED, content UNINDEXED, seg)
 * 默认 unicode61 分词对中文整串成 token（中文查询 0 命中实证，见检索架构调研轮），
 * 因此索引列只有一个 seg = cjkSpace(content)（CJK 逐字空格化）；
 * 查询侧 ftsPhrase 同样切分并短语化（双引号短语保证字序连续），非 CJK 词剥语法字符。
 * content 列 UNINDEXED 仅作原文存储：行级 line/snippet 由读取方按行匹配生成，不依赖 snippet()。
 */

/** CJK 统一表意 + 扩展 A + 兼容表意 */
const CJK = /[\u3400-\u4dbf\uf900-\ufaff\u4e00-\u9fff]/;
const CJK_SOURCE = "\\u3400-\\u4dbf\\uf900-\\ufaff\\u4e00-\\u9fff";
/** 查询分段：CJK 连续段 | 非 CJK 连续段 */
const SEGMENT_RE = new RegExp(`[${CJK_SOURCE}]+|[^${CJK_SOURCE}]+`, "gu");
/** FTS5 语法字符（查询侧防御：非 CJK 词剥掉，避免被当查询语法） */
const FTS_SYNTAX = /["'()*:^{}[\]~&|!,]/g;

/** CJK 字符逐字之间插空格（索引与查询共用的切分规则）；其余字符原样、空白归一 */
export function cjkSpace(text: string): string {
  return text
    .replace(new RegExp(`[${CJK_SOURCE}]`, "gu"), (ch) => ` ${ch} `)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 查询短语化规则（R-A）：
 * - CJK 连续段 → 逐字空格化后用双引号包裹（短语，字序必须连续命中）；
 * - 非 CJK 段按空白拆词、剥 FTS5 语法字符后逐词双引号包裹；
 * - 段/词之间空格连接（FTS5 隐式 AND）。返回空串表示无可查词。
 */
export function ftsPhrase(query: string): string {
  const segments = query.match(SEGMENT_RE) ?? [];
  const parts: string[] = [];
  for (const seg of segments) {
    if (CJK.test(seg)) {
      parts.push(`"${cjkSpace(seg)}"`);
      continue;
    }
    for (const word of seg.split(/\s+/)) {
      const clean = word.replace(FTS_SYNTAX, "");
      if (clean.length > 0) parts.push(`"${clean}"`);
    }
  }
  return parts.join(" ");
}

/** 建影子表（幂等；index.ts 装配处调用） */
export function migrateKbFts(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      kbId UNINDEXED,
      path UNINDEXED,
      content UNINDEXED,
      seg
    )
  `);
}

export interface KbFtsIndex {
  /** 文件内容写入后同步（整文件覆写语义：同 kbId+path 幂等替换） */
  upsert(kbId: string, path: string, content: string): void;
  /** 文件删除后同步 */
  delete(kbId: string, path: string): void;
  /** 短语检索：返回命中文件（kbId+path），行级定位由调用方读取原文完成 */
  search(kbIds: readonly string[], query: string, limit?: number): Array<{ kbId: string; path: string }>;
}

export function createKbFts(db: Database): KbFtsIndex {
  const upsertStmt = db.prepare(
    `INSERT INTO kb_fts (kbId, path, content, seg) VALUES (?, ?, ?, ?)`,
  );
  const deleteStmt = db.prepare(`DELETE FROM kb_fts WHERE kbId = ? AND path = ?`);

  return {
    upsert(kbId, path, content) {
      const run = db.transaction(() => {
        deleteStmt.run(kbId, path);
        upsertStmt.run(kbId, path, content, cjkSpace(content));
      });
      run();
    },
    delete(kbId, path) {
      deleteStmt.run(kbId, path);
    },
    search(kbIds, query, limit = 200) {
      const phrase = ftsPhrase(query);
      if (phrase.length === 0 || kbIds.length === 0) return [];
      const placeholders = kbIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT kbId, path FROM kb_fts WHERE seg MATCH ? AND kbId IN (${placeholders}) LIMIT ?`,
        )
        .all(phrase, ...kbIds, limit) as Array<{ kbId: string; path: string }>;
      return rows;
    },
  };
}
