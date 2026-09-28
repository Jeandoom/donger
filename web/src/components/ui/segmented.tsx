import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegmentedProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** 无障碍标签（aria-label） */
  name?: string;
  /** 禁用整组（如编辑态锁定不可变更的字段） */
  disabled?: boolean;
}

/** 分段控制器（如：全部工具 / 白名单） */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  name,
  disabled = false,
}: SegmentedProps<T>) {
  return (
    <fieldset
      aria-label={name}
      disabled={disabled}
      className={cn(
        "inline-flex h-9 items-center gap-0.5 rounded-lg border-0 bg-muted p-1",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "h-7 rounded-md px-3 text-[13px] font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed hover:text-muted-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}
