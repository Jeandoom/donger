import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface RadioCardProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** 选中态色调：primary（默认）或 danger（高危选项如完全权限） */
  tone?: "primary" | "danger";
}

/** 卡片式单选项（场景/权限模式选择）：原生 radio 隐藏驱动选中态 */
export function RadioCard({
  title,
  description,
  tone = "primary",
  className,
  id,
  ...props
}: RadioCardProps) {
  const checked = props.checked ?? props.defaultChecked;
  const checkedBorder = tone === "danger" ? "border-destructive" : "border-primary";
  const checkedBg = tone === "danger" ? "bg-destructive-soft" : "bg-primary-soft";
  const checkedText = tone === "danger" ? "text-destructive" : "text-primary";
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-[10px] border p-2.5 text-left transition-colors sm:p-3",
        checked ? cn(checkedBorder, checkedBg) : "border-border bg-card hover:bg-muted/50",
        props.disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          checked ? checkedBorder : "border-input",
        )}
      >
        {checked ? (
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              checkedBg,
              tone === "danger" ? "bg-destructive" : "bg-primary",
            )}
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn("text-[13px] font-semibold", checked ? checkedText : "text-foreground")}
        >
          {title}
        </span>
        {description ? (
          <span className="text-[11px] leading-snug text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <input type="radio" id={id} className="sr-only" {...props} />
    </label>
  );
}
