import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** 统一页头：标题 + 描述（左）与操作按钮（右），对应设计体系 PageHeader */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold leading-7">{title}</h1>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}
