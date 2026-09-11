import { useEffect } from "react";

/** 统一的确认弹窗：替代原生 confirm，保证与全站风格一致。 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onCancel]);

  if (!props.open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
      }}
    >
      <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.description ? (
          <p className="mt-1.5 text-sm text-muted-foreground">{props.description}</p>
        ) : null}
        {props.error ? (
          <div className="mt-3 rounded-lg bg-destructive-soft p-2 text-sm text-destructive">
            {props.error}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            onClick={props.onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
              props.destructive ? "bg-destructive hover:opacity-90" : "bg-primary hover:opacity-90"
            }`}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? "处理中…" : (props.confirmText ?? "确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
