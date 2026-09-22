import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Textarea } from "../components/ui/textarea";
import { createKb, deleteKb, duplicateKb, fetchKnowledgeBases, type KbLibraryDTO } from "../lib/kb";

/**
 * 知识库模块列表页（spec 2026-09-22-knowledge-base-design §11）：
 * 三块分组同构智能体页（我创建的[个人库置顶] / 分享给我的 / 系统默认）。
 * 内容维护走对话（D4），页面只做创建+查看+库级配置；详情页（树/配置/分享/修订）见 KbDetailPage。
 */
export function KnowledgeBasePage() {
  const [libs, setLibs] = useState<KbLibraryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", systemPrompt: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<KbLibraryDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  useEffect(() => {
    fetchKnowledgeBases()
      .then(setLibs)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteKb(pendingDelete.id);
      setLibs((list) => list.filter((l) => l.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = async (): Promise<void> => {
    if (!form.name.trim()) {
      setFormError("请填写知识库名称");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createKb({
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt.trim(),
      });
      setLibs((list) => [created, ...list.filter((l) => l.id !== created.id)]);
      setForm({ name: "", description: "", systemPrompt: "" });
      setCreating(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDuplicate = async (l: KbLibraryDTO): Promise<void> => {
    setDuplicatingId(l.id);
    try {
      const copy = await duplicateKb(l.id);
      setLibs((list) => [copy, ...list.filter((x) => x.id !== copy.id)]);
    } catch (e) {
      setError(String(e));
    } finally {
      setDuplicatingId(null);
    }
  };

  const kw = keyword.trim().toLowerCase();
  const match = (l: KbLibraryDTO) =>
    !kw || l.name.toLowerCase().includes(kw) || l.description.toLowerCase().includes(kw);
  // 我创建的：个人库置顶（懒 ensure 后首个），其余按 updatedAt
  const mine = libs
    .filter((l) => l._mine && !l.builtin && match(l))
    .sort((a, b) => (a.personal === b.personal ? 0 : a.personal ? -1 : 1));
  const shared = libs.filter((l) => !l._mine && !l.builtin && match(l));
  const builtins = libs.filter((l) => l.builtin && match(l));

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="知识库"
        description="沉淀可对话维护的 markdown 知识；内容通过对话维护，每次变更自动记入修订"
        actions={
          <Button onClick={() => setCreating((v) => !v)}>
            {creating ? "收起" : "+ 新建知识库"}
          </Button>
        }
      />

      {creating ? (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">名称</span>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：产品知识库"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">描述</span>
            <Input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="一句话说明知识库用途"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              库提示词（规范目录结构，指引 LLM 维护与检索）
            </span>
            <Textarea
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              placeholder={
                "如：按「产品/ FAQ / 操作指南」三个目录组织；每个文件聚焦一个主题，含来源与日期。"
              }
              rows={3}
            />
          </div>
          {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCreating(false);
                setFormError(null);
              }}
            >
              取消
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={submitting}>
              {submitting ? "创建中…" : "创建"}
            </Button>
          </div>
        </Card>
      ) : null}

      <Input
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="🔍 搜索知识库…"
        className="max-w-xs"
      />

      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Section
        title="我创建的"
        items={mine}
        onDuplicate={(l) => void handleDuplicate(l)}
        duplicatingId={duplicatingId}
        onDelete={(l) => setPendingDelete(l)}
        empty={kw ? "没有匹配的知识库" : "还没有知识库，点击右上角新建"}
      />
      <Section
        title="分享给我的"
        items={shared}
        empty={kw ? "没有匹配的知识库" : "暂无他人分享的知识库；通过分享链接授权后会出现在这里"}
      />
      <Section title="系统默认" items={builtins} empty="暂无系统默认知识库" />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除知识库「${pendingDelete?.name ?? ""}」？`}
        description="文件内容将被删除；修订账本保留供审计，分享链接与授权一并失效。"
        confirmText="删除"
        destructive
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

function Section({
  title,
  items,
  onDelete,
  empty,
  onDuplicate,
  duplicatingId,
}: {
  title: string;
  items: KbLibraryDTO[];
  onDelete?: (l: KbLibraryDTO) => void;
  empty?: string;
  onDuplicate?: (l: KbLibraryDTO) => void;
  duplicatingId?: string | null;
}) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{empty ?? "暂无"}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((l) => (
          <Card key={l.id} className="flex flex-col gap-2.5 p-4">
            <div className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-primary-soft text-xs font-bold text-primary">
                  {l.name.charAt(0)}
                </span>
                <Link
                  to={`/kb/${l.id}`}
                  className="truncate text-[13px] font-semibold hover:underline"
                >
                  {l.name}
                </Link>
              </span>
              {l.personal ? <Badge tone="info">个人</Badge> : null}
              {l.builtin ? <Badge tone="info">内置</Badge> : null}
              {!l.personal && !l.builtin ? (
                <Badge tone="success">{l._role === "manage" ? "可维护" : "只读"}</Badge>
              ) : null}
            </div>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
              {l.description || "—"}
            </p>
            <div className="mt-auto flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                更新于 {new Date(l.updatedAt).toLocaleDateString()}
              </span>
              <div className="flex items-center gap-1.5">
                {/* 对话入口 M2（builtin-kb-assistant）接入；维护走对话（D4），此处仅库级动作 */}
                {onDuplicate && l._role === "manage" ? (
                  <button
                    type="button"
                    onClick={() => onDuplicate(l)}
                    disabled={duplicatingId === l.id}
                    title="复制知识库（不含修订历史）"
                    className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {duplicatingId === l.id ? "复制中…" : "复制"}
                  </button>
                ) : null}
                {onDelete && l._role === "manage" && !l.personal && !l.builtin ? (
                  <button
                    type="button"
                    onClick={() => onDelete(l)}
                    title="删除知识库"
                    className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    删除
                  </button>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
