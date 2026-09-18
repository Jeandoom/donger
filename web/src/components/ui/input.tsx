import type { InputHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** 等宽字体（URL/路径/代码类内容） */
  mono?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none disabled:opacity-50",
        mono && "font-mono text-xs",
        className,
      )}
      {...props}
    />
  );
});
