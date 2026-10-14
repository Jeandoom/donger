import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 一条记忆（经验/教训） */
export interface MemoryEntry {
  summary: string;
  detail: string;
  /** 文件名（list/remove 用） */
  filename?: string;
}

/**
 * 文件式记忆存储（Hermes 风：一条经验一个 md 文件）。
 * 文件格式：`# {summary}\n\n{detail}`。文件名：`{timestamp}-{slug}.md`。
 * 搜索：大小写不敏感关键词匹配 summary + detail。
 * 目录分层（知识体系轮 P1）：`auto/` 子目录承接 legacy 收尾倾倒，与 curated/（精选层，
 * 萃取器 P3 起写入）、archive/（归档，不参与注入）隔离；list/search 递归含 auto/
 * 保证旧行为连续，不含 curated/archive。
 */
export class MemoryStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** 追加一条经验，返回文件名。subdir="auto" 落 legacy 倾倒子目录。 */
  append(entry: MemoryEntry, opts?: { subdir?: "auto" }): string {
    const slug =
      entry.summary
        .toLowerCase()
        .replace(/[^\w一-鿿]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "lesson";
    const ts = Date.now();
    const filename = opts?.subdir ? `${opts.subdir}/${ts}-${slug}.md` : `${ts}-${slug}.md`;
    if (opts?.subdir) mkdirSync(join(this.dir, opts.subdir), { recursive: true });
    writeFileSync(join(this.dir, filename), `# ${entry.summary}\n\n${entry.detail}\n`, "utf8");
    return filename;
  }

  /** 关键词搜索（大小写不敏感，匹配 summary + detail）。 */
  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (e) => e.summary.toLowerCase().includes(q) || e.detail.toLowerCase().includes(q),
    );
  }

  /** 列出全部记忆（顶层 + auto/ 子目录；按文件名内嵌时间戳倒序 = 最新在前）。 */
  list(): MemoryEntry[] {
    const filenames = [...this.#mdFiles("."), ...this.#mdFiles("auto").map((f) => `auto/${f}`)];
    // 时间戳倒序，同毫秒并列时按文件名降序 tie-break（快连追加同 ts 的确定性）
    filenames.sort(
      (a, b) => this.#tsOf(b) - this.#tsOf(a) || (a < b ? 1 : a > b ? -1 : 0),
    );
    return filenames.map((filename) => {
      const text = readFileSync(join(this.dir, filename), "utf8");
      const lines = text.split("\n");
      const summary = (lines[0] ?? "").replace(/^#\s*/, "");
      const detail = lines.slice(2).join("\n").trimEnd();
      return { summary, detail, filename };
    });
  }

  /** 删除一条记忆（按文件名，支持 "auto/xxx.md"）。 */
  remove(filename: string): void {
    rmSync(join(this.dir, filename), { force: true });
  }

  // ---- curated 通道（知识体系轮 P2）----

  /** 读取 curated 索引（注入源，替代关键词检索）；不存在返回 null。超 200 行截断。 */
  readCuratedIndex(): { text: string; lines: number; truncated: boolean } | null {
    try {
      const text = readFileSync(join(this.dir, "curated", "INDEX.md"), "utf8");
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length <= 200) return { text, lines: lines.length, truncated: false };
      return { text: lines.slice(0, 200).join("\n"), lines: lines.length, truncated: true };
    } catch {
      return null;
    }
  }

  /** curated 条目清单（KB 页记忆分区展示）。 */
  listCurated(): Array<{ filename: string; summary: string }> {
    const dir = join(this.dir, "curated");
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
        .sort()
        .reverse()
        .map((f) => ({
          filename: `curated/${f}`,
          summary: (readFileSync(join(dir, f), "utf8").split("\n")[0] ?? "").replace(/^#\s*/, ""),
        }));
    } catch {
      return [];
    }
  }

  /** legacy 顶层遗留条目数（迁移卡计数；不含 curated/archive/auto 子目录内容）。 */
  countLegacyTopLevel(): number {
    try {
      return readdirSync(this.dir).filter(
        (f) => f.endsWith(".md") && statSync(join(this.dir, f)).isFile(),
      ).length;
    } catch {
      return 0;
    }
  }

  /** 一次性迁移：memory/ 顶层 *.md → archive/（迁移卡），返回移动数。 */
  migrateLegacyToArchive(): number {
    mkdirSync(join(this.dir, "archive"), { recursive: true });
    let moved = 0;
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".md")) continue;
        const abs = join(this.dir, f);
        if (!statSync(abs).isFile()) continue;
        renameSync(abs, join(this.dir, "archive", f));
        moved++;
      }
    } catch {
      return moved;
    }
    return moved;
  }

  #mdFiles(subdir: string): string[] {
    try {
      return readdirSync(join(this.dir, subdir)).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  }

  #tsOf(filename: string): number {
    const base = filename.split("/").pop() ?? filename;
    const n = Number.parseInt(base.split("-")[0] ?? "", 10);
    return Number.isFinite(n) ? n : 0;
  }
}
