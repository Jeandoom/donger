import { cn } from "../../lib/utils";

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
}: {
  title: string;
  items: SecondarySidebarItem[];
  selectedId: string | null;
  onItemClick: (id: string) => void;
  onNew?: () => void;
  newLabel?: string;
  onItemDelete?: (id: string) => void;
}) {
  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className="rounded px-2 py-0.5 text-xs text-primary hover:bg-accent"
          >
            + {newLabel ?? "新建"}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {items.map((item) => (
          <div
            key={item.id}
            className="group mb-0.5 flex items-center rounded-md"
          >
            <button
              type="button"
              onClick={() => onItemClick(item.id)}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-left text-sm",
                selectedId === item.id ? "bg-accent" : "hover:bg-accent",
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
                  onItemDelete(item.id);
                }}
                className="mr-1 hidden rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
                title="删除会话"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
