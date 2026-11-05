import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * 自绘下拉选择器（chat UE 优化轮 E4-A）：替换 composer 的原生 <select>。
 * 向上弹开（composer 位于页底）；完整模型名不再被 max-width 截断不可见。
 */
export interface PopoverSelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function PopoverSelect({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className,
  buttonClassName,
  align = "left",
}: {
  value: string;
  options: PopoverSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  title?: string;
  className?: string;
  buttonClassName?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title ?? current?.label ?? ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 min-w-0 max-w-full items-center gap-1 rounded-lg border border-border bg-card px-2 text-xs font-medium text-muted-foreground hover:bg-muted",
          buttonClassName,
        )}
      >
        <span className="min-w-0 truncate">{current?.label ?? ariaLabel}</span>
        <ChevronDown size={12} className="shrink-0" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "absolute bottom-full z-30 mb-1.5 max-h-72 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false);
                  onChange(option.value);
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted",
                  selected && "bg-primary-soft",
                )}
              >
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {selected ? (
                    <Check size={12} className="text-primary" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-medium text-foreground">{option.label}</span>
                  {option.hint ? (
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {option.hint}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
