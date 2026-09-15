import type { PendingQuestionItem } from "../types";

/**
 * 组装 AskUserQuestion 的 answers：key=问题原文。
 * 「其他」文本优先；否则多选拼逗号串、单选取单个 label；未作答的问题不出现在结果里。
 */
export function assembleQuestionAnswers(
  questions: PendingQuestionItem[],
  selections: Record<string, string[]>,
  others: Record<string, string>,
): { answers: Record<string, string>; response: string } {
  const answers: Record<string, string> = {};
  let response = "";
  for (const q of questions) {
    const other = others[q.question]?.trim();
    if (other) {
      answers[q.question] = other;
      if (!response) response = other;
      continue;
    }
    const picked = selections[q.question] ?? [];
    const first = picked[0];
    if (first !== undefined) {
      answers[q.question] = q.multiSelect ? picked.join(", ") : first;
    }
  }
  return { answers, response };
}

/** 单题是否已作答：「其他」文本非空，或至少选中一个选项 */
export function isQuestionAnswered(
  item: PendingQuestionItem,
  selections: Record<string, string[]>,
  others: Record<string, string>,
): boolean {
  if (others[item.question]?.trim()) return true;
  return (selections[item.question]?.length ?? 0) > 0;
}

/** Tab 标签：优先 header；无 header 时截取问题前 8 字 */
export function questionTabLabel(item: PendingQuestionItem, index: number): string {
  if (item.header) return item.header;
  const text = item.question.trim();
  return text.length > 8 ? `${text.slice(0, 8)}…` : text || `问题 ${index + 1}`;
}
