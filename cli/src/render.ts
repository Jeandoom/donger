import Table from "cli-table3";
import pc from "picocolors";

/**
 * markdown-lite 终端渲染（I5）：代码块盒装、标题加粗、粗体、引用缩进、表格对齐（V18）。
 * color=false（非 TTY）时原文直通。
 */
export function renderMarkdown(src: string, color: boolean): string {
  if (!color) return src;
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let tableBuf: string[] = [];
  const flushTable = (): void => {
    if (tableBuf.length > 0) {
      out.push(renderTable(tableBuf, true));
      tableBuf = [];
    }
  };
  for (const line of src.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      flushTable();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        inCode = false;
        out.push(...boxCode(codeBuf));
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      tableBuf.push(line);
      continue;
    }
    flushTable();
    out.push(renderLine(line));
  }
  if (inCode) out.push(...boxCode(codeBuf)); // 未闭合代码块兜底
  flushTable();
  return out.join("\n");
}

function renderLine(line: string): string {
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) return pc.bold(pc.underline(h[2] ?? ""));
  const q = line.match(/^>\s?(.*)$/);
  if (q) return pc.dim(`▌ ${q[1] ?? ""}`);
  return line.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => pc.bold(inner));
}

/** 代码块盒装：按最长行撑宽度 */
export function renderCodeBlock(lines: string[], color: boolean): string {
  if (!color) return ["```", ...lines, "```"].join("\n");
  return boxCode(lines).join("\n");
}

/** markdown 表格 → 终端对齐表格（cli-table3）。非 TTY / 不含表头分隔行时原样返回。 */
export function renderTable(lines: string[], color: boolean): string {
  if (!color) return lines.join("\n");
  const rows = lines.map((l) =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim()),
  );
  const sep = rows[1];
  const hasHeader = Array.isArray(sep) && sep.length > 0 && sep.every((c) => /^:?-+:?$/.test(c));
  if (!hasHeader || rows[0] === undefined) return lines.join("\n");
  const head = rows[0];
  const table = new Table({ head });
  for (const row of rows.slice(2)) {
    if (row.length === 0) continue;
    table.push([...row, ...Array<string>(Math.max(0, head.length - row.length)).fill("")]);
  }
  return table.toString();
}

/** 代码块盒装：按最长行撑宽度 */
function boxCode(lines: string[]): string[] {
  const width = Math.max(20, ...lines.map((l) => l.length));
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bottom = `└${"─".repeat(width + 2)}┘`;
  const body = lines.map((l) => `${pc.dim("│")} ${l.padEnd(width)} ${pc.dim("│")}`);
  return [pc.dim(top), ...body, pc.dim(bottom)];
}
