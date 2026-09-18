import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/** 原生 select 的样式化包装（保留原生可访问性与移动端体验） */
export function Select({ className, children, ...props }: SelectProps) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="h-9 w-full appearance-none rounded-lg border border-border bg-card px-3 pr-8 text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
