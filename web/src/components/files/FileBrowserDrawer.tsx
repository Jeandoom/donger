import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getToken } from "../../lib/auth";
import { contentUrl, type FileNode, type FileScope, fetchTree } from "../../lib/files";
import { cn } from "../../lib/utils";
import { FileChangesTab } from "./FileChangesTab";
import { FilePreview } from "./FilePreview";
import { FileTree } from "./FileTree";

type DrawerTab = "files" | "changes";

export function FileBrowserDrawer(props: {
  open: boolean;
  onClose: () => void;
  activeConversationId: string | null;
}) {
  const { open, onClose, activeConversationId } = props;
  const [tab, setTab] = useState<DrawerTab>("files");
  const [scope, setScope] = useState<FileScope>("runtime");
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  const token = getToken() ?? "";
  // runtime/扩展都挂在会话上；缺会话则不加载
  const convId = activeConversationId ?? "";

  async function reload(): Promise<void> {
    if (!convId) {
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 依赖多个状态，仅在 open/scope/会话/tab 变化时触发
  useEffect(() => {
    if (open && tab === "files") void reload();
  }, [open, scope, activeConversationId, tab]);

  function switchScope(s: FileScope): void {
    setScope(s);
    setSelected(null);
  }

  function switchTab(t: DrawerTab): void {
    setTab(t);
    if (t === "changes") setRefreshTick((n) => n + 1); // 每次进入变更 tab 重新拉取
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
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        className={cn(
          "fixed inset-0 z-40 block bg-black/30 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      {/* 抽屉：关闭后滑出视口并从无障碍树/Tab 序移除（visibility 延迟到动画结束）；
          变更 tab 需要并排列表+diff，加宽一档 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="文件浏览"
        aria-hidden={!open}
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-border bg-card shadow-xl sm:w-80",
          tab === "changes" && "sm:w-[40rem]",
          open
            ? "visible translate-x-0 transition-transform duration-300"
            : "invisible translate-x-full [transition:transform_.3s_ease,visibility_0s_.3s]",
        )}
      >
        {/* 顶栏：主 tab（文件 | 变更）+ 文件树的 scope 切换 + 刷新/关闭 */}
        <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
          {(
            [
              ["files", "文件"],
              ["changes", "变更"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-semibold",
                tab === value
                  ? "bg-primary-soft text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => switchTab(value)}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          {tab === "files"
            ? (
                [
                  ["runtime", "runtime"],
                  ["extension", "扩展"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs",
                    scope === value
                      ? "bg-primary-soft font-semibold text-primary"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  onClick={() => switchScope(value)}
                >
                  {label}
                </button>
              ))
            : null}
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-8 sm:min-w-8"
            onClick={() => {
              if (tab === "files") void reload();
              else setRefreshTick((n) => n + 1);
            }}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-8 sm:min-w-8"
            onClick={onClose}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {tab === "changes" ? (
          <FileChangesTab key={refreshTick} conversationId={convId} />
        ) : (
          <>
            {error && (
              <div className="bg-destructive-soft px-3 py-1 text-xs text-destructive">{error}</div>
            )}

            {/* 树区 */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <RefreshCw size={14} className="animate-spin" />
                  加载中…
                </div>
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
          </>
        )}
      </div>
    </>
  );
}
