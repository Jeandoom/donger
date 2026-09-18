import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  Loader2,
  Notebook,
  Plug,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";

type IconComponent = typeof Bot;

const TOOL_ICONS: Record<string, IconComponent> = {
  Bash: Terminal,
  Read: FileText,
  Edit: FilePen,
  Write: FilePlus,
  NotebookEdit: Notebook,
  Grep: Search,
  Glob: FolderSearch,
  Task: Bot,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListTodo,
};

/** 工具显示名：mcp__<server>__<name> → <server> · <name> */
function toolDisplayName(tool: string): string {
  if (tool.startsWith("mcp__")) {
    const [, server, name] = tool.split("__");
    if (server && name) return `${server} · ${name}`;
  }
  return tool;
}

function toolIcon(tool: string): IconComponent {
  const builtin = TOOL_ICONS[tool];
  if (builtin) return builtin;
  return tool.startsWith("mcp__") ? Plug : Wrench;
}

/** 单行摘要：输入 JSON 取首字段值/命令，退化为原文 */
function inputSummary(inputPreview: string): string {
  if (!inputPreview || inputPreview === "{}") return "";
  try {
    const parsed = JSON.parse(inputPreview) as Record<string, unknown>;
    const command = parsed.command ?? parsed.file_path ?? parsed.query ?? parsed.pattern;
    if (typeof command === "string") return command.replace(/\s+/g, " ").slice(0, 120);
  } catch {
    // 截断 JSON → 原文
  }
  return inputPreview.replace(/\s+/g, " ").slice(0, 120);
}

/**
 * 工具调用折叠卡：默认折叠；头部 = 图标 + 工具名 + 输入摘要 + 状态；
 * 展开 = 输入/输出代码块。
 * 运行中判定：桥接层在 tool_result 到达时必回填 result，因此 result 缺省即运行中。
 * props 即分片字段（assistant-ui 将 part 平铺进组件 props）。
 */
export function ToolCard({ toolName, argsText, result, isError }: ToolCallMessagePartProps) {
  const [open, setOpen] = useState(false);
  const running = result === undefined;
  const failed = isError === true;
  const Icon = toolIcon(toolName);

  return (
    <div
      className={cn(
        "my-1 overflow-hidden rounded-lg border bg-background text-xs",
        failed && "border-destructive/40",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full max-w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        <Icon aria-hidden="true" size={13} className="shrink-0" />
        <span className="shrink-0 font-medium">{toolDisplayName(toolName)}</span>
        <span className="min-w-0 flex-1 truncate font-mono opacity-70">
          {inputSummary(argsText)}
        </span>
        {running ? (
          <Loader2 aria-hidden="true" size={13} className="shrink-0 animate-spin text-primary" />
        ) : failed ? (
          <AlertTriangle aria-hidden="true" size={13} className="shrink-0 text-destructive" />
        ) : (
          <Check aria-hidden="true" size={13} className="shrink-0 text-emerald-600" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t px-2.5 py-2">
          <ToolIOSection label="输入" text={argsText} />
          {typeof result === "string" && result.length > 0 && (
            <ToolIOSection label={failed ? "错误" : "输出"} text={result} failed={failed} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolIOSection({ label, text, failed }: { label: string; text: string; failed?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-medium text-muted-foreground/70">{label}</div>
      <pre
        className={cn(
          "max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-5",
          failed && "text-destructive",
        )}
      >
        {text}
      </pre>
    </div>
  );
}
