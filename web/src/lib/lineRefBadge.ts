/**
 * 全角行号引用徽标：把「结论（:31）」「（:10-17, :24）」一类模型行号引用中的
 * `:数字` 段落改写为行内代码，使其获得行内代码的徽标样式。
 *
 * 仅处理全角括号形态（donger-code-agent 报告语料全部为全角；ASCII `(:4)` 在
 * 代码语境中误伤率高，不做）。围栏代码块与行内代码内部的文本原样保留。
 */

const FENCED_BLOCK = /(```[\s\S]*?```)/g;
const INLINE_CODE = /(`[^`\n]*`)/g;
const LINE_REF = /（:((?:\d+(?:-\d+)?)(?:\s*[,，;；、]\s*:\d+(?:-\d+)?)*)）/g;

export function lineRefBadge(text: string): string {
  if (!text?.includes("（:")) return text;
  return text
    .split(FENCED_BLOCK)
    .map((segment, i) => (i % 2 === 1 ? segment : transformOutsideInlineCode(segment)))
    .join("");
}

function transformOutsideInlineCode(segment: string): string {
  return segment
    .split(INLINE_CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(LINE_REF, "（`:$1`）")))
    .join("");
}
