import { ArrowLeft, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
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
  type KbShareInfo,
  type KbTreeDTO,
  type KbTreeEntryDTO,
  removeKbGrant,
  setKbShare,
  updateKb,
} from "../lib/kb";

/**
 * 知识库详情页（spec §11，M1b）：内容（目录树+markdown 查看）/ 配置（库级+分享）/ 修订 三区。
 * 内容维护走对话（D4），页面只读不编辑内容。
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/kb" className="text-muted-foreground hover:text-foreground" title="返回">
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
          options={[
            { value: "content", label: "内容" },
            ...(manage ? [{ value: "settings" as const, label: "配置" }] : []),
            { value: "revisions", label: "修订" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === "content" ? <ContentTab kbId={id} /> : null}
      {tab === "settings" && manage ? <SettingsTab lib={lib} onSaved={setLib} /> : null}
      {tab === "revisions" ? <RevisionsTab kbId={id} /> : null}
    </div>
  );
}

function ContentTab({ kbId }: { kbId: string }) {
  const [tree, setTree] = useState<KbTreeDTO | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string>();
  const [entryError, setEntryError] = useState<string>();

  useEffect(() => {
    fetchKbTree(kbId)
      .then((t) => {
        setTree(t);
        // 默认选中首个 markdown 条目（迁移生成的个人库没有 index.md 骨架，不能硬编码）
        setSelected((cur) => cur ?? firstMarkdownEntry(t.entries)?.path ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [kbId]);

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

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!tree) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <Card className="w-64 shrink-0 overflow-y-auto p-3">
        <p className="mb-2 text-xs font-semibold text-muted-foreground">
          目录（{tree.total}
          {tree.truncated ? "，已截断" : ""}）
        </p>
        <TreeNodes
          entries={tree.entries}
          selected={selected ?? ""}
          onSelect={setSelected}
          depth={0}
        />
      </Card>
      <Card className="min-w-0 flex-1 overflow-y-auto p-5">
        {entryError ? (
          <p className="text-sm text-destructive">{entryError}</p>
        ) : selected ? (
          <article className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">暂无内容，可通过对话让智能体维护知识库。</p>
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

function RevisionsTab({ kbId }: { kbId: string }) {
  const [revisions, setRevisions] = useState<KbRevisionDTO[] | null>(null);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    fetchKbRevisions(kbId)
      .then(setRevisions)
      .catch((e) => setError(String(e)));
  }, [kbId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!revisions) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (revisions.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无修订记录</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          共 {revisions.length} 条（每文件保留最近 50 条变更详情，更早的仅留时间线）
        </p>
        <Button variant="secondary" size="sm" onClick={reload}>
          <RefreshCw size={12} /> 刷新
        </Button>
      </div>
      {revisions.map((r) => (
        <Card key={r.id} className="flex flex-col gap-1.5 p-3">
          <div className="flex items-center gap-2">
            <Badge
              tone={
                r.action === "delete" || r.action === "library-deleted" ? "danger" : "info"
              }
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
        </Card>
      ))}
    </div>
  );
}
