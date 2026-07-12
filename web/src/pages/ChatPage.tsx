import { FolderTree } from "lucide-react";
import { useRef, useState } from "react";
import { FileBrowserDrawer } from "../components/files/FileBrowserDrawer";
import { SecondarySidebar } from "../components/layout/SecondarySidebar";
import { Button } from "../components/ui/button";
import type { FileInfo } from "../lib/chatReducer";
import { useWebChat } from "../lib/webChat";

/** 把 ISO 日期变成 "今天" / "昨天" / 日期 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today.getTime() - dateDay.getTime()) / 86400000;
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function ChatPage() {
  const {
    messages,
    pendingApproval,
    pendingCredential,
    connection,
    conversations,
    activeConversationId,
    send,
    resolveApproval,
    submitCredential,
    switchConversation,
    newConversation,
    deleteConversation,
  } = useWebChat();
  const [text, setText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (pendingFiles.length >= MAX_FILES) {
      alert(`最多上传 ${MAX_FILES} 个文件`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert("文件大小超过 2MB 限制");
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase();
    const isImage =
      file.type.startsWith("image/") && ["jpg", "jpeg", "png", "gif", "webp"].includes(ext ?? "");
    const isMarkdown = ext === "md" || file.type === "text/markdown";
    if (!isImage && !isMarkdown) {
      alert("仅支持图片(.jpg/.png/.gif/.webp)和Markdown(.md)");
      return;
    }
    setUploading(true);
    try {
      const threadId = `web-${Date.now()}`;
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/upload?threadId=${encodeURIComponent(threadId)}`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        alert(err.error);
        return;
      }
      const result = (await res.json()) as FileInfo & { url: string };
      setPendingFiles((prev) => [
        ...prev,
        { path: result.path, name: result.name, type: result.type },
      ]);
    } catch {
      alert("上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function submit() {
    const t = text.trim();
    if (!t && pendingFiles.length === 0) return;
    send(t, pendingFiles.length > 0 ? pendingFiles : undefined);
    setText("");
    setPendingFiles([]);
  }

  const sidebarItems = conversations.map((c) => ({
    id: c.id,
    title: c.title || "(无标题)",
    meta: formatDate(c.updatedAt),
  }));

  return (
    <div className="flex flex-1">
      {/* 中间栏：会话列表 */}
      <SecondarySidebar
        title={`会话（${conversations.length}）`}
        items={sidebarItems}
        selectedId={activeConversationId}
        onItemClick={(id) => switchConversation(id)}
        onNew={newConversation}
        newLabel="新会话"
        onItemDelete={deleteConversation}
      />

      {/* 右侧栏：聊天区域 */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span
            className={
              connection === "open"
                ? "text-green-600"
                : connection === "connecting"
                  ? "text-yellow-600"
                  : "text-red-600"
            }
          >
            ● {connection === "open" ? "已连接" : connection === "connecting" ? "连接中" : "未连接"}
          </span>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent"
            onClick={() => setDrawerOpen(true)}
            title="文件浏览"
          >
            <FolderTree size={14} /> 文件
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-primary-foreground"
                  : "mr-auto max-w-[80%] rounded-lg bg-muted px-3 py-2"
              }
            >
              <span className="whitespace-pre-wrap break-words text-sm">{m.text}</span>
              {m.files && m.files.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.files.map((f) =>
                    f.type === "image" ? (
                      <img
                        key={f.path}
                        src={`/uploads/${f.path.split("/sessions/")[1] ?? ""}`}
                        alt={f.name}
                        className="max-h-32 rounded"
                      />
                    ) : (
                      <span key={f.path} className="text-xs text-muted-foreground">
                        📄 {f.name}
                      </span>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
          {pendingApproval && (
            <div className="mr-auto max-w-[80%] rounded-lg border border-yellow-400 bg-yellow-50 p-3">
              <div className="text-sm font-semibold text-yellow-800">
                🔔 {pendingApproval.title}
              </div>
              <div className="mt-1 text-xs text-yellow-700">{pendingApproval.summary}</div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => resolveApproval(true)}>
                  通过
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => resolveApproval(false, "Web 驳回")}
                >
                  驳回
                </Button>
              </div>
            </div>
          )}
          {pendingCredential && (
            <CredentialCard
              key={pendingCredential.reqId}
              items={pendingCredential.items}
              onSubmit={(values) => submitCredential(values)}
            />
          )}
        </div>

        {pendingFiles.length > 0 && (
          <div className="flex gap-2 border-t border-border px-3 py-2">
            {pendingFiles.map((f) => (
              <div
                key={f.path}
                className="relative flex items-center gap-1 rounded bg-muted p-1 pr-6"
              >
                {f.type === "image" ? (
                  <img
                    src={`/uploads/${f.path.split("/sessions/")[1] ?? ""}`}
                    alt={f.name}
                    className="max-h-10 rounded"
                  />
                ) : (
                  <span className="text-sm">📄 {f.name}</span>
                )}
                <button
                  type="button"
                  className="absolute right-1 top-0 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setPendingFiles((prev) => prev.filter((p) => p.path !== f.path))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 border-t border-border p-3">
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*,.md"
            className="hidden"
            onChange={handleFileSelect}
          />
          <Button
            variant="outline"
            size="icon"
            disabled={pendingFiles.length >= MAX_FILES || uploading}
            onClick={() => fileInputRef.current?.click()}
            title="上传文件"
          >
            📎
          </Button>
          <input
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
            value={text}
            placeholder="输入消息…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button onClick={submit} disabled={uploading}>
            {uploading ? "上传中…" : "发送"}
          </Button>
        </div>
      </div>

      <FileBrowserDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeConversationId={activeConversationId}
      />
    </div>
  );
}

function CredentialCard({
  items,
  onSubmit,
}: {
  items: Array<{
    key: string;
    label: string;
    description?: string;
    secret: boolean;
    packName: string;
  }>;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <div className="mr-auto max-w-[80%] rounded-lg border border-blue-400 bg-blue-50 p-3">
      <div className="text-sm font-semibold text-blue-800">🔑 需要凭证</div>
      <div className="mt-1 text-xs text-blue-700">
        运行此任务需要以下凭证（保存到你的凭证库，以后自动复用）：
      </div>
      <div className="mt-2 space-y-2">
        {items.map((it) => (
          <div key={it.key}>
            <div className="text-xs font-medium text-blue-800">
              {it.label}（{it.packName} · <code>{it.key}</code>）
            </div>
            <input
              type={it.secret ? "password" : "text"}
              className="mt-0.5 w-full rounded border border-blue-300 bg-white px-2 py-1 text-sm"
              placeholder={it.description ?? `输入 ${it.key}`}
              value={values[it.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [it.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="mt-2">
        <Button
          size="sm"
          onClick={() => {
            const filled: Record<string, string> = {};
            for (const [k, v] of Object.entries(values)) if (v) filled[k] = v;
            onSubmit(filled);
          }}
        >
          提交并继续
        </Button>
      </div>
    </div>
  );
}
