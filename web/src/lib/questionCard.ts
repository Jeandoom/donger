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
