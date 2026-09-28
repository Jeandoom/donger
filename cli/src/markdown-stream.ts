import { renderCodeBlock, renderTable } from "./render.js";

type Mode = "text" | "code" | "table";

/**
 * 增量块渲染器（V18）：流式 delta 灌入，markdown 块级切分——
 * 普通文本行照旧直出（保实时），代码块/表格缓冲到闭合后一次性渲染成型（保结构）。
 * color=false（非 TTY）时完全直通，行为与旧流式一致。
 * 用法：每轮回合新建实例；delta → feed()，回合结束 → end() 冲刷残余。
 */
export class MarkdownStream {
  private buf = "";
  private mode: Mode = "text";
  private block: string[] = [];
  /** text 模式下收到的 | 开头待定行：等下一行判定是表格头（跟分隔行）还是普通文本 */
  private pending: string | null = null;

  constructor(private readonly color: boolean) {}

  /** 灌入增量，返回本次应输出的文本（可能为空——块缓冲中） */
  feed(delta: string): string {
    if (!this.color) return delta;
    this.buf += delta;
    let out = "";
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out += this.handleLine(line);
    }
    return out;
  }

  /** 流结束：冲刷未成行尾巴与未闭合块，并复位状态（下一回合可复用新实例） */
  end(): string {
    if (!this.color) return "";
    const rest = this.buf;
    this.buf = "";
    let out = "";
    if (this.mode === "code") {
      if (rest) this.block.push(rest);
      out += `${renderCodeBlock(this.block, true)}\n`;
    } else if (this.mode === "table") {
      if (rest) this.block.push(rest);
      out += `${renderTable(this.block, true)}\n`;
    } else if (this.pending !== null) {
      out += `${this.pending}\n${rest}`;
    } else {
      out += rest;
    }
    this.mode = "text";
    this.block = [];
    this.pending = null;
    return out;
  }

  /** 处理一个完整行，返回该行的渲染输出（含必要换行） */
  private handleLine(line: string): string {
    if (this.mode === "code") {
      if (line.trimStart().startsWith("```")) {
        const done = this.block;
        this.block = [];
        this.mode = "text";
        return `${renderCodeBlock(done, true)}\n`;
      }
      this.block.push(line);
      return "";
    }
    if (this.mode === "table") {
      if (line.trimStart().startsWith("|")) {
        this.block.push(line);
        return "";
      }
      const table = renderTable(this.block, true);
      this.block = [];
      this.mode = "text";
      // 收束行（空行/普通文本）继续按 text 规则处理
      return `${table}\n${this.handleLine(line)}`;
    }
    // —— text 模式 ——
    const t = line.trimStart();
    if (t.startsWith("```")) {
      this.mode = "code";
      this.block = [];
      return "";
    }
    if (t.startsWith("|")) {
      if (this.pending === null) {
        this.pending = line;
        return "";
      }
      if (isTableSeparator(line)) {
        this.mode = "table";
        this.block = [this.pending, line];
        this.pending = null;
        return "";
      }
      // 前一 | 行不是表格头：原样输出，当前行继续待定
      const prev = this.pending;
      this.pending = line;
      return `${prev}\n`;
    }
    if (this.pending !== null) {
      const p = this.pending;
      this.pending = null;
      return `${p}\n${line}\n`;
    }
    return `${line}\n`;
  }
}

function isTableSeparator(line: string): boolean {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}
