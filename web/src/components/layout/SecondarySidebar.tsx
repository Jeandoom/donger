import { useState } from "react";
import { cn } from "../../lib/utils";
import { ConfirmDialog } from "../ui/confirm-dialog";

export interface SecondarySidebarItem {
  id: string;
  title: string;
  subtitle?: string;
  /** 附加在右侧的时间/日期标签 */
  meta?: string;
}

export function SecondarySidebar({
  title,
  items,
  selectedId,
  onItemClick,
  onNew,
  newLabel,
  onItemDelete,
  headerExtra,
  className,
  onItemSelected,
}: {
  title: string;
  items: SecondarySidebarItem[];
  selectedId: string | null;
  onItemClick: (id: string) => void;
  onNew?: () => void;
  newLabel?: string;
  onItemDelete?: (id: string) => void;
  headerExtra?: React.ReactNode;
  className?: string;
  onItemSelected?: () => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<SecondarySidebarItem | null>(null);
  const [keyword, setKeyword] = useState("");
  // 列表较长时提供站内过滤；大小写不敏感的标题包含匹配
  const showSearch = items.length >= 8;
  const kw = keyword.trim().toLowerCase();
  const visibleItems = kw ? items.filter((item) => item.title.toLowerCase().includes(kw)) : items;
  return (
    <div
      className={cn("flex w-64 shrink-0 flex-col border-r border-border bg-background", className)}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-xs font-semibold text-muted-foreground">{title}</span>
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className="rounded-md bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary hover:opacity-80"
          >
            + {newLabel ?? "新建"}
          </button>
        )}
      </div>
      {showSearch && (
        <div className="border-b border-border px-2 py-1.5">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索…"
            aria-label={`${title}搜索`}
            className="w-full rounded-md border border-border bg-card px-2 py-1 text-xs focus:border-primary focus:outline-none"
          />
        </div>
      )}
      {headerExtra && <div className="border-b border-border px-2 py-1.5">{headerExtra}</div>}
      <div className="flex-1 overflow-x-hidden overflow-y-auto p-1.5">
        {visibleItems.length === 0 && kw ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">没有匹配的会话</div>
        ) : null}
        {visibleItems.map((item) => (
          <div key={item.id} className="group mb-0.5 flex min-w-0 items-center rounded-lg">
            <button
              type="button"
              aria-label={`打开会话：${item.title}`}
              onClick={() => {
                onItemClick(item.id);
                onItemSelected?.();
              }}
              className={cn(
                "min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm",
                selectedId === item.id
                  ? "bg-primary-soft font-medium text-primary"
                  : "hover:bg-muted",
              )}
            >
              <div className="truncate font-medium">{item.title || "(无标题)"}</div>
              {item.subtitle && (
                <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
              )}
              {item.meta && <div className="text-[10px] text-muted-foreground">{item.meta}</div>}
            </button>
            {onItemDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(item);
                }}
                className="mr-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:min-h-8 sm:min-w-8 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                aria-label={`删除会话：${item.title}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除「${pendingDelete?.title || "无标题"}」？`}
        description="删除后该会话将从列表移除，且无法恢复。"
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (pendingDelete) onItemDelete?.(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
