import { ImagePlus, Loader2, Plus, X } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Segmented } from "../components/ui/segmented";
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
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<FeedbackReplyDTO[]>([]);
  const [repliesError, setRepliesError] = useState<string | null>(null);
  const [view, setView] = useState<"form" | "detail" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackItem | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const isAdmin = me?.role === "admin";

  const reloadList = useCallback(() => {
    setListLoading(true);
    setListError(null);
    void fetchFeedbackList()
      .then((items) => {
        setList(items);
        setListLoading(false);
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : String(err));
        setListLoading(false);
      });
  }, []);

  // 初始加载：当前用户（判 admin 视角）+ 反馈列表
  useEffect(() => {
    void fetchMe().then(setMe);
    reloadList();
  }, [reloadList]);

  // 展开记录时懒加载该反馈的回复时间线
  useEffect(() => {
    if (!expandedId) {
      setExpandedReplies([]);
      setRepliesError(null);
      return;
    }
    setRepliesError(null);
    void fetchFeedbackReplies(expandedId)
      .then(setExpandedReplies)
      .catch((err: unknown) => {
        setExpandedReplies([]);
        setRepliesError(err instanceof Error ? err.message : String(err));
      });
  }, [expandedId]);

  const openDetail = async (id: string) => {
    setView("detail");
    setDetailId(id);
    setDetailError(null);
    try {
      setDetail(await fetchFeedbackDetail(id));
    } catch (err) {
      setDetail(null);
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  };

  // 通知「详情」深链：/feedback?focus=<id> 直接展开该反馈的对话（处理后清参数防刷新重放）
  const [searchParams, setSearchParams] = useSearchParams();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时消费一次 focus 参数，openDetail 随渲染重建不可作依赖
  useEffect(() => {
    const focus = searchParams.get("focus");
    if (!focus) return;
    setExpandedId(focus);
    void openDetail(focus);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreated = async (fb: FeedbackItem) => {
    setView(null);
    reloadList();
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
            {listLoading && (
              <div className="space-y-2 px-1 py-1">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            )}
            {listError && (
              <div className="mx-1 my-2 flex flex-col gap-2 rounded-lg bg-destructive-soft px-3 py-2.5 text-xs text-destructive">
                <span>反馈列表加载失败：{listError}</span>
                <Button variant="secondary" size="sm" onClick={reloadList}>
                  重试
                </Button>
              </div>
            )}
            {!listLoading && !listError && list.length === 0 && (
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
                repliesError={expandedId === fb.id ? repliesError : null}
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
          ) : view === "detail" && detailError ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 rounded-xl bg-destructive-soft px-6 py-5 text-sm text-destructive">
                <span>反馈详情加载失败：{detailError}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => detailId && void openDetail(detailId)}
                >
                  重试
                </Button>
              </div>
            </div>
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
  repliesError,
  onToggle,
  onOpenReply,
}: {
  fb: FeedbackItem;
  showUser: boolean;
  expanded: boolean;
  replies: FeedbackReplyDTO[] | null;
  /** 回复时间线加载失败信息（null = 成功或加载中） */
  repliesError: string | null;
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
          {replies === null && !repliesError && (
            <div className="px-1 text-[11px] text-muted-foreground">加载中…</div>
          )}
          {repliesError && (
            <div className="rounded-lg bg-destructive-soft px-3 py-2 text-[11px] text-destructive">
              回复加载失败：{repliesError}
            </div>
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

/** 右区：反馈详情——对话形式（原始反馈+回复按角色分侧气泡；admin 顶部流转状态） */
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
  const [repliesError, setRepliesError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const isAdmin = me?.role === "admin";
  const isOwner = me?.id === fb.userId;
  const canReply = isAdmin || isOwner;

  useEffect(() => {
    setRepliesError(null);
    void fetchFeedbackReplies(fb.id)
      .then(setReplies)
      .catch((err: unknown) => {
        setReplies([]);
        setRepliesError(err instanceof Error ? err.message : String(err));
      });
  }, [fb.id]);

  // 切换反馈/新回复后滚到对话底部
  // biome-ignore lint/correctness/useExhaustiveDependencies: 以回复条数/反馈 id 为滚动信号，ref 为稳定哨兵
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [replies.length, fb.id]);

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

  // 对话时间线：原始反馈排首（提交人侧），回复按角色分侧（user 右 / admin 左），双方视角一致
  const thread: Array<{
    key: string;
    role: "user" | "admin";
    name: string;
    content: string;
    createdAt: string;
    images?: string[];
  }> = [
    {
      key: "root",
      role: "user",
      name: fb.userName ?? fb.userId,
      content: fb.content,
      createdAt: fb.createdAt,
      images: fb.images,
    },
    ...replies.map((r) => ({
      key: r.id,
      role: r.authorRole,
      name: r.authorName ?? r.userId,
      content: r.content,
      createdAt: r.createdAt,
    })),
  ];

  return (
    <Card className="flex h-full min-h-0 flex-col p-5">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Badge tone="primary">{CATEGORY_LABELS[fb.category]}</Badge>
        <Badge tone={STATUS_TONES[fb.status]}>{STATUS_LABELS[fb.status]}</Badge>
        {isAdmin && (
          <span className="text-xs text-muted-foreground">提交人：{fb.userName ?? fb.userId}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(fb.createdAt)}
        </span>
      </div>

      {isAdmin && (
        <div className="mt-3 flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">状态流转</span>
          <Select
            className="w-32"
            value={fb.status}
            onChange={(e) => void changeStatus(e.target.value as FeedbackStatus)}
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <span className="text-[11px] text-muted-foreground">状态标识双方均可见</span>
        </div>
      )}

      <div className="mt-3 flex min-h-40 flex-1 flex-col gap-3 overflow-y-auto rounded-lg bg-muted/40 p-3">
        {repliesError && (
          <div className="rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive">
            沟通记录加载失败：{repliesError}
          </div>
        )}
        {thread.map((m) => {
          const fromUser = m.role === "user";
          return (
            <div
              key={m.key}
              className={cn("flex flex-col", fromUser ? "items-end" : "items-start")}
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {m.role === "admin" && <Badge tone="success">官方回复</Badge>}
                <span>{m.name}</span>
                <span>{formatRelative(m.createdAt)}</span>
              </div>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words leading-6",
                  fromUser ? "bg-primary-soft" : "bg-success-soft",
                )}
              >
                {m.content}
              </div>
              {m.images && m.images.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {m.images.map((name) => (
                    <a
                      key={name}
                      href={feedbackImageUrl(fb.id, name)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={feedbackImageUrl(fb.id, name)}
                        alt="反馈截图"
                        className="h-20 w-20 rounded-lg border border-border object-cover transition-opacity hover:opacity-85"
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={threadEndRef} />
      </div>

      {canReply ? (
        <div className="mt-3 shrink-0">
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
      ) : (
        <div className="mt-3 shrink-0 text-xs text-muted-foreground">
          仅反馈提交人与管理员可参与对话
        </div>
      )}
    </Card>
  );
}
