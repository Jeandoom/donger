import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Check, Copy, Megaphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssistantRuntimeBridge } from "../../lib/assistantRuntimeBridge";
import { isBuiltinAgentId } from "../../lib/builtinAgents";
import type { FileInfo } from "../../lib/chatReducer";
import { DongerAttachmentAdapter } from "../../lib/dongerAttachmentAdapter";
import type { ConversationCandidate } from "../../lib/feedback";
import { type LlmSdkType, llmSdkLabel, llmSdkTone } from "../../lib/llmSdk";
import type { Mention } from "../../lib/mentions";
import { reconcileMentions } from "../../lib/mentions";
import type {
  AgentPermissionMode,
  ChatErrors,
  ChatMessage,
  ConnectionState,
  ConversationSummary,
  PendingApproval,
  PendingCredential,
  PendingQuestion,
} from "../../types";
import { FeedbackForm } from "../feedback/FeedbackForm";
import { FileBrowserDrawer } from "../files/FileBrowserDrawer";
import { DialogShell } from "../ui/dialog-shell";
import { Badge } from "../ui/badge";
import { ConfirmDialog } from "../ui/confirm-dialog";
import type { AgentConversationSidebarProps } from "./AgentConversationSidebar";
import { AgentConversationSidebar } from "./AgentConversationSidebar";
import { AssistantThread } from "./AssistantThread";
import { MobileConversationSheet } from "./MobileConversationSheet";

export interface ChatWorkspaceProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversationIsDraft?: boolean;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** 分组侧栏（对话模块统一智能体会话）：桌面固定栏 + 移动端浮层共用 */
  sidebar?: AgentConversationSidebarProps;
  messages: ChatMessage[];
  loadingMessages: boolean;
  isGenerating: boolean;
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  pendingQuestion: PendingQuestion | null;
  connection: ConnectionState;
  onSend: (text: string, files?: FileInfo[], mentions?: Mention[]) => Promise<void>;
  onEnsureConversation?: () => Promise<string | null>;
  onCancel: () => Promise<void>;
  onResolveApproval: (approved: boolean, reason?: string) => void;
  onDecideCredentialMissing: (decision: string) => void;
  onAnswerQuestion: (answers: Record<string, string>, response?: string) => void;
  inputPlaceholder?: string;
  /** 切换会话权限模式（undefined=不支持，隐藏切换器） */
  onPermissionModeChange?: (mode: AgentPermissionMode) => Promise<void>;
  /** 对话可选模型（M2）：空数组/undefined=不支持，隐藏选择器 */
  modelOptions?: { ref: string; label: string; sdkType?: LlmSdkType }[];
  modelRef?: string;
  onModelRefChange?: (ref: string) => void;
  /** 输入区上方插槽（assist 草稿横幅等） */
  aboveComposer?: React.ReactNode;
  /** 顶栏右侧扩展（「文件」按钮旁，技能问题上报入口等） */
  headerExtra?: React.ReactNode;
  errors: ChatErrors;
  onReloadConversations: () => void;
  onReloadMessages: () => void;
  blockingContent?: React.ReactNode;
}

/** 右侧文件抽屉状态：open 之外携带初始 tab 与焦点文件（消息里的「变更文件」链接直达定位） */
interface DrawerState {
  open: boolean;
  tab: "files" | "changes";
  focusPath: string | null;
}

const INITIAL_DRAWER: DrawerState = { open: false, tab: "files", focusPath: null };

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const [drawer, setDrawer] = useState<DrawerState>(INITIAL_DRAWER);
  const openFileChange = useCallback((path: string) => {
    setDrawer({ open: true, tab: "changes", focusPath: path });
  }, []);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  // 附件 add/send 失败在 assistant-ui 里是静默吞掉的（fire-and-forget），经 adapter onError 上抛到这里显性化
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  useEffect(() => {
    if (!attachmentError) return;
    const timer = setTimeout(() => setAttachmentError(null), 6000);
    return () => clearTimeout(timer);
  }, [attachmentError]);
  // 对话内反馈入口（spec 2026-10-01-chat-feedback-entry-design）：弹窗开关 + 提交成功提示（瞬态自清）
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!feedbackNotice) return;
    const timer = setTimeout(() => setFeedbackNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [feedbackNotice]);
  const [idCopied, setIdCopied] = useState(false);
  useEffect(() => {
    if (!idCopied) return;
    const timer = setTimeout(() => setIdCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [idCopied]);
  const activeConversation = props.conversations.find((c) => c.id === props.activeConversationId);
  const effectiveMode: AgentPermissionMode =
    activeConversation?.effectivePermissionMode ??
    activeConversation?.permissionMode ??
    "ask_before_change";
  // Agent SDK 标识：优先取当前选中模型的引擎（随下拉切换即时反映，下一条消息生效），
  // 未显式选过则退回会话上次运行的引擎；草稿/未运行过两者皆空 → 不显示
  const activeSdk =
    props.modelOptions?.find((o) => o.ref === props.modelRef)?.sdkType ??
    activeConversation?.llmSdkType;
  const attachmentAdapter = useMemo(
    () =>
      new DongerAttachmentAdapter(
        props.activeConversationId ?? undefined,
        props.onEnsureConversation,
        (message) => setAttachmentError(message),
      ),
    [props.activeConversationId, props.onEnsureConversation],
  );
  // 引用候选选中后先攒在 ref（文本标记为事实源），发送时对账后随消息上送
  const mentionsRef = useRef<Mention[]>([]);
  useEffect(() => {
    mentionsRef.current = [];
  }, []);
  const collectMention = useCallback((mention: Mention) => {
    mentionsRef.current = [
      ...mentionsRef.current.filter((m) => m.kind !== mention.kind || m.id !== mention.id),
      mention,
    ];
  }, []);
  const handleSend = useCallback(
    async (text: string, files?: FileInfo[]) => {
      await props.onSend(text, files, reconcileMentions(text, mentionsRef.current));
    },
    [props.onSend],
  );
  const copyConversationId = useCallback(() => {
    const id = props.activeConversationId;
    if (!id) return;
    void navigator.clipboard?.writeText(id).then(
      () => setIdCopied(true),
      () => undefined,
    );
  }, [props.activeConversationId]);
  const runtime = useAssistantRuntimeBridge({
    messages: props.messages,
    loading: props.loadingMessages,
    generating: props.isGenerating,
    send: handleSend,
    cancel: props.onCancel,
    attachmentAdapter,
  });
  const sidebarItems = props.conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title || "(无标题)",
  }));
  // 会话权限模式切换器：置于输入框底部、附件按钮左侧
  const permissionModePicker = props.onPermissionModeChange ? (
    <select
      aria-label="会话权限模式"
      title="会话权限模式"
      value={effectiveMode}
      onChange={(e) => {
        const mode = e.target.value as AgentPermissionMode;
        if (mode === "full_access" && effectiveMode !== "full_access") {
          setConfirmFullAccess(true);
        } else {
          void props.onPermissionModeChange?.(mode);
        }
      }}
      className={`h-9 min-w-0 max-w-[44vw] rounded-lg border px-2 text-xs font-medium ${
        effectiveMode === "full_access"
          ? "border-warning/50 bg-warning-soft text-warning-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-muted"
      }`}
    >
      <option value="ask_before_change">变更前问询</option>
      <option value="full_access">完全权限（高危）</option>
    </select>
  ) : null;

  // 会话模型选择器：置于权限模式旁（当前选中的 LLM 随下一条消息生效）
  const modelPicker =
    props.onModelRefChange && props.modelOptions && props.modelOptions.length > 0 ? (
      <select
        aria-label="对话模型"
        title="对话使用的 LLM（随下一条消息生效）"
        value={props.modelRef ?? ""}
        onChange={(e) => props.onModelRefChange?.(e.target.value)}
        className="h-9 min-w-0 max-w-[180px] rounded-lg border border-border bg-card px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
      >
        {props.modelOptions.map((option) => (
          <option key={option.ref} value={option.ref}>
            {option.label}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {props.sidebar ? (
        <AgentConversationSidebar className="hidden lg:flex" {...props.sidebar} />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2 lg:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <MobileConversationSheet sidebar={props.sidebar} />
            <span className="truncate text-sm font-semibold">
              {sidebarItems.find((i) => i.id === props.activeConversationId)?.title}
            </span>
            {activeSdk ? (
              <Badge tone={llmSdkTone(activeSdk)} title="当前使用的 Agent SDK">
                {llmSdkLabel(activeSdk)}
              </Badge>
            ) : null}
            {props.activeConversationIsDraft ? (
              <Badge tone="warning">
                <span
                  className="mr-1 inline-block size-1.5 rounded-full bg-warning"
                  aria-hidden="true"
                />
                未保存
              </Badge>
            ) : (
              <Badge
                tone={
                  props.connection === "open"
                    ? "success"
                    : props.connection === "closed"
                      ? "danger"
                      : "neutral"
                }
              >
                {props.connection === "open"
                  ? "已连接"
                  : props.connection === "closed"
                    ? "未连接"
                    : "连接中"}
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {props.headerExtra}
            {props.activeConversationId ? (
              <button
                type="button"
                aria-label={idCopied ? "会话 ID 已复制" : "复制会话 ID"}
                title="复制会话 ID（反馈时粘贴给管理员可快速定位会话）"
                onClick={copyConversationId}
                className="shrink-0 rounded-lg border border-border bg-card p-2 text-muted-foreground hover:bg-muted"
              >
                {idCopied ? <Check size={13} className="text-primary" /> : <Copy size={13} />}
              </button>
            ) : null}
            <button
              type="button"
              disabled={!props.activeConversationId || props.activeConversationIsDraft}
              title={
                props.activeConversationIsDraft
                  ? "发送首条消息后可对此会话提交反馈"
                  : "对此会话提交反馈（自动关联当前会话作为证据）"
              }
              onClick={() => setFeedbackOpen(true)}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Megaphone size={12} />
              反馈
            </button>
            <button
              type="button"
              onClick={() => setDrawer({ open: true, tab: "files", focusPath: null })}
              className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              文件
            </button>
          </div>
        </div>
        {feedbackOpen && activeConversation ? (
          <DialogShell
            title="提交反馈"
            subtitle="将自动关联当前会话，作为问题定位的证据；官方回复在「反馈」页可见"
            onClose={() => setFeedbackOpen(false)}
            ariaLabel="提交反馈"
            className="max-w-xl"
            footer={<span />}
          >
            <FeedbackForm
              initialConversation={{
                id: activeConversation.id,
                title: activeConversation.title || "(无标题)",
                updatedAt: activeConversation.updatedAt,
              }}
              onCreated={() => {
                setFeedbackOpen(false);
                setFeedbackNotice("反馈已提交，感谢！可在「反馈」页查看官方回复进展。");
              }}
            />
          </DialogShell>
        ) : null}
        <ConfirmDialog
          open={confirmFullAccess}
          title="切换到完全权限模式？"
          description="完全权限下，部署/发布/推送/Git 写入等高危操作将不再弹审批卡确认，直接执行（工具白名单与文件写入边界仍然生效）。定时/钩子等无人值守任务不受此开关影响，仍会逐项问询。"
          confirmText="切换为完全权限"
          destructive
          onConfirm={() => {
            setConfirmFullAccess(false);
            void props.onPermissionModeChange?.("full_access");
          }}
          onCancel={() => setConfirmFullAccess(false)}
        />
        {props.errors.stream ? (
          <div role="status" className="bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
            {props.errors.stream}
          </div>
        ) : null}
        {props.errors.messages ? (
          <div
            role="alert"
            className="flex items-center justify-between bg-destructive-soft px-3 py-2 text-sm text-destructive"
          >
            <span>{props.errors.messages}</span>
            <button type="button" onClick={props.onReloadMessages}>
              重新加载
            </button>
          </div>
        ) : null}
        {props.errors.conversations ? (
          <div
            role="alert"
            className="flex items-center justify-between bg-destructive-soft px-3 py-2 text-sm text-destructive"
          >
            <span>{props.errors.conversations}</span>
            <button type="button" onClick={props.onReloadConversations}>
              重新加载会话
            </button>
          </div>
        ) : null}
        {props.blockingContent ? (
          props.blockingContent
        ) : (
          <AssistantRuntimeProvider runtime={runtime}>
            <AssistantThread
              pendingApproval={props.pendingApproval}
              pendingCredential={props.pendingCredential}
              pendingQuestion={props.pendingQuestion}
              questionError={props.errors.question}
              onAnswerQuestion={props.onAnswerQuestion}
              approvalError={props.errors.approval}
              credentialError={props.errors.credential}
              onResolveApproval={props.onResolveApproval}
              onDecideCredentialMissing={props.onDecideCredentialMissing}
              placeholder={props.inputPlaceholder ?? "输入消息…"}
              agentId={
                activeConversation?.agentId && !isBuiltinAgentId(activeConversation.agentId)
                  ? activeConversation.agentId
                  : undefined
              }
              conversationId={activeConversation?.id}
              onMentionInserted={collectMention}
              onOpenFileChange={openFileChange}
              aboveComposer={
                <>
                  {props.aboveComposer}
                  {feedbackNotice ? (
                    <div
                      role="status"
                      className="mb-2 flex items-center justify-between rounded-xl border border-primary/30 bg-primary-soft px-3 py-2 text-sm text-primary-foreground"
                    >
                      <span className="min-w-0 break-all">{feedbackNotice}</span>
                      <button
                        type="button"
                        aria-label="关闭提示"
                        onClick={() => setFeedbackNotice(null)}
                        className="ml-2 shrink-0 text-xs underline"
                      >
                        关闭
                      </button>
                    </div>
                  ) : null}
                  {attachmentError ? (
                    <div
                      role="alert"
                      className="mb-2 flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive"
                    >
                      <span className="min-w-0 break-all">{attachmentError}</span>
                      <button
                        type="button"
                        aria-label="关闭提示"
                        onClick={() => setAttachmentError(null)}
                        className="ml-2 shrink-0 text-xs underline"
                      >
                        关闭
                      </button>
                    </div>
                  ) : null}
                </>
              }
              composerLeading={
                permissionModePicker || modelPicker ? (
                  /* min-w-0 允许整簇收缩，select 逐级让宽；shrink-0 会溢出压到发送按钮底下 */
                  <div className="flex min-w-0 items-center gap-1.5">
                    {permissionModePicker}
                    {modelPicker}
                  </div>
                ) : undefined
              }
            />
          </AssistantRuntimeProvider>
        )}
      </div>
      <FileBrowserDrawer
        open={drawer.open}
        onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        activeConversationId={props.activeConversationId}
        initialTab={drawer.tab}
        focusPath={drawer.focusPath}
      />
    </div>
  );
}
