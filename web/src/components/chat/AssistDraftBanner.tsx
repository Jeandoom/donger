import { useState } from "react";
import { Button } from "../ui/button";

/** 输入区上方的可编辑草稿横幅：兜底入口带入的原任务文本，用户确认后发送（不自动发送） */
export function AssistDraftBanner(props: {
  draft: string;
  onSend: (text: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState(props.draft);
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl rounded-xl border bg-background p-2 shadow-sm">
      <textarea
        aria-label="协助创建草稿"
        className="max-h-48 min-h-16 w-full resize-none border-0 bg-transparent px-2 py-1 text-sm leading-6 outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={props.onDismiss}>
          丢弃
        </Button>
        <Button type="button" size="sm" disabled={!text.trim()} onClick={() => props.onSend(text)}>
          发送
        </Button>
      </div>
    </div>
  );
}
