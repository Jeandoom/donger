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
}

/** 分段控制器（如：全部工具 / 白名单） */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  name,
}: SegmentedProps<T>) {
  return (
    <fieldset
      aria-label={name}
      className={cn(
        "inline-flex h-9 items-center gap-0.5 rounded-lg border-0 bg-muted p-1",
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
            onClick={() => onChange(opt.value)}
            className={cn(
              "h-7 rounded-md px-3 text-[13px] font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}
