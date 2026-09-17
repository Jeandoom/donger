import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_ASSIST_AGENT_ID } from "../../lib/assist";
import { useAssistantRuntimeBridge } from "../../lib/assistantRuntimeBridge";
import type { FileInfo } from "../../lib/chatReducer";
import { DongerAttachmentAdapter } from "../../lib/dongerAttachmentAdapter";
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
import { FileBrowserDrawer } from "../files/FileBrowserDrawer";
import { SecondarySidebar } from "../layout/SecondarySidebar";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { AssistantThread } from "./AssistantThread";
import { MobileConversationSheet } from "./MobileConversationSheet";

export interface ChatWorkspaceProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversationIsDraft?: boolean;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
  sidebarTitle: string;
  sidebarHeaderExtra?: React.ReactNode;
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
  /** 输入区上方插槽（assist 草稿横幅等） */
  aboveComposer?: React.ReactNode;
  errors: ChatErrors;
  onReloadConversations: () => void;
  onReloadMessages: () => void;
  blockingContent?: React.ReactNode;
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const activeConversation = props.conversations.find((c) => c.id === props.activeConversationId);
  const effectiveMode: AgentPermissionMode =
    activeConversation?.effectivePermissionMode ??
    activeConversation?.permissionMode ??
    "ask_before_change";
  const attachmentAdapter = useMemo(
    () =>
      new DongerAttachmentAdapter(
        props.activeConversationId ?? undefined,
        props.onEnsureConversation,
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
    meta: new Date(conversation.updatedAt).toLocaleDateString(),
  }));

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SecondarySidebar
        className="hidden lg:flex"
        title={props.sidebarTitle}
        items={sidebarItems}
        selectedId={props.activeConversationId}
        onItemClick={props.onSelectConversation}
        onNew={props.onNewConversation}
        newLabel="新会话"
        onItemDelete={props.onDeleteConversation}
        headerExtra={props.sidebarHeaderExtra}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2 lg:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <MobileConversationSheet
              title={props.sidebarTitle}
              items={sidebarItems}
              selectedId={props.activeConversationId}
              onSelect={props.onSelectConversation}
              onDelete={props.onDeleteConversation}
              onNew={props.onNewConversation}
              headerExtra={props.sidebarHeaderExtra}
            />
            <span className="truncate text-sm font-semibold">
              {sidebarItems.find((i) => i.id === props.activeConversationId)?.title}
            </span>
            {props.activeConversationIsDraft ? (
              <span className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-amber-800">
                ● 未保存
              </span>
            ) : (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  props.connection === "open"
                    ? "bg-success-soft text-success"
                    : props.connection === "closed"
                      ? "bg-destructive-soft text-destructive"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {props.connection === "open"
                  ? "已连接"
                  : props.connection === "closed"
                    ? "未连接"
                    : "连接中"}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {props.onPermissionModeChange ? (
              <select
                aria-label="会话权限模式"
                value={effectiveMode}
                onChange={(e) => {
                  const mode = e.target.value as AgentPermissionMode;
                  if (mode === "full_access" && effectiveMode !== "full_access") {
                    setConfirmFullAccess(true);
                  } else {
                    void props.onPermissionModeChange?.(mode);
                  }
                }}
                className={`rounded-lg border px-2 py-1.5 text-xs font-medium ${
                  effectiveMode === "full_access"
                    ? "border-amber-300 bg-warning-soft text-amber-800"
                    : "border-border bg-card hover:bg-muted"
                }`}
              >
                <option value="ask_before_change">🛡️ 变更前问询</option>
                <option value="full_access">⚡ 完全权限</option>
              </select>
            ) : null}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              文件
            </button>
          </div>
        </div>
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
          <div role="status" className="bg-warning-soft px-3 py-2 text-sm text-amber-800">
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
                activeConversation?.agentId &&
                activeConversation.agentId !== BUILTIN_ASSIST_AGENT_ID
                  ? activeConversation.agentId
                  : undefined
              }
              onMentionInserted={collectMention}
              aboveComposer={props.aboveComposer}
            />
          </AssistantRuntimeProvider>
        )}
      </div>
      <FileBrowserDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeConversationId={props.activeConversationId}
      />
    </div>
  );
}
