import { ImagePlus, Loader2, Plus, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { type CurrentUser, fetchMe } from "../lib/auth";
import {
  addFeedbackReply,
  CATEGORY_LABELS,
  createFeedback,
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackItem,
  type FeedbackReplyDTO,
  type FeedbackStatus,
  feedbackImageUrl,
  fetchFeedbackDetail,
  fetchFeedbackList,
  fetchFeedbackReplies,
  formatRelative,
  STATUS_LABELS,
  STATUS_TONES,
  updateFeedbackStatus,
  uploadFeedbackImage,
} from "../lib/feedback";
import { cn } from "../lib/utils";

/**
 * 反馈模块唯一页面（spec 2026-09-20-feedback-module-design）：
 * 左列提交记录（admin 全量/本人），点击展开历史回复时间线，点回复条右区打开详情；
 * 右区切换 新增表单 / 反馈详情 两种形态。
 */
export function FeedbackPage() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [list, setList] = useState<FeedbackItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<FeedbackReplyDTO[]>([]);
  const [view, setView] = useState<"form" | "detail" | null>(null);
  const [detail, setDetail] = useState<FeedbackItem | null>(null);

  const isAdmin = me?.role === "admin";

  // 初始加载：当前用户（判 admin 视角）+ 反馈列表
  useEffect(() => {
    void fetchMe().then(setMe);
    void fetchFeedbackList()
      .then(setList)
      .catch(() => setList([]));
  }, []);

  // 展开记录时懒加载该反馈的回复时间线
  useEffect(() => {
    if (!expandedId) {
      setExpandedReplies([]);
      return;
    }
    void fetchFeedbackReplies(expandedId)
      .then(setExpandedReplies)
      .catch(() => setExpandedReplies([]));
  }, [expandedId]);

  const openDetail = async (id: string) => {
    setView("detail");
    try {
      setDetail(await fetchFeedbackDetail(id));
    } catch {
      setDetail(null);
    }
  };

  const handleCreated = async (fb: FeedbackItem) => {
    setView(null);
    try {
      setList(await fetchFeedbackList());
    } catch {
      // 保持旧列表
    }
    setExpandedId(fb.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className="px-7 pt-7"
        title="反馈"
        description="提交改进意见与问题截图，跟踪官方回复；管理员在此回应并梳理演进方向"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-7 pb-7 pt-5 lg:flex-row">
        {/* 左：提交记录列表 */}
        <Card className="flex w-full shrink-0 flex-col overflow-hidden lg:w-80">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-semibold text-muted-foreground">
              {isAdmin ? "全部反馈" : "我的反馈"}（{list.length}）
            </span>
            <Button size="sm" variant="ghost" onClick={() => setView("form")}>
              <Plus size={14} />
              新增反馈
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {list.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                暂无反馈记录，点击「新增反馈」提交第一条
              </div>
            )}
            {list.map((fb) => (
              <FeedbackListItem
                key={fb.id}
                fb={fb}
                showUser={isAdmin}
                expanded={expandedId === fb.id}
                replies={expandedId === fb.id ? expandedReplies : null}
                onToggle={() => setExpandedId(expandedId === fb.id ? null : fb.id)}
                onOpenReply={() => void openDetail(fb.id)}
              />
            ))}
          </div>
        </Card>

        {/* 右：新增表单 / 反馈详情 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {view === "form" ? (
            <FeedbackForm onCreated={(fb) => void handleCreated(fb)} />
          ) : view === "detail" && detail ? (
            <FeedbackDetailPanel
              fb={detail}
              me={me}
              onChanged={() => {
                void fetchFeedbackList()
                  .then(setList)
                  .catch(() => {});
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              点击左侧记录展开回复，或新增一条反馈
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 左列单条记录：点击展开该反馈的回复时间线（历史返回内容） */
function FeedbackListItem({
  fb,
  showUser,
  expanded,
  replies,
  onToggle,
  onOpenReply,
}: {
  fb: FeedbackItem;
  showUser: boolean;
  expanded: boolean;
  replies: FeedbackReplyDTO[] | null;
  onToggle: () => void;
  onOpenReply: () => void;
}) {
  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "block w-full rounded-lg px-3 py-2 text-left",
          expanded ? "bg-primary-soft" : "hover:bg-muted",
        )}
      >
        <div className="flex items-center gap-1.5">
          <Badge tone="primary">{CATEGORY_LABELS[fb.category]}</Badge>
          <Badge tone={STATUS_TONES[fb.status]}>{STATUS_LABELS[fb.status]}</Badge>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {formatRelative(fb.updatedAt)}
          </span>
        </div>
        <div className={cn("mt-1 truncate text-[13px] font-medium", expanded && "text-primary")}>
          {fb.content}
        </div>
        {showUser && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            提交人：{fb.userName ?? fb.userId}
          </div>
        )}
      </button>
      {expanded && (
        <div className="mt-1 mb-2 ml-3 space-y-1.5 border-l border-border pl-3">
          <div className="rounded-lg bg-muted px-3 py-2 text-xs whitespace-pre-wrap break-words text-foreground/90">
            {fb.content}
          </div>
          {replies === null && (
            <div className="px-1 text-[11px] text-muted-foreground">加载中…</div>
          )}
          {replies?.length === 0 && (
            <div className="px-1 text-[11px] text-muted-foreground">暂无回复</div>
          )}
          {replies?.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={onOpenReply}
              className="block w-full rounded-lg bg-card px-3 py-2 text-left ring-1 ring-border transition-colors hover:bg-muted"
              title="点击查看完整反馈"
            >
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Badge tone={r.authorRole === "admin" ? "success" : "neutral"}>
                  {r.authorRole === "admin" ? "官方回复" : "补充说明"}
                </Badge>
                {formatRelative(r.createdAt)}
              </div>
              <div className="mt-1 line-clamp-2 text-xs whitespace-pre-wrap break-words">
                {r.content}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 右区：新增反馈表单（类别 chips + 多行文本 + 截图上传） */
function FeedbackForm({ onCreated }: { onCreated: (fb: FeedbackItem) => void }) {
  const [category, setCategory] = useState<FeedbackCategory>("other");
  const [content, setContent] = useState("");
  const [images, setImages] = useState<Array<{ name: string; previewUrl: string }>>([]);
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
        key: images.length > 0 ? draftKey.current : undefined,
      });
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      draftKey.current = crypto.randomUUID();
      setContent("");
      setImages([]);
      onCreated(fb);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold">新增反馈</h2>
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">反馈类型</div>
        <div className="flex flex-wrap gap-2">
          {FEEDBACK_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs transition-colors",
                category === c
                  ? "border-primary bg-primary-soft font-medium text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
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
    </Card>
  );
}

/** 右区：反馈详情（原文 + 图片 + 完整时间线 + 回复/状态管理） */
function FeedbackDetailPanel({
  fb,
  me,
  onChanged,
}: {
  fb: FeedbackItem;
  me: CurrentUser | null;
  onChanged: () => void;
}) {
  const [replies, setReplies] = useState<FeedbackReplyDTO[]>([]);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = me?.role === "admin";
  const isOwner = me?.id === fb.userId;
  const canReply = isAdmin || isOwner;

  useEffect(() => {
    void fetchFeedbackReplies(fb.id)
      .then(setReplies)
      .catch(() => setReplies([]));
  }, [fb.id]);

  const sendReply = async () => {
    if (!replyText.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const reply = await addFeedbackReply(fb.id, replyText.trim());
      setReplies((cur) => [...cur, reply]);
      setReplyText("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "回复失败");
    } finally {
      setSending(false);
    }
  };

  const changeStatus = async (status: FeedbackStatus) => {
    setError(null);
    try {
      await updateFeedbackStatus(fb.id, status);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "状态更新失败");
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone="primary">{CATEGORY_LABELS[fb.category]}</Badge>
        <Badge tone={STATUS_TONES[fb.status]}>{STATUS_LABELS[fb.status]}</Badge>
        {isAdmin && (
          <span className="text-xs text-muted-foreground">提交人：{fb.userName ?? fb.userId}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(fb.createdAt)}
        </span>
      </div>
      <div className="mb-4 text-sm whitespace-pre-wrap break-words leading-6">{fb.content}</div>

      {fb.images.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {fb.images.map((name) => (
            <a key={name} href={feedbackImageUrl(fb.id, name)} target="_blank" rel="noreferrer">
              <img
                src={feedbackImageUrl(fb.id, name)}
                alt="反馈截图"
                className="h-28 w-28 rounded-lg border border-border object-cover transition-opacity hover:opacity-85"
              />
            </a>
          ))}
        </div>
      )}

      {isAdmin && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">状态流转</span>
          <Select
            className="w-36"
            value={fb.status}
            onChange={(e) => void changeStatus(e.target.value as FeedbackStatus)}
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="border-t border-border pt-4">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          沟通记录（{replies.length}）
        </div>
        <div className="space-y-2">
          {replies.length === 0 && <div className="text-xs text-muted-foreground">暂无回复</div>}
          {replies.map((r) => (
            <div
              key={r.id}
              className={cn(
                "rounded-lg px-3 py-2",
                r.authorRole === "admin" ? "bg-success-soft" : "bg-muted",
              )}
            >
              <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Badge tone={r.authorRole === "admin" ? "success" : "neutral"}>
                  {r.authorRole === "admin" ? "官方回复" : "补充说明"}
                </Badge>
                {formatRelative(r.createdAt)}
              </div>
              <div className="text-xs whitespace-pre-wrap break-words">{r.content}</div>
            </div>
          ))}
        </div>

        {canReply && (
          <div className="mt-3">
            <Textarea
              rows={3}
              maxLength={2000}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={isAdmin ? "回复该反馈…" : "补充说明…"}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                disabled={!replyText.trim() || sending}
                onClick={() => void sendReply()}
              >
                {sending ? "发送中…" : "发送"}
              </Button>
              {error && <span className="text-xs text-destructive">{error}</span>}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
