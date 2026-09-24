import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { cn } from "../../lib/utils";

/** 全站统一的表单/内容弹窗外壳：Esc/遮罩关闭，样式与 ConfirmDialog 同族，宽度可容纳表单 */
export function DialogShell(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={props.ariaLabel}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className={cn(
          "mx-4 flex max-h-[88vh] w-full flex-col overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl",
          props.className ?? "max-w-lg",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{props.title}</h2>
            {props.subtitle ? (
              <div className="mt-0.5 text-[13px] text-muted-foreground">{props.subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-4">{props.children}</div>
        <div className="mt-5 flex items-center gap-2">{props.footer}</div>
      </div>
    </div>
  );
}
