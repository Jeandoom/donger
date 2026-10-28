import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 配置分区卡片：锚点 id + 序号徽标 + 标题/描述 + 右侧补充动作。
 * 供 AgentEditor 左侧锚点导航 scrollIntoView 定位。
 * collapsible 时标题行右侧出现展开/收起箭头，收起态隐藏描述与内容（头部动作仍可操作，
 * 如工作流编辑页「启动开关打开即展开分区」）。
 */
export function FormSection({
  id,
  no,
  title,
  description,
  actions,
  children,
  className,
  collapsible,
  collapsed,
  onCollapsedChange,
}: {
  id: string;
  no: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const expanded = !collapsible || !collapsed;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "scroll-mt-28 rounded-xl border border-border bg-card p-6 shadow-sm",
        className,
      )}
    >
      <header className={cn("flex items-center gap-2.5", expanded && "mb-4")}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-primary-soft text-xs font-bold text-primary">
          {no}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-base font-semibold leading-6">
            {title}
          </h2>
          {description && expanded ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        {collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "收起" : "展开"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onCollapsedChange?.(!collapsed)}
          >
            <ChevronDown
              aria-hidden="true"
              size={16}
              className={cn("transition-transform", !expanded && "-rotate-90")}
            />
          </button>
        ) : null}
      </header>
      {expanded ? <div className="flex flex-col gap-3.5">{children}</div> : null}
    </section>
  );
}

/** 表单字段：标签 + 可选提示 + 控件 */
export function FormField({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline gap-1">
        <span className="text-[13px] font-semibold">{label}</span>
        {required ? <span className="text-destructive">*</span> : null}
      </div>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
