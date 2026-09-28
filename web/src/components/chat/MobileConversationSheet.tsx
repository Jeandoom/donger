import { MessagesSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentConversationSidebarProps } from "./AgentConversationSidebar";
import { AgentConversationSidebar } from "./AgentConversationSidebar";

export interface MobileConversationSheetProps {
  /** 分组侧栏内容；选中会话后自动关闭浮层 */
  sidebar?: AgentConversationSidebarProps;
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
        className="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap px-2 lg:hidden"
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
            {props.sidebar ? (
              <AgentConversationSidebar
                className="h-full w-full border-r-0 [&>div:first-child]:pr-12"
                {...props.sidebar}
                onItemSelected={() => setOpen(false)}
                onNewConversation={(agentId) => {
                  props.sidebar?.onNewConversation(agentId);
                  setOpen(false);
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
