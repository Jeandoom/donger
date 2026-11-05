import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Check, Copy, GitFork, Megaphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssistantRuntimeBridge } from "../../lib/assistantRuntimeBridge";
import type { FileInfo } from "../../lib/chatReducer";
import { DongerAttachmentAdapter } from "../../lib/dongerAttachmentAdapter";
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
import { Badge } from "../ui/badge";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { DialogShell } from "../ui/dialog-shell";
import { useToast } from "../ui/toast";
import { AssistantThread } from "./AssistantThread";
import type { ConversationSidebarProps } from "./ConversationSidebar";
import { ConversationSidebar } from "./ConversationSidebar";
import { MobileConversationSheet } from "./MobileConversationSheet";
import { PopoverSelect } from "./PopoverSelect";
import { ShortcutHelp } from "./ShortcutHelp";

export interface ChatWorkspaceProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversationIsDraft?: boolean;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** 侧栏（扁平时间流，chat UE 优化轮）：桌面固定栏 + 移动端浮层共用 */
  sidebar?: ConversationSidebarProps;
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
  /** 助手显示名（chat UE 轮 E2-C：当前 agent 名） */
  assistantName?: string;
  /** 执行活动摘要行（chat UE 轮 E2-A） */
  activityLines?: string[];
  /** busy 排队深度（chat UE 轮 E3-C） */
  queueDepth?: number;
  /** 切换会话权限模式（undefined=不支持，隐藏切换器） */
  onPermissionModeChange?: (mode: AgentPermissionMode) => Promise<void>;
  /** 对话可选模型（M2）：空数组/undefined=不支持，隐藏选择器 */
  modelOptions?: { ref: string; label: string; sdkType?: LlmSdkType }[];
  modelRef?: string;
  onModelRefChange?: (ref: string) => void;
  /** 会话分叉（specs/2026-10-23-conversation-fork-design.md §8）：缺省=整会话；消息级入口传分叉点消息 id。
   *  undefined=不支持，隐藏顶栏按钮与消息级入口。消息级「编辑」（D2）= fork + composer 原文回填，由此派生 */
  onForkConversation?: (messageId?: string) => Promise<boolean>;
  /** 失败消息一键重发（chat UE 轮 E5-A） */
  onRetryMessage?: (messageId: string) => void;
  /** 手动重连（chat UE 轮 E5-E）：断流横幅上的立即补拉入口 */
  onManualReconnect?: () => void;
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

/** 血缘徽标源标题截断（徽标窄，全名在 title 提示里） */
function truncateTitle(title: string): string {
  return title.length > 14 ? `${title.slice(0, 14)}…` : title;
}

const PERMISSION_MODE_OPTIONS = [
  { value: "ask_before_change", label: "变更前问询" },
  { value: "risk_guard", label: "风险拦截" },
  { value: "full_access", label: "完全权限（高危）", hint: "零审批拦截，硬守卫仍生效" },
] as const;

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const toast = useToast();
  const [drawer, setDrawer] = useState<DrawerState>(INITIAL_DRAWER);
  const openFileChange = useCallback((path: string) => {
    setDrawer({ open: true, tab: "changes", focusPath: path });
  }, []);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  // 对话内反馈入口（spec 2026-10-01-chat-feedback-entry-design）
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [lineageOpen, setLineageOpen] = useState(false);
  // `?` 快捷键帮助表（E4-C 键盘契约）
  const [helpOpen, setHelpOpen] = useState(false);
  const lineageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!idCopied) return;
    const timer = setTimeout(() => setIdCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [idCopied]);
  useEffect(() => {
    if (!lineageOpen) return;
    const onDown = (e: MouseEvent) => {
      if (lineageRef.current && !lineageRef.current.contains(e.target as Node)) {
        setLineageOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [lineageOpen]);

  // Esc 分层（chat UE 轮 E4-C）：浮层/弹窗打开时不劫持（各自 Esc 负责关闭）；
  // 否则生成中 Esc = 停止输出。mention 候选浮层与自绘菜单均以 role="menu" 渲染。
  // 输入态守卫：/ 与 ？ 只在非输入焦点时生效（往输入框打 ? 是打字不是命令）。
  const isTypingTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    return Boolean(
      el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable),
    );
  };
  // 可见浮层判定：FileBrowserDrawer 关闭态常驻 DOM（role=dialog + aria-hidden=true），
  // 须排除隐藏 dialog，否则 / 与 ？ 快捷键及 Esc 停止生成永远不触发（e2e 实锤）
  const anyOverlayOpen = (): boolean =>
    Boolean(
      document.querySelector(
        '[role="menu"],[role="listbox"],[role="dialog"]:not([aria-hidden="true"])',
      ),
    );
  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (!props.isGenerating) return;
        if (anyOverlayOpen()) return;
        if (!isTypingTarget(e.target)) return;
        e.preventDefault();
        void props.onCancel();
        return;
      }
      if (e.key === "?" && !isTypingTarget(e.target) && !anyOverlayOpen()) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.key === "/" && !isTypingTarget(e.target) && !anyOverlayOpen()) {
        // 触屏不抢焦点（弹软键盘打扰），细指针才聚焦输入框
        if (window.matchMedia?.("(pointer: coarse)").matches) return;
        e.preventDefault();
        composerFocusRef.current?.();
      }
    },
    [props.isGenerating, props.onCancel],
  );
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  const activeConversation = props.conversations.find((c) => c.id === props.activeConversationId);
  const effectiveMode: AgentPermissionMode =
    activeConversation?.effectivePermissionMode ??
    activeConversation?.permissionMode ??
    "ask_before_change";
  // 分叉血缘链（E6-D 面包屑）：沿 forkedFrom 在已加载列表内回溯（列表含全部未归档会话）；
  // 链上祖先已归档/不可见时以缺失项收尾（点击态禁用，恢复后可跳转）
  const lineageChain = useMemo<Array<{ conv: ConversationSummary; missing: boolean }>>(() => {
    const chain: Array<{ conv: ConversationSummary; missing: boolean }> = [];
    let cursor = activeConversation?.forkedFrom;
    const seen = new Set<string>([props.activeConversationId ?? ""]);
    while (cursor) {
      if (seen.has(cursor.id)) break;
      const cursorId = cursor.id;
      const cursorTitle = cursor.title;
      const conv = props.conversations.find((c) => c.id === cursorId);
      if (!conv) {
        chain.push({
          conv: {
            id: cursorId,
            userId: "",
            sdkSessionId: "",
            title: cursorTitle,
            channelId: "",
            agentId: "",
            createdAt: "",
            updatedAt: "",
            archived: true,
          },
          missing: true,
        });
        break;
      }
      chain.push({ conv, missing: false });
      seen.add(conv.id);
      cursor = conv.forkedFrom;
    }
    return chain;
  }, [activeConversation?.forkedFrom, props.activeConversationId, props.conversations]);
  const forkSource = activeConversation?.forkedFrom;
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
        (message) => toast.error(message),
      ),
    [props.activeConversationId, props.onEnsureConversation, toast],
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
  // D2 编辑=fork 的 composer 预填桥：AssistantThread 注册 setText，fork 成功后回填原文
  const composerBridgeRef = useRef<((text: string) => void) | null>(null);
  // `/` 快捷键聚焦桥（AssistantThread 注册 textarea.focus）
  const composerFocusRef = useRef<(() => void) | null>(null);
  const handleEditFromMessage = useMemo(() => {
    if (!props.onForkConversation) return undefined;
    return (messageId: string, text: string) => {
      void props.onForkConversation?.(messageId).then((ok) => {
        if (ok) composerBridgeRef.current?.(text);
      });
    };
  }, [props.onForkConversation]);
  const runtime = useAssistantRuntimeBridge({
    messages: props.messages,
    loading: props.loadingMessages,
    generating: props.isGenerating,
    send: handleSend,
    cancel: props.onCancel,
    attachmentAdapter,
  });
  // 会话权限模式切换器（E4-A 自绘）：置于输入框底部、附件按钮左侧
  const permissionModePicker = props.onPermissionModeChange ? (
    <PopoverSelect
      ariaLabel="会话权限模式"
      title="会话权限模式"
      value={effectiveMode}
      options={[...PERMISSION_MODE_OPTIONS]}
      onChange={(mode) => {
        if (mode === "full_access" && effectiveMode !== "full_access") {
          setConfirmFullAccess(true);
        } else {
          void props.onPermissionModeChange?.(mode as AgentPermissionMode);
        }
      }}
      buttonClassName={cnPermissionButton(effectiveMode)}
    />
  ) : null;

  // 会话模型选择器（E4-A 自绘）：置于权限模式旁（当前选中的 LLM 随下一条消息生效）
  const modelPicker =
    props.onModelRefChange && props.modelOptions && props.modelOptions.length > 0 ? (
      <PopoverSelect
        ariaLabel="对话模型"
        title="对话使用的 LLM（随下一条消息生效）"
        value={props.modelRef ?? ""}
        options={props.modelOptions.map((option) => ({
          value: option.ref,
          label: option.label,
          ...(option.sdkType ? { hint: llmSdkLabel(option.sdkType) } : {}),
        }))}
        onChange={props.onModelRefChange}
        align="left"
      />
    ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {props.sidebar ? <ConversationSidebar className="hidden lg:flex" {...props.sidebar} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2 lg:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <MobileConversationSheet sidebar={props.sidebar} />
            <span className="truncate text-sm font-semibold">
              {props.conversations.find((c) => c.id === props.activeConversationId)?.title ||
                (props.activeConversationIsDraft ? "新会话" : "")}
            </span>
            {activeSdk ? (
              <Badge tone={llmSdkTone(activeSdk)} title="当前使用的 Agent SDK">
                {llmSdkLabel(activeSdk)}
              </Badge>
            ) : null}
            {forkSource ? (
              <div ref={lineageRef} className="relative shrink-0">
                <button
                  type="button"
                  aria-label="查看分叉血缘链"
                  aria-expanded={lineageOpen}
                  title="查看分叉血缘链（点击逐级跳转）"
                  onClick={() => setLineageOpen((v) => !v)}
                >
                  <Badge tone="neutral">
                    <GitFork size={11} className="mr-1" aria-hidden="true" />
                    分叉自 {truncateTitle(forkSource.title)}
                  </Badge>
                </button>
                {lineageOpen ? (
                  <div
                    role="menu"
                    aria-label="分叉血缘链"
                    className="absolute top-full left-0 z-30 mt-1 w-64 rounded-xl border border-border bg-card py-1 shadow-lg"
                  >
                    {[...lineageChain].reverse().map(({ conv, missing }, index, arr) => (
                      <button
                        key={conv.id}
                        type="button"
                        role="menuitem"
                        disabled={missing}
                        title={
                          missing
                            ? "源会话已归档，恢复后可跳转"
                            : `跳转到「${conv.title || "(无标题)"}」`
                        }
                        onClick={() => {
                          setLineageOpen(false);
                          props.onSelectConversation(conv.id);
                        }}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs disabled:pointer-events-none disabled:opacity-50 hover:bg-muted"
                      >
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {arr.length - index}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {conv.title || "(无标题)"}
                        </span>
                        <GitFork
                          size={11}
                          className="shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </button>
                    ))}
                    <div className="border-t border-border px-2.5 py-1 text-[10px] text-muted-foreground">
                      当前会话在此链末端
                    </div>
                  </div>
                ) : null}
              </div>
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
            {props.onForkConversation &&
            props.activeConversationId &&
            !props.activeConversationIsDraft ? (
              <button
                type="button"
                aria-label="创建分叉"
                title="以此会话当前全部消息创建分叉（新会话独立演进，原会话不受影响）"
                onClick={() => void props.onForkConversation?.()}
                className="shrink-0 rounded-lg border border-border bg-card p-2 text-muted-foreground hover:bg-muted"
              >
                <GitFork size={13} />
              </button>
            ) : null}
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
                toast.success("反馈已提交，可在「反馈」页查看官方回复进展");
              }}
            />
          </DialogShell>
        ) : null}
        <ConfirmDialog
          open={confirmFullAccess}
          title="切换到完全权限模式？"
          description="完全权限（零拦截）下，所有审批卡不再弹出：出网请求、命令解释器脚本、Git 写入/推送、部署发布等一律直接执行（工具白名单与文件边界等硬拦截仍生效并留审计）。若需保留风险形态审批，请改用「风险拦截」模式。定时/钩子等无人值守任务不受此开关影响，仍会逐项问询。"
          confirmText="切换为完全权限"
          destructive
          onConfirm={() => {
            setConfirmFullAccess(false);
            void props.onPermissionModeChange?.("full_access");
          }}
          onCancel={() => setConfirmFullAccess(false)}
        />
        {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}
        {props.errors.stream ? (
          <div
            role="status"
            className="flex items-center justify-between gap-2 bg-warning-soft px-3 py-2 text-sm text-warning-foreground"
          >
            <span className="min-w-0">{props.errors.stream}</span>
            {props.onManualReconnect ? (
              <button
                type="button"
                onClick={props.onManualReconnect}
                className="shrink-0 text-xs font-semibold underline underline-offset-2"
              >
                立即重连
              </button>
            ) : null}
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
              agentId={activeConversation?.agentId || undefined}
              assistantName={props.assistantName}
              conversationId={activeConversation?.id}
              onMentionInserted={collectMention}
              onOpenFileChange={openFileChange}
              onForkFromMessage={
                props.onForkConversation && !props.isGenerating
                  ? (messageId) => void props.onForkConversation?.(messageId)
                  : undefined
              }
              onEditFromMessage={
                handleEditFromMessage && !props.isGenerating ? handleEditFromMessage : undefined
              }
              onRetryMessage={props.onRetryMessage}
              activityLines={props.activityLines}
              queueDepth={props.queueDepth}
              isGenerating={props.isGenerating}
              composerBridge={composerBridgeRef}
              focusBridge={composerFocusRef}
              composerLeading={
                permissionModePicker || modelPicker ? (
                  /* min-w-0 允许整簇收缩，选择器逐级让宽；shrink-0 会溢出压到发送按钮底下 */
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

function cnPermissionButton(mode: AgentPermissionMode): string {
  return mode === "full_access" ? "border-warning/50 bg-warning-soft text-warning-foreground" : "";
}
