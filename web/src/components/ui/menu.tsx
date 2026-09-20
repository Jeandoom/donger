import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" };

/** 轻量溢出菜单：⋯ 触发，点击外部 / Esc 关闭；危险项红色。行卡等密排场景用。 */
export function Menu(props: { label: string; entries: MenuEntry[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", props.className)}>
      <button
        type="button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 w-40 rounded-[10px] border border-border bg-card py-1 shadow-lg"
        >
          {renderEntries(props.entries, () => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** 渲染菜单项；分隔线以「前一项 label」派生稳定 key，避免数组下标 key */
function renderEntries(entries: MenuEntry[], close: () => void) {
  const nodes: ReactNode[] = [];
  let prevLabel = "";
  for (const entry of entries) {
    if (entry.kind === "separator") {
      nodes.push(<hr key={`sep-after-${prevLabel}`} className="my-1 h-px border-0 bg-muted" />);
      continue;
    }
    prevLabel = entry.label;
    nodes.push(
      <button
        key={entry.label}
        type="button"
        role="menuitem"
        disabled={entry.disabled}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium disabled:pointer-events-none disabled:opacity-50",
          entry.danger
            ? "text-destructive hover:bg-destructive-soft"
            : "text-foreground hover:bg-muted",
        )}
        onClick={() => {
          close();
          entry.onSelect();
        }}
      >
        {entry.icon}
        {entry.label}
      </button>,
    );
  }
  return nodes;
}
