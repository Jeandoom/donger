import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getToken } from "../../lib/auth";
import { contentUrl, type FileNode, type FileScope, fetchTree } from "../../lib/files";
import { cn } from "../../lib/utils";
import { FilePreview } from "./FilePreview";
import { FileTree } from "./FileTree";

export function FileBrowserDrawer(props: {
  open: boolean;
  onClose: () => void;
  activeConversationId: string | null;
}) {
  const { open, onClose, activeConversationId } = props;
  const [scope, setScope] = useState<FileScope>("user");
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const token = getToken() ?? "";
  // runtime 必须有会话；缺则不加载
  const convId = scope !== "user" ? (activeConversationId ?? "") : undefined;

  async function reload(): Promise<void> {
    if (scope !== "user" && !convId) {
      setNodes([]);
      setError("当前无活跃会话");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setNodes(await fetchTree({ scope, conversationId: convId, token }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 依赖多个状态，仅在 open/scope/会话变化时触发
  useEffect(() => {
    if (open) void reload();
  }, [open, scope, activeConversationId]);

  function switchScope(s: FileScope): void {
    setScope(s);
    setSelected(null);
  }

  const dl = selected
    ? contentUrl({ scope, path: selected, conversationId: convId, token, download: true })
    : "";

  return (
    <>
      {/* 遮罩 */}
      <button
        type="button"
        aria-label="关闭抽屉"
        className={cn(
          "fixed inset-0 z-40 block bg-black/30 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      {/* 抽屉 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="文件浏览"
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-border bg-background shadow-xl transition-transform sm:w-80",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* 顶栏 */}
        <div className="flex items-center gap-1 border-b border-border px-2 py-2">
          <button
            type="button"
            className={cn(
              "rounded px-2 py-1 text-xs",
              scope === "user" ? "bg-accent font-medium" : "text-muted-foreground",
            )}
            onClick={() => switchScope("user")}
          >
            user
          </button>
          <button
            type="button"
            className={cn(
              "rounded px-2 py-1 text-xs",
              scope === "runtime" ? "bg-accent font-medium" : "text-muted-foreground",
            )}
            onClick={() => switchScope("runtime")}
          >
            runtime
          </button>
          <button
            type="button"
            className={cn(
              "rounded px-2 py-1 text-xs",
              scope === "extension" ? "bg-accent font-medium" : "text-muted-foreground",
            )}
            onClick={() => switchScope("extension")}
          >
            扩展
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:text-foreground sm:min-h-8 sm:min-w-8"
            onClick={() => void reload()}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:text-foreground sm:min-h-8 sm:min-w-8"
            onClick={onClose}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {error && <div className="bg-red-50 px-3 py-1 text-xs text-red-700">{error}</div>}

        {/* 树区 */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">加载中…</div>
          ) : nodes.length === 0 && !error ? (
            <div className="p-3 text-sm text-muted-foreground">(空)</div>
          ) : (
            <FileTree
              nodes={nodes}
              selectedPath={selected ?? undefined}
              onSelect={setSelected}
              downloadUrlFor={(p) =>
                contentUrl({ scope, path: p, conversationId: convId, token, download: true })
              }
            />
          )}
        </div>

        {/* 预览区 */}
        {selected && (
          <div className="max-h-[55%] shrink-0 overflow-y-auto border-t border-border">
            <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-muted-foreground">
              <span className="truncate">{selected}</span>
              {dl && (
                <a href={dl} className="text-primary underline" title="下载">
                  下载
                </a>
              )}
            </div>
            <FilePreview scope={scope} path={selected} conversationId={convId} />
          </div>
        )}
      </div>
    </>
  );
}
