import { ImagePlus, Loader2, MessagesSquare, Search, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import {
  CATEGORY_LABELS,
  type ConversationCandidate,
  createFeedback,
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  type FeedbackItem,
  fetchConversationCandidates,
  formatRelative,
  uploadFeedbackImage,
} from "../../lib/feedback";
import { Button } from "../ui/button";
import { DialogShell } from "../ui/dialog-shell";
import { Input } from "../ui/input";
import { Segmented } from "../ui/segmented";
import { Textarea } from "../ui/textarea";

/**
 * 新增反馈表单（类别 chips + 多行文本 + 截图上传 + 关联对话记录选择）。
 * 反馈页右区与对话模块头部弹窗共用：外壳（Card/弹窗）与标题由调用方提供；
 * initialConversation 供对话内反馈入口预填当前会话作为反馈证据（仍可移除/更换）。
 */
export function FeedbackForm({
  onCreated,
  initialConversation,
}: {
  onCreated: (fb: FeedbackItem) => void;
  initialConversation?: ConversationCandidate;
}) {
  const [category, setCategory] = useState<FeedbackCategory>("other");
  const [content, setContent] = useState("");
  const [images, setImages] = useState<Array<{ name: string; previewUrl: string }>>([]);
  const [conversation, setConversation] = useState<ConversationCandidate | null>(
    initialConversation ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 草稿 key：本次表单的上传落盘目录，提交时由服务端收编为反馈附件目录
  const draftKey = useRef<string>(crypto.randomUUID());

  const pickFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setError(null);
    const remain = 3 - images.length;
    if (remain <= 0) {
      setError("每条反馈最多 3 张图片");
      return;
    }
    setUploading(true);
    try {
      for (const file of files.slice(0, remain)) {
        const name = await uploadFeedbackImage(draftKey.current, file);
        setImages((cur) => [...cur, { name, previewUrl: URL.createObjectURL(file) }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeImage = (name: string) => {
    setImages((cur) => {
      const target = cur.find((i) => i.name === name);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return cur.filter((i) => i.name !== name);
    });
  };

  const submit = async () => {
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const fb = await createFeedback({
        category,
        content: content.trim(),
        images: images.map((i) => i.name),
        conversationIds: conversation ? [conversation.id] : undefined,
        key: images.length > 0 ? draftKey.current : undefined,
      });
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      draftKey.current = crypto.randomUUID();
      setContent("");
      setImages([]);
      setConversation(null);
      onCreated(fb);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">反馈类型</div>
        <Segmented
          name="反馈类型"
          value={category}
          onChange={setCategory}
          options={FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
        />
      </div>
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          反馈内容（必填，不超过 2000 字）
        </div>
        <Textarea
          rows={6}
          maxLength={2000}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="描述你遇到的问题或改进建议；涉及页面问题时建议附截图（请勿截图包含凭证/密码的页面）"
        />
      </div>
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          截图（可选，最多 3 张）
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {images.map((img) => (
            <div key={img.name} className="group relative">
              <img
                src={img.previewUrl}
                alt="反馈截图预览"
                className="h-20 w-20 rounded-lg border border-border object-cover"
              />
              <button
                type="button"
                aria-label="删除图片"
                onClick={() => removeImage(img.name)}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-white shadow"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {images.length < 3 && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
              <span className="text-[10px]">{uploading ? "上传中…" : "添加截图"}</span>
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => void pickFiles(e)}
          />
        </div>
      </div>
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          关联对话记录（可选，选一条你的会话作为反馈证据）
        </div>
        {conversation ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <MessagesSquare size={14} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-xs">{conversation.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatRelative(conversation.updatedAt)}
            </span>
            <button
              type="button"
              aria-label="移除关联会话"
              onClick={() => setConversation(null)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MessagesSquare size={14} />
            选择对话记录（默认展示最近 10 条，可搜索）
          </button>
        )}
      </div>
      {error && (
        <div className="mb-3 rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={!content.trim() || uploading || submitting} onClick={() => void submit()}>
          {submitting ? "提交中…" : "提交反馈"}
        </Button>
      </div>
      {pickerOpen && (
        <ConversationPickerDialog
          onClose={() => setPickerOpen(false)}
          onPick={(c) => {
            setConversation(c);
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}

/** 关联对话记录选择弹层：本人会话分页（10 条/页）+ 标题搜索（防抖重置页码），单选回填 */
function ConversationPickerDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (c: ConversationCandidate) => void;
}) {
  const PAGE_SIZE = 10;
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<ConversationCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 搜索防抖：输入停稳后重置回第 1 页再查
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    fetchConversationCandidates({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      q: debouncedQ || undefined,
    })
      .then((r) => {
        if (stale) return;
        setItems(r.items);
        setTotal(r.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [debouncedQ, page]);

  return (
    <DialogShell
      title="选择对话记录"
      subtitle="仅显示你创建的会话；作为反馈证据，agent 引用该反馈时会一并读取"
      onClose={onClose}
      ariaLabel="选择对话记录"
      className="max-w-xl"
      footer={
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            共 {total} 条{pages > 1 ? ` · 第 ${page + 1} / ${pages} 页` : ""}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            上一页
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= pages - 1 || loading}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          >
            下一页
          </Button>
        </div>
      }
    >
      <div className="relative mb-2">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="按标题搜索…"
          className="pl-8"
          aria-label="搜索会话标题"
        />
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载中…
        </div>
      ) : error ? (
        <div className="rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
          会话列表加载失败：{error}
        </div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          {debouncedQ ? "没有匹配的会话" : "暂无会话记录"}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border border-border">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted"
                onClick={() => onPick(c)}
              >
                <MessagesSquare size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatRelative(c.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </DialogShell>
  );
}
