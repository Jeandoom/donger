import { ChevronRight, Send } from "lucide-react";
import { useState } from "react";
import {
  assembleQuestionAnswers,
  isQuestionAnswered,
  questionTabLabel,
} from "../../lib/questionCard";
import type { PendingQuestion, PendingQuestionItem } from "../../types";
import { Button } from "../ui/button";

export interface QuestionCardProps {
  question: PendingQuestion;
  error?: string;
  onAnswer: (answers: Record<string, string>, response?: string) => void;
}

/**
 * AskUserQuestion 作答卡：由父级渲染在 sticky 底栏（输入框正上方）——
 * 不进消息流，用户浏览历史时依旧可见可答。
 * 多问题时按 Tab 逐题展示（手机端全量堆叠会占满屏幕、够不到提交按钮）；
 * 作答进度随切题保留，提交时统一组装。
 */
export function QuestionCard({ question, error, onAnswer }: QuestionCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const items = question.questions;
  const current: PendingQuestionItem | undefined = items[activeIdx];
  const answeredCount = items.filter((q) => isQuestionAnswered(q, selections, others)).length;
  const allAnswered = items.length > 0 && answeredCount === items.length;

  const toggle = (text: string, label: string, multi: boolean) => {
    if (submitting) return;
    setSelections((prev) => {
      const currentSelection = prev[text] ?? [];
      if (multi) {
        return {
          ...prev,
          [text]: currentSelection.includes(label)
            ? currentSelection.filter((l) => l !== label)
            : [...currentSelection, label],
        };
      }
      return { ...prev, [text]: currentSelection[0] === label ? [] : [label] };
    });
  };

  const submit = () => {
    if (submitting) return;
    setSubmitting(true);
    const { answers, response } = assembleQuestionAnswers(items, selections, others);
    onAnswer(answers, response || undefined);
  };

  return (
    <div
      role="group"
      aria-label="智能体提问"
      className="pointer-events-auto mb-2 w-full max-w-3xl rounded-2xl border border-primary/40 bg-background p-3 shadow-lg"
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium tracking-wide text-primary/80">
          智能体需要你的输入
        </span>
        {items.length > 1 ? (
          <span className="text-xs text-muted-foreground">
            已答 {answeredCount}/{items.length}
          </span>
        ) : null}
      </div>
      {items.length > 1 ? (
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1.5" role="tablist">
          {items.map((q, i) => {
            const answered = isQuestionAnswered(q, selections, others);
            const active = i === activeIdx;
            return (
              <button
                key={q.question}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveIdx(i)}
                className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : answered
                      ? "border-border bg-success-soft text-success"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                }`}
              >
                {answered ? "✓ " : ""}
                {questionTabLabel(q, i)}
              </button>
            );
          })}
        </div>
      ) : null}
      {current ? (
        <QuestionBlock
          item={current}
          selected={selections[current.question] ?? []}
          other={others[current.question] ?? ""}
          onToggle={(label) => toggle(current.question, label, current.multiSelect === true)}
          onOtherChange={(value) => setOthers((prev) => ({ ...prev, [current.question]: value }))}
        />
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2 px-1">
        {error ? (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="mr-auto text-xs text-muted-foreground">
            {items.length > 1 && !allAnswered ? "未答题将按未提供处理，模型会自行假设" : undefined}
          </p>
        )}
        {activeIdx < items.length - 1 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setActiveIdx((i) => Math.min(i + 1, items.length - 1))}
            disabled={submitting}
          >
            下一题
            <ChevronRight aria-hidden="true" size={14} className="ml-0.5" />
          </Button>
        ) : null}
        <Button size="sm" onClick={submit} disabled={submitting}>
          <Send aria-hidden="true" size={14} className="mr-1" />
          提交{items.length > 1 ? `（${answeredCount}/${items.length}）` : ""}
        </Button>
      </div>
    </div>
  );
}

function QuestionBlock({
  item,
  selected,
  other,
  onToggle,
  onOtherChange,
}: {
  item: PendingQuestionItem;
  selected: string[];
  other: string;
  onToggle: (label: string) => void;
  onOtherChange: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        {item.header ? (
          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
            {item.header}
          </span>
        ) : null}
        {item.multiSelect ? <span className="text-xs text-muted-foreground">可多选</span> : null}
      </div>
      <div className="mt-1 text-sm font-medium">{item.question}</div>
      {item.options && item.options.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {item.options.map((opt) => {
            const active = selected.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => onToggle(opt.label)}
                aria-pressed={active}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background hover:bg-muted/60"
                }`}
              >
                <span className="font-medium">{opt.label}</span>
                {opt.description ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <input
        type="text"
        value={other}
        onChange={(e) => onOtherChange(e.target.value)}
        placeholder="其他（自行填写，优先采用）"
        className="mt-2 w-full rounded-lg border bg-background px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
      />
    </div>
  );
}
