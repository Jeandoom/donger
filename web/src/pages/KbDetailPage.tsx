import { ArrowLeft, Copy, RefreshCw, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input } from "../components/ui/input";
import { Segmented } from "../components/ui/segmented";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import {
  fetchKb,
  fetchKbEntry,
  fetchKbRevisions,
  fetchKbShare,
  fetchKbTree,
  type KbLibraryDTO,
  type KbRevisionDTO,
  type KbSearchResultDTO,
  type KbShareInfo,
  type KbTreeDTO,
  type KbTreeEntryDTO,
  removeKbGrant,
  rollbackKbRevision,
  searchKb,
  setKbShare,
  updateKb,
  uploadKbEntry,
} from "../lib/kb";

/**
 * 知识库详情页（spec §11，M1b）：内容（目录树+markdown 查看）/ 配置（库级+分享）/ 修订 三区。
 * 内容维护走对话（D4），页面只读不编辑内容；站内搜索/上传导入/修订回滚为 2026-10 体验轮补齐
 * （检索与上传走独立通道，不改写「编辑靠对话」的产品边界）。
 */
export function KbDetailPage() {
  const { id = "" } = useParams();
  const [lib, setLib] = useState<KbLibraryDTO | null>(null);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"content" | "settings" | "revisions">("content");

  useEffect(() => {
    fetchKb(id)
      .then(setLib)
      .catch((e) => setError(String(e)));
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-4 p-7">
        <p className="text-sm text-destructive">{error}</p>
        <Link to="/kb" className="text-sm text-primary hover:underline">
          ← 返回知识库
        </Link>
      </div>
    );
  }
  if (!lib) {
    return <div className="p-7 text-sm text-muted-foreground">加载中…</div>;
  }

  const manage = lib._role === "manage";

  return (
    <div className="mx-auto flex max-w-6xl flex-1 flex-col gap-4 overflow-y-auto p-7">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/kb"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="返回"
          >
            <ArrowLeft size={16} />
          </Link>
          <h1 className="truncate text-lg font-semibold">{lib.name}</h1>
          {lib.personal ? <Badge tone="info">个人</Badge> : null}
          {lib.builtin ? <Badge tone="info">内置</Badge> : null}
          {!lib.personal && !lib.builtin ? (
            <Badge tone="success">{manage ? "可维护" : "只读"}</Badge>
          ) : null}
        </div>
        <Segmented
          className="ml-auto shrink-0"
          options={[
            { value: "content", label: "内容" },
            ...(manage ? [{ value: "settings" as const, label: "配置" }] : []),
            { value: "revisions", label: "修订" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === "content" ? <ContentTab kbId={id} manage={manage} /> : null}
      {tab === "settings" && manage ? <SettingsTab lib={lib} onSaved={setLib} /> : null}
      {tab === "revisions" ? <RevisionsTab kbId={id} manage={manage} /> : null}
    </div>
  );
}

function ContentTab({ kbId, manage }: { kbId: string; manage: boolean }) {
  const [tree, setTree] = useState<KbTreeDTO | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string>();
  const [entryError, setEntryError] = useState<string>();
  // 站内搜索（与 agent kb_search 同实现）
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KbSearchResultDTO | null>(null);
  const [searchError, setSearchError] = useState<string>();
  // 上传导入（.md，落库根；重名覆盖有修订账本兜底）
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();

  const reloadTree = useCallback(async () => {
    const t = await fetchKbTree(kbId);
    setTree(t);
    return t;
  }, [kbId]);

  useEffect(() => {
    reloadTree()
      .then((t) => {
        // 默认选中首个 markdown 条目（迁移生成的个人库没有 index.md 骨架，不能硬编码）
        setSelected((cur) => cur ?? firstMarkdownEntry(t.entries)?.path ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [kbId, reloadTree]);

  useEffect(() => {
    if (!selected) {
      setContent("");
      setEntryError("");
      return;
    }
    fetchKbEntry(kbId, selected)
      .then((c) => {
        setContent(c);
        setEntryError("");
      })
      .catch((e) => {
        setContent("");
        setEntryError(e instanceof Error ? e.message : String(e));
      });
  }, [kbId, selected]);

  const runSearch = async (): Promise<void> => {
    const q = query.trim();
    if (!q) {
      setSearchResult(null);
      setSearchError(undefined);
      return;
    }
    setSearching(true);
    setSearchError(undefined);
    try {
      setSearchResult(await searchKb(kbId, q));
    } catch (e) {
      setSearchResult(null);
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const onPickFile = async (file: File): Promise<void> => {
    setUploadError(undefined);
    if (!file.name.toLowerCase().endsWith(".md")) {
      setUploadError("仅支持 .md 文件");
      return;
    }
    if (file.size > 1_000_000) {
      setUploadError("单文件上限 1MB");
      return;
    }
    setUploading(true);
    try {
      const text = await file.text();
      await uploadKbEntry(kbId, file.name, text);
      await reloadTree();
      setSelected(file.name);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!tree) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      {/* 移动端纵向堆叠：目录限高内部滚动，预览占主体随页滚动；md 起恢复双栏 */}
      <div className="flex w-full shrink-0 flex-col gap-2 md:w-64">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="站内搜索…"
            className="h-8 text-xs"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={searching}>
            <Search size={13} />
          </Button>
        </form>
        {searchError ? <p className="text-xs text-destructive">{searchError}</p> : null}
        {searchResult ? (
          <Card className="max-h-52 overflow-y-auto p-2">
            <p className="mb-1 text-[11px] text-muted-foreground">
              「{searchResult.query}」命中 {searchResult.total} 条
              {searchResult.truncated ? "（已截断）" : ""}
            </p>
            {searchResult.hits.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">无命中</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {searchResult.hits.map((h, i) => (
                  <li key={`${h.path}:${h.line}:${i}`}>
                    <button
                      type="button"
                      onClick={() => setSelected(h.path)}
                      className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                    >
                      <span className="block truncate font-medium">{h.path}</span>
                      <span className="block truncate text-muted-foreground">
                        L{h.line} · {h.snippet}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
        <Card className="max-h-56 w-full overflow-y-auto p-3 md:max-h-none md:flex-1">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground">
              目录（{tree.total}
              {tree.truncated ? "，已截断" : ""}）
            </p>
            {manage ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,text/markdown"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPickFile(f);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  title="上传 .md 导入（落库根目录，重名覆盖；变更记入修订账本）"
                >
                  <Upload size={12} />
                  {uploading ? "上传中…" : "上传"}
                </Button>
              </>
            ) : null}
          </div>
          {uploadError ? <p className="mb-1 text-xs text-destructive">{uploadError}</p> : null}
          <TreeNodes
            entries={tree.entries}
            selected={selected ?? ""}
            onSelect={setSelected}
            depth={0}
          />
        </Card>
      </div>
      <Card className="min-w-0 flex-1 overflow-y-auto p-5">
        {entryError ? (
          <p className="text-sm text-destructive">{entryError}</p>
        ) : selected ? (
          <article className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">
            暂无内容，可上传 .md 导入，或通过对话让智能体维护知识库。
          </p>
        )}
      </Card>
    </div>
  );
}

function firstMarkdownEntry(entries: KbTreeEntryDTO[]): KbTreeEntryDTO | undefined {
  for (const e of entries) {
    if (e.type === "file") {
      if (e.name.toLowerCase().endsWith(".md")) return e;
    } else if (e.children?.length) {
      const hit = firstMarkdownEntry(e.children);
      if (hit) return hit;
    }
  }
  return undefined;
}

function TreeNodes({
  entries,
  selected,
  onSelect,
  depth,
}: {
  entries: KbTreeEntryDTO[];
  selected: string;
  onSelect: (path: string) => void;
  depth: number;
}) {
  return (
    <ul className="flex flex-col gap-0.5" style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
      {entries.map((e) => (
        <li key={e.path}>
          {e.type === "dir" ? (
            <div>
              <span className="text-xs font-medium text-muted-foreground">{e.name}/</span>
              {e.children && e.children.length > 0 ? (
                <TreeNodes
                  entries={e.children}
                  selected={selected}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onSelect(e.path)}
              className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-muted ${
                selected === e.path ? "bg-primary-soft font-medium text-primary" : ""
              }`}
            >
              {e.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SettingsTab({ lib, onSaved }: { lib: KbLibraryDTO; onSaved: (l: KbLibraryDTO) => void }) {
  const [form, setForm] = useState({
    name: lib.name,
    description: lib.description,
    systemPrompt: lib.systemPrompt ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const shareable = !lib.personal && !lib.builtin;

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const updated = await updateKb(lib.id, form);
      onSaved({ ...lib, ...updated });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">库配置</h2>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">名称</span>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">描述</span>
          <Input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            库提示词（规范组织结构、说明用途；本人库直拼进对话，他人库以不可信内容包裹注入）
          </span>
          <Textarea
            value={form.systemPrompt}
            onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            rows={4}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          {saved ? <span className="text-xs text-muted-foreground">已保存</span> : null}
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </Card>
      {shareable ? <ShareCard lib={lib} /> : null}
    </div>
  );
}

function ShareCard({ lib }: { lib: KbLibraryDTO }) {
  const [share, setShare] = useState<KbShareInfo | null>(null);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    fetchKbShare(lib.id)
      .then(setShare)
      .catch((e) => setError(String(e)));
  }, [lib.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = async (enabled: boolean): Promise<void> => {
    try {
      setShare(await setKbShare(lib.id, enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyLink = async (): Promise<void> => {
    if (!share?.token) return;
    await navigator.clipboard.writeText(`${window.location.origin}/kb-share/${share.token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">分享</h2>
        <Switch checked={!!share?.enabled} onCheckedChange={(v) => void toggle(v)} />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {share?.enabled && share.token ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
              {window.location.origin}/kb-share/{share.token}
            </code>
            <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
              {copied ? <RefreshCw size={12} /> : <Copy size={12} />}
              {copied ? "已复制" : "复制链接"}
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              已授权（{share.grants.length}）——被分享者只读，可通过对话查阅
            </span>
            {share.grants.map((g) => (
              <div
                key={g.userId}
                className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted/60"
              >
                <span className="truncate font-mono">{g.userId}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    void removeKbGrant(lib.id, g.userId).then(reload);
                  }}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

const ACTION_LABELS: Record<KbRevisionDTO["action"], string> = {
  create: "新建",
  update: "更新",
  delete: "删除",
  config: "配置",
  import: "导入",
  "library-deleted": "删库",
};

const ACTOR_LABELS: Record<KbRevisionDTO["actorKind"], string> = {
  manual: "页面",
  chat: "对话",
  "auto-learn": "自动学习",
  memory: "记忆",
  import: "迁移",
  system: "系统",
};

function RevisionsTab({ kbId, manage }: { kbId: string; manage: boolean }) {
  const [revisions, setRevisions] = useState<KbRevisionDTO[] | null>(null);
  const [error, setError] = useState<string>();
  // 按文件过滤（服务端 ?path=；后端账本查询原生支持）
  const [pathFilter, setPathFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  // 回滚（服务端 beforeContent 快照；restorable 才可点）
  const [rollbackTarget, setRollbackTarget] = useState<KbRevisionDTO | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackDone, setRollbackDone] = useState<string>();

  const reload = useCallback(
    (path?: string) => {
      fetchKbRevisions(kbId, path ? { path } : undefined)
        .then(setRevisions)
        .catch((e) => setError(String(e)));
    },
    [kbId],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!revisions) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (revisions.length === 0 && !appliedFilter) {
    return <p className="text-sm text-muted-foreground">暂无修订记录</p>;
  }

  const confirmRollback = async (): Promise<void> => {
    if (!rollbackTarget) return;
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      await rollbackKbRevision(kbId, rollbackTarget.id);
      setRollbackDone(`已恢复「${rollbackTarget.path}」，变更记入修订账本`);
      setRollbackTarget(null);
      reload(appliedFilter || undefined);
    } catch (e) {
      setRollbackError(e instanceof Error ? e.message : String(e));
    } finally {
      setRollbackBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const p = pathFilter.trim();
            setAppliedFilter(p);
            reload(p || undefined);
          }}
        >
          <Input
            value={pathFilter}
            onChange={(e) => setPathFilter(e.target.value)}
            placeholder="按文件路径过滤…"
            className="h-8 w-56 text-xs"
          />
          <Button type="submit" variant="secondary" size="sm">
            筛选
          </Button>
          {appliedFilter ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPathFilter("");
                setAppliedFilter("");
                reload();
              }}
            >
              清除
            </Button>
          ) : null}
        </form>
        <Button variant="secondary" size="sm" onClick={() => reload(appliedFilter || undefined)}>
          <RefreshCw size={12} /> 刷新
        </Button>
      </div>
      {rollbackDone ? <p className="text-xs text-primary">{rollbackDone}</p> : null}
      <p className="text-xs text-muted-foreground">
        共 {revisions.length} 条{appliedFilter ? `（路径含「${appliedFilter}」）` : ""}
        （每文件保留最近 50 条变更详情，更早的仅留时间线）
      </p>
      {revisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">该路径暂无修订记录</p>
      ) : null}
      {revisions.map((r) => (
        <Card key={r.id} className="flex flex-col gap-1.5 p-3">
          <div className="flex items-center gap-2">
            <Badge
              tone={r.action === "delete" || r.action === "library-deleted" ? "danger" : "info"}
            >
              {ACTION_LABELS[r.action]}
            </Badge>
            <span className="min-w-0 truncate text-xs font-medium">{r.path || "（库级）"}</span>
            <Badge>{ACTOR_LABELS[r.actorKind]}</Badge>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {new Date(r.createdAt).toLocaleString()}
            </span>
          </div>
          {r.summary ? <p className="text-xs text-muted-foreground">{r.summary}</p> : null}
          {r.conversationId ? (
            <p className="text-[11px] text-muted-foreground">来源会话：{r.conversationId}</p>
          ) : null}
          {r.diffText ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-primary">变更详情</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px] leading-4">
                {r.diffText}
              </pre>
            </details>
          ) : null}
          {manage && r.restorable && (r.action === "update" || r.action === "delete") ? (
            <div className="mt-1 flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setRollbackTarget(r)}>
                恢复到此次变更前
              </Button>
            </div>
          ) : null}
        </Card>
      ))}
      <ConfirmDialog
        open={rollbackTarget !== null}
        title="恢复到此次变更前"
        description={
          rollbackTarget
            ? `将「${rollbackTarget.path}」恢复为修订 ${rollbackTarget.id.slice(0, 8)}（${new Date(rollbackTarget.createdAt).toLocaleString()}）之前的内容；当前内容会先记入修订账本，可再次回滚找回。`
            : ""
        }
        confirmText="恢复"
        busy={rollbackBusy}
        error={rollbackError}
        onConfirm={() => void confirmRollback()}
        onCancel={() => {
          setRollbackTarget(null);
          setRollbackError(null);
        }}
      />
    </div>
  );
}
