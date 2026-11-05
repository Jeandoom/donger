import { Bot, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/agentSidebar";
import { cn } from "../../lib/utils";
import type { ConversationSummary } from "../../types";

/**
 * Cmd/Ctrl+K 命令面板（chat UE 优化轮 E1-E）：会话标题检索 + 跳转。
 * 检索范围=已加载会话列表的标题（内容级全文搜索是 M3 FTS 专项，入口先收敛到一处）。
 */
export function CommandPalette({
  open,
  onClose,
  conversations,
  agents,
  onSelect,
  className,
}: {
  open: boolean;
  onClose: () => void;
  conversations: ConversationSummary[];
  /** agentId → 显示名 */
  agents: Map<string, string>;
  onSelect: (conversationId: string) => void;
  className?: string;
}) {
  const [keyword, setKeyword] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setKeyword("");
      setActiveIndex(0);
      // 面板打开即聚焦（关闭时焦点自然回归触发键所在元素）
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const base = conversations.filter((c) => !c.isDraft);
    if (!kw) return base.slice(0, 20);
    return base
      .filter((c) => {
        const title = (c.title || "(无标题)").toLowerCase();
        const agentName = (agents.get(c.agentId) ?? "").toLowerCase();
        return title.includes(kw) || agentName.includes(kw);
      })
      .slice(0, 20);
  }, [agents, conversations, keyword]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 关键词变化即重置高亮行，刻意不依赖其他值
  useEffect(() => {
    setActiveIndex(0);
  }, [keyword]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;
  const commit = (index: number) => {
    const target = results[index];
    if (!target) return;
    onClose();
    onSelect(target.id);
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: 对话框容器承载遮罩点击关闭与键盘导航
    <div
      role="dialog"
      aria-modal="true"
      aria-label="搜索会话"
      className={cn(
        "fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[12vh]",
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, results.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          commit(activeIndex);
        }
      }}
    >
      <div className="w-[32rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索会话标题或智能体…"
            aria-label="搜索会话标题或智能体"
            className="w-full border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              没有匹配的会话
            </div>
          ) : (
            results.map((conversation, index) => (
              <button
                key={conversation.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-index={index}
                onClick={() => commit(index)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  index === activeIndex && "bg-muted",
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                  <Bot size={13} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {conversation.title || "(无标题)"}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {agents.get(conversation.agentId) ?? "系统会话"}
                    {conversation.lastMessagePreview
                      ? ` · ${conversation.lastMessagePreview.slice(0, 40)}`
                      : ""}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatRelativeTime(conversation.updatedAt)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
