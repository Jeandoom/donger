import { FilePlus2, FileText, RefreshCw, ScissorsLineDashed } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useState } from "react";
import {
  type DiffRow,
  type FileChangeContent,
  type FileChangeDetail,
  type FileChangeSummary,
  fetchFileChangeContent,
  fetchFileChangeDetail,
  fetchFileChanges,
} from "../../lib/fileChanges";
import { cn } from "../../lib/utils";
import { Segmented } from "../ui/segmented";

/** prism-react-renderer 内置语言集之外的语言回退纯文本展示 */
const PRISM_LANGS = new Set([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "yaml",
  "markup",
  "css",
  "scss",
  "python",
  "go",
  "sql",
  "bash",
  "c",
  "cpp",
  "diff",
  "ruby",
  "java",
  "rust",
  "php",
  "csharp",
  "kotlin",
  "swift",
  "toml",
  "ini",
]);

const TOOL_LABEL: Record<string, string> = {
  Write: "写入",
  Edit: "编辑",
  MultiEdit: "多处编辑",
  NotebookEdit: "Notebook 编辑",
};

function DiffRows({ rows }: { rows: DiffRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border font-mono text-[11px] leading-[1.6]">
      {rows.map((row, idx) => (
        <div
          key={idx}
          className={cn(
            "flex min-w-max whitespace-pre",
            row.type === "add" && "bg-success-soft",
            row.type === "del" && "bg-destructive-soft",
          )}
        >
          <span className="w-10 shrink-0 select-none border-r border-border px-1 text-right text-muted-foreground/60">
            {row.oldNo ?? ""}
          </span>
          <span className="w-10 shrink-0 select-none border-r border-border px-1 text-right text-muted-foreground/60">
            {row.newNo ?? ""}
          </span>
          <span
            className={cn(
              "w-4 shrink-0 select-none text-center",
              row.type === "add" && "text-success",
              row.type === "del" && "text-destructive",
            )}
          >
            {row.type === "add" ? "+" : row.type === "del" ? "-" : ""}
          </span>
          <span className="px-2">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function ResultView({
  conversationId,
  path,
  language,
}: {
  conversationId: string;
  path: string;
  language: string;
}) {
  const [content, setContent] = useState<FileChangeContent | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchFileChangeContent(conversationId, path)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, path]);

  if (loading) return <p className="p-3 text-xs text-muted-foreground">读取当前内容…</p>;
  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (!content) return null;
  const code = content.content;
  if (PRISM_LANGS.has(language)) {
    return (
      <Highlight code={code} language={language} theme={themes.oneDark}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="overflow-x-auto rounded-lg border border-border bg-[#282c34] p-2.5 font-mono text-[11px] leading-[1.6]">
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-[1.6]">
      {code}
    </pre>
  );
}

/** 对话文件变更 tab：左列表 + 右详情（diff 默认 / 当前结果） */
export function FileChangesTab({ conversationId }: { conversationId: string }) {
  const [files, setFiles] = useState<FileChangeSummary[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<FileChangeSummary | null>(null);
  const [detail, setDetail] = useState<FileChangeDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [mode, setMode] = useState<"diff" | "result">("diff");

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setSelected(null);
    setDetail(null);
    setError("");
    if (!conversationId) return () => undefined;
    fetchFileChanges(conversationId)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const openDetail = (file: FileChangeSummary) => {
    setSelected(file);
    setDetail(null);
    setDetailError("");
    setMode("diff");
    fetchFileChangeDetail(conversationId, file.path)
      .then(setDetail)
      .catch((reason: unknown) =>
        setDetailError(reason instanceof Error ? reason.message : String(reason)),
      );
  };

  if (!conversationId) {
    return <p className="p-3 text-sm text-muted-foreground">当前无活跃会话</p>;
  }
  if (error) {
    return <p className="p-3 text-xs text-destructive">{error}</p>;
  }
  if (files === null) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
        <RefreshCw size={14} className="animate-spin" />
        加载中…
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <p className="p-3 text-sm text-muted-foreground">
        本会话还没有文件变更（由 Write / Edit 等写入操作还原；Bash 重定向等旁路写盘不在此列）
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 文件列表 */}
      <div className="shrink-0 space-y-1 overflow-y-auto border-b border-border p-2 sm:max-h-[40%]">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
              selected?.path === f.path
                ? "bg-primary-soft font-semibold text-primary"
                : "hover:bg-muted",
            )}
            onClick={() => openDetail(f)}
          >
            {f.firstOp === "created" ? (
              <FilePlus2 size={13} className="shrink-0 text-success" />
            ) : (
              <FileText size={13} className="shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate" title={f.displayPath}>
              {f.displayPath}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-success">+{f.adds}</span>
            <span className="shrink-0 font-mono text-[10px] text-destructive">-{f.removes}</span>
            {f.truncated ? (
              <span title="部分变更入参被截断，diff 可能不完整" className="shrink-0 text-warning">
                <ScissorsLineDashed size={12} />
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* 详情 */}
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold" title={selected.path}>
                {selected.displayPath}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {selected.firstOp === "created" ? "新建" : "修改"} ·{" "}
                {new Date(selected.lastChangedAt).toLocaleString()}
                {detail ? ` · ${detail.segments.length} 次变更` : ""}
              </p>
            </div>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v)}
              options={[
                { value: "diff", label: "变更" },
                { value: "result", label: "当前内容" },
              ]}
            />
          </div>
          {detailError ? <p className="text-xs text-destructive">{detailError}</p> : null}
          {!detail && !detailError ? (
            <p className="text-xs text-muted-foreground">加载变更详情…</p>
          ) : null}
          {detail && mode === "diff" ? (
            <div className="space-y-3">
              {detail.segments.map((seg, i) => (
                <div key={i} className="space-y-1">
                  <p className="text-[10px] text-muted-foreground">
                    {TOOL_LABEL[seg.tool] ?? seg.tool} ·{" "}
                    {seg.kind === "write" ? "全量写入" : "增量修改"} ·{" "}
                    <span className="text-success">+{seg.adds}</span>{" "}
                    <span className="text-destructive">-{seg.removes}</span> ·{" "}
                    {new Date(seg.at).toLocaleString()}
                    {seg.truncated ? " · 入参被截断，diff 不完整" : ""}
                  </p>
                  <DiffRows rows={seg.rows} />
                </div>
              ))}
            </div>
          ) : null}
          {detail && mode === "result" ? (
            <ResultView
              conversationId={conversationId}
              path={selected.path}
              language={detail.language}
            />
          ) : null}
        </div>
      ) : (
        <p className="p-3 text-xs text-muted-foreground">选择左侧文件查看变更</p>
      )}
    </div>
  );
}
