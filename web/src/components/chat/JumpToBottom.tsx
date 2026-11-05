import { useThreadViewport } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";

/**
 * 「回到底部」浮标（chat UE 优化轮 E5-B）：离底时出现在 composer 上方；
 * 用 assistant-ui viewport store 的 isAtBottom（自带阈值跟随语义），点击平滑滚回。
 */
export function JumpToBottom() {
  const isAtBottom = useThreadViewport((s) => s.isAtBottom);
  const scrollToBottom = useThreadViewport((s) => s.scrollToBottom);
  if (isAtBottom) return null;
  return (
    <div className="pointer-events-none relative z-10 flex justify-center">
      <button
        type="button"
        aria-label="回到底部"
        onClick={() => scrollToBottom({ behavior: "smooth" })}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-md hover:bg-muted"
      >
        <ArrowDown size={13} aria-hidden="true" />
        回到最新
      </button>
    </div>
  );
}
