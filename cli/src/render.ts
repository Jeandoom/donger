import pc from "picocolors";

/**
 * markdown-lite 终端渲染（I5）：代码块盒装、标题加粗、粗体、引用缩进。
 * 表格/列表等保持原样（管道可读）。color=false（非 TTY）时原文直通。
 */
export function renderMarkdown(src: string, color: boolean): string {
  if (!color) return src;
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  for (const line of src.split("\n")) {
    if (line.trimStart().startsWith("```")) {
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
    out.push(renderLine(line));
  }
  if (inCode) out.push(...boxCode(codeBuf)); // 未闭合代码块兜底
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
function boxCode(lines: string[]): string[] {
  const width = Math.max(20, ...lines.map((l) => l.length));
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bottom = `└${"─".repeat(width + 2)}┘`;
  const body = lines.map((l) => `${pc.dim("│")} ${l.padEnd(width)} ${pc.dim("│")}`);
  return [pc.dim(top), ...body, pc.dim(bottom)];
}
