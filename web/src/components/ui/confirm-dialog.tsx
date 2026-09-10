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
      onClick={props.onCancel}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-lg border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.description ? (
          <p className="mt-1.5 text-sm text-muted-foreground">{props.description}</p>
        ) : null}
        {props.error ? (
          <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{props.error}</div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={props.onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50 ${
              props.destructive ? "bg-red-600 hover:bg-red-700" : "bg-primary hover:bg-primary/90"
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
