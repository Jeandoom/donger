/** 会话标题：默认值与首条用户消息的派生规则（web/dingtalk/CLI 全渠道共用）。 */

/** 建会话时的占位标题；收到首条用户消息后按内容自动替换 */
export const DEFAULT_CONVERSATION_TITLE = "新对话";

/** 标题最大长度（字符数，代理对安全） */
const MAX_TITLE_CHARS = 30;

/**
 * 首条用户消息 → 会话标题：取首个非空行、压平内部空白、截断。
 * 多行消息（贴了代码/报错）取首行，避免标题被正文淹没；纯空白消息返回空串（调用方跳过改名）。
 */
export function deriveConversationTitle(text: string, maxChars = MAX_TITLE_CHARS): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return [...collapsed].slice(0, maxChars).join("");
}
