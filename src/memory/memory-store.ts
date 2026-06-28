import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 */
export class MemoryStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** 追加一条经验，返回文件名。 */
  append(entry: MemoryEntry): string {
    const slug =
      entry.summary
        .toLowerCase()
        .replace(/[^\w一-鿿]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "lesson";
    const ts = Date.now();
    const filename = `${ts}-${slug}.md`;
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

  /** 列出全部记忆（按文件名倒序 = 最新在前）。 */
  list(): MemoryEntry[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .map((filename) => {
        const text = readFileSync(join(this.dir, filename), "utf8");
        const lines = text.split("\n");
        const summary = (lines[0] ?? "").replace(/^#\s*/, "");
        const detail = lines.slice(2).join("\n").trimEnd();
        return { summary, detail, filename };
      });
  }

  /** 删除一条记忆（按文件名）。 */
  remove(filename: string): void {
    rmSync(join(this.dir, filename), { force: true });
  }
}
