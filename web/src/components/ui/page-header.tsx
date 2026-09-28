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
    <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
      {/* min-w 兜底：窄屏下左列不被按钮挤成逐字竖排，放不下时按钮整行换行 */}
      <div className="flex min-w-[140px] flex-1 flex-col gap-1">
        <h1 className="text-[22px] font-bold leading-7">{title}</h1>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-2.5">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
