import { MessagesSquare, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FeedbackForm } from "../components/feedback/FeedbackForm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { type CurrentUser, fetchMe } from "../lib/auth";
import {
  addFeedbackReply,
  CATEGORY_LABELS,
  deleteFeedback,
  FEEDBACK_STATUSES,
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
} from "../lib/feedback";
import { cn } from "../lib/utils";

/**
 * 反馈模块唯一页面（spec 2026-09-20-feedback-module-design）：
 * 左列提交记录（admin 全量/本人），点击记录右区打开详情（选中高亮）；
 * 右区切换 新增表单 / 反馈详情 两种形态；admin 可在详情内回复与删除。
 */
export function FeedbackPage() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [list, setList] = useState<FeedbackItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
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
    void openDetail(focus);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreated = async (fb: FeedbackItem) => {
    setView(null);
    reloadList();
    void openDetail(fb.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className="px-7 pt-7"
        title="反馈"
        description="提交改进意见与问题截图，跟踪官方回复；管理员在此回应并梳理演进方向"
      />
      {/* 窄屏容器放开滚动 + 左列限高（同审计页移动端模式）：否则左列表 shrink-0 吃满
          整屏高度，右区新增表单/详情对话被压成 0 高度裁死——手机上表现为点新增无反应 */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pb-7 pt-5 lg:flex-row lg:overflow-hidden">
        {/* 左：提交记录列表 */}
        <Card className="flex min-h-0 w-full shrink-0 max-h-80 flex-col overflow-hidden lg:w-80 lg:max-h-none">
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
                active={detailId === fb.id}
                onOpen={() => void openDetail(fb.id)}
              />
            ))}
          </div>
        </Card>

        {/* 右：新增表单 / 反馈详情 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {view === "form" ? (
            <Card className="p-5">
              <h2 className="mb-4 font-semibold">新增反馈</h2>
              <FeedbackForm onCreated={(fb) => void handleCreated(fb)} />
            </Card>
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
              onClose={() => {
                setView(null);
                setDetail(null);
                setDetailId(null);
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              点击左侧记录查看详情，或新增一条反馈
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 左列单条记录：点击在右区打开详情（当前查看项高亮） */
function FeedbackListItem({
  fb,
  showUser,
  active,
  onOpen,
}: {
  fb: FeedbackItem;
  showUser: boolean;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "mb-0.5 block w-full rounded-lg px-3 py-2 text-left",
        active ? "bg-primary-soft" : "hover:bg-muted",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge tone="primary">{CATEGORY_LABELS[fb.category]}</Badge>
        <Badge tone={STATUS_TONES[fb.status]}>{STATUS_LABELS[fb.status]}</Badge>
        {(fb.conversations?.length ?? 0) > 0 && (
          <span
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground"
            title="含关联对话记录"
          >
            <MessagesSquare size={11} />
            会话
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {formatRelative(fb.updatedAt)}
        </span>
      </div>
      <div className={cn("mt-1 truncate text-[13px] font-medium", active && "text-primary")}>
        {fb.content}
      </div>
      {showUser && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          提交人：{fb.userName ?? fb.userId}
        </div>
      )}
    </button>
  );
}

/** 右区：反馈详情——对话形式（原始反馈+回复按角色分侧气泡；admin 顶部流转状态与删除） */
function FeedbackDetailPanel({
  fb,
  me,
  onChanged,
  onClose,
}: {
  fb: FeedbackItem;
  me: CurrentUser | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [replies, setReplies] = useState<FeedbackReplyDTO[]>([]);
  const [repliesError, setRepliesError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const removeFeedback = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteFeedback(fb.id);
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  // 对话时间线：原始反馈排首（提交人侧），回复按角色分侧（user 右 / admin 左），双方视角一致
  const thread: Array<{
    key: string;
    role: "user" | "admin" | "system";
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
    <>
      <Card className="flex h-full min-h-0 flex-col p-5">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone="primary">{CATEGORY_LABELS[fb.category]}</Badge>
          <Badge tone={STATUS_TONES[fb.status]}>{STATUS_LABELS[fb.status]}</Badge>
          {isAdmin && (
            <span className="text-xs text-muted-foreground">
              提交人：{fb.userName ?? fb.userId}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {isAdmin && (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
                删除
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose} title="关闭详情">
              <X size={14} />
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">{formatRelative(fb.createdAt)}</span>
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

        {(fb.conversations?.length ?? 0) > 0 && (
          <div className="mt-3 shrink-0 space-y-1.5">
            {fb.conversations?.map((c) =>
              c.missing ? (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
                >
                  <MessagesSquare size={14} className="shrink-0" />
                  关联对话记录已删除
                </div>
              ) : (
                <a
                  key={c.id}
                  href={`/?conv=${c.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs transition-colors hover:bg-muted"
                >
                  <MessagesSquare size={14} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.updatedAt && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatRelative(c.updatedAt)}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-primary">查看会话 →</span>
                </a>
              ),
            )}
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
                  {m.role === "system" && <Badge tone="info">自动处理</Badge>}
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
      <ConfirmDialog
        open={confirmDelete}
        title="删除这条反馈？"
        description="删除后反馈、回复与截图一并移除，不可恢复。"
        confirmText="删除"
        destructive
        busy={deleting}
        error={error}
        onConfirm={() => void removeFeedback()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
