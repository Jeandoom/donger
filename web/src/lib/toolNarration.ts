/**
 * 工具过程叙述折叠：模型（如 GLM 内置工具）会在正文输出 `**Output:**` +
 * 超长单行转义 JSON，直接渲染成刷屏文本墙。这里把超过阈值的部分改写为
 * 围栏代码块，交给消息渲染器的可滚动代码样式呈现。
 */

const COLLAPSE_THRESHOLD = 300;

/** 识别 `**Output:**` / `Output:` 一类工具输出起始行，捕获其后的载荷 */
const OUTPUT_BLOCK =
  /^(\*\*(?:Output|输入|输出):\*\*|\*(?:Output|输出):\*|Output:)\s*\n?(\*\*[\w.-]+:\*\*\s*\n?)?([\s\S]*)$/;

export function collapseToolNarration(text: string): string {
  if (!text || text.length <= COLLAPSE_THRESHOLD) return text;
  // 仅处理单条消息内的首个匹配（工具叙述通常独占一条 bot 消息）
  const idx = text.search(/\*\*(?:Output|输出):\*\*|Output:/);
  if (idx < 0) return text;
  const head = text.slice(0, idx);
  const block = text.slice(idx);
  const m = block.match(OUTPUT_BLOCK);
  if (!m) return text;
  const [, label, toolName, payload] = m;
  if (!payload || payload.length <= COLLAPSE_THRESHOLD) return text;
  const summary = `${head}${label}\n${toolName ?? ""}🔧 工具输出（原始内容 ${payload.length} 字符，以下为折叠展示）：\n\n\`\`\`\n${payload.trimEnd()}\n\`\`\``;
  return summary;
}
