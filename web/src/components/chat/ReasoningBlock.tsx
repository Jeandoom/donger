import type { ReasoningMessagePartProps } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import { Brain, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";

/**
 * 思考内容折叠块：默认折叠，运行中头部脉动提示，展开后弱化排版。
 * 展开状态为组件本地 state（按分片实例持有），流式追加不会重置。
 * props 即分片字段（assistant-ui 将 part 平铺进组件 props）。
 */
export function ReasoningBlock({ text }: ReasoningMessagePartProps) {
  const [open, setOpen] = useState(false);
  const running = useAuiState(({ message }) => message.status?.type === "running");
  const streamingThisPart = running === true && text.length > 0;

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          streamingThisPart && "animate-pulse",
        )}
      >
        <Brain aria-hidden="true" size={13} className="shrink-0" />
        <span className="truncate">{streamingThisPart ? "思考中…" : "思考过程"}</span>
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-muted pl-3 text-[13px] leading-6 text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}
