import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { EvictionNoticeDialog } from "../components/chat/EvictionNoticeDialog";
import { ASSIST_DRAFT_STORAGE_KEY, BUILTIN_ASSIST_AGENT_ID, noneAssistHint } from "../lib/assist";
import { isDefaultConv } from "../lib/conversations";
import { useWebChat } from "../lib/webChat";

export function ChatPage() {
  const navigate = useNavigate();
  const wc = useWebChat();
  const conversations = wc.conversations.filter(isDefaultConv);
  const hint = noneAssistHint(wc.messages);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EvictionNoticeDialog notice={wc.evictionNotice} onClose={wc.dismissEviction} />
      {hint ? (
        <div className="flex w-full shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
          <span>没有能处理该任务的智能体？让 AI 协助创建一个。</span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"
            onClick={() => {
              sessionStorage.setItem(ASSIST_DRAFT_STORAGE_KEY, hint);
              navigate(`/agent-sessions?agent=${BUILTIN_ASSIST_AGENT_ID}`);
            }}
          >
            <Sparkles aria-hidden="true" size={13} className="inline" />让 AI 协助创建
          </button>
        </div>
      ) : null}
      <ChatWorkspace
        conversations={conversations}
        activeConversationId={wc.activeConversationId}
        activeConversationIsDraft={
          // 未选中任何会话（初始空态）时输入内容同样属于未保存草稿
          wc.activeConversationId == null ||
          wc.conversations.find((item) => item.id === wc.activeConversationId)?.isDraft
        }
        onSelectConversation={wc.switchConversation}
        onDeleteConversation={wc.deleteConversation}
        onNewConversation={() => void wc.newConversation()}
        sidebarTitle={`会话（${conversations.length}）`}
        messages={wc.messages}
        loadingMessages={wc.loadingMessages}
        isGenerating={wc.isGenerating}
        pendingApproval={wc.pendingApproval}
        pendingCredential={wc.pendingCredential}
        pendingQuestion={wc.pendingQuestion}
        connection={wc.connection}
        onSend={wc.send}
        onEnsureConversation={wc.ensureConversation}
        onCancel={wc.cancel}
        onPermissionModeChange={wc.setPermissionMode}
        onResolveApproval={wc.resolveApproval}
        onDecideCredentialMissing={wc.decideCredentialMissing}
        onAnswerQuestion={wc.answerQuestion}
        errors={wc.errors}
        aboveComposer={
          wc.stage ? (
            <div
              role="status"
              className="mx-auto mb-1 flex w-full max-w-3xl items-center gap-2 px-3 text-xs text-muted-foreground sm:px-5"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              />
              {wc.stage}
            </div>
          ) : undefined
        }
        onReloadConversations={() => void wc.loadConversations()}
        onReloadMessages={() => wc.switchConversation(wc.activeConversationId)}
      />
    </div>
  );
}
