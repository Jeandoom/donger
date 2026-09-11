import { MessagesSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SecondarySidebarItem } from "../layout/SecondarySidebar";
import { SecondarySidebar } from "../layout/SecondarySidebar";

export interface MobileConversationSheetProps {
  title: string;
  items: SecondarySidebarItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  headerExtra?: React.ReactNode;
}

export function MobileConversationSheet(props: MobileConversationSheetProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="打开历史会话"
        className="inline-flex min-h-11 items-center gap-2 px-2 lg:hidden"
        onClick={() => setOpen(true)}
      >
        <MessagesSquare size={18} />
        会话
      </button>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="关闭历史会话遮罩"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="历史会话"
            className="absolute right-0 top-0 h-full w-[min(90vw,22rem)] bg-card shadow-xl"
          >
            <button
              type="button"
              aria-label="关闭历史会话"
              className="absolute right-1 top-1 z-10 inline-flex min-h-11 min-w-11 items-center justify-center"
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
            <SecondarySidebar
              className="h-full w-full border-r-0"
              title={props.title}
              items={props.items}
              selectedId={props.selectedId}
              onItemClick={props.onSelect}
              onItemSelected={() => setOpen(false)}
              onItemDelete={props.onDelete}
              onNew={() => {
                props.onNew();
                setOpen(false);
              }}
              newLabel="新会话"
              headerExtra={props.headerExtra}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
