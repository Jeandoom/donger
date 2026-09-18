import type { TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** 等宽字体（代码/URL/JSON 场景） */
  mono?: boolean;
};

export function Textarea({ className, mono, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none disabled:opacity-50",
        mono && "font-mono text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}
