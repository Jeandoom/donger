import { Check } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  /** label 排布：右侧（默认）或下方（卡片式大点击区） */
  labelBelow?: boolean;
}

/** 样式化复选框：原生 input（可访问性/表单语义）+ 自定义外观 */
export function Checkbox({ label, labelBelow, className, id, ...props }: CheckboxProps) {
  const box = (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        props.checked || props.defaultChecked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-card",
        props.disabled && "opacity-50",
      )}
    >
      {props.checked || props.defaultChecked ? <Check size={12} strokeWidth={3} /> : null}
    </span>
  );
  if (label == null) {
    return (
      <span className={cn("relative inline-flex", className)}>
        <input
          type="checkbox"
          id={id}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
          {...props}
        />
        {box}
      </span>
    );
  }
  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex cursor-pointer select-none items-center gap-2 text-sm",
        labelBelow && "flex-col items-start gap-1.5",
        props.disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span className="relative inline-flex">
        <input
          type="checkbox"
          id={id}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
          {...props}
        />
        {box}
      </span>
      {label}
    </label>
  );
}
