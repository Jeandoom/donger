import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMemo, useState } from "react";
import { useAssistantRuntimeBridge } from "../../lib/assistantRuntimeBridge";
import type { FileInfo } from "../../lib/chatReducer";
import { DongerAttachmentAdapter } from "../../lib/dongerAttachmentAdapter";
import type {
  ChatErrors,
  ChatMessage,
  ConnectionState,
  ConversationSummary,
  PendingApproval,
  PendingCredential,
} from "../../types";
import { FileBrowserDrawer } from "../files/FileBrowserDrawer";
import { SecondarySidebar } from "../layout/SecondarySidebar";
import { AssistantThread } from "./AssistantThread";
import { MobileConversationSheet } from "./MobileConversationSheet";

export interface ChatWorkspaceProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
  sidebarTitle: string;
  sidebarHeaderExtra?: React.ReactNode;
  messages: ChatMessage[];
  loadingMessages: boolean;
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  connection: ConnectionState;
  onSend: (text: string, files?: FileInfo[]) => Promise<void>;
  onResolveApproval: (approved: boolean, reason?: string) => void;
  onSubmitCredential: (values: Record<string, string>) => void;
  inputPlaceholder?: string;
  errors: ChatErrors;
  onReloadConversations: () => void;
  onReloadMessages: () => void;
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const attachmentAdapter = useMemo(() => new DongerAttachmentAdapter(), []);
  const runtime = useAssistantRuntimeBridge({
    messages: props.messages,
    loading: props.loadingMessages,
    send: props.onSend,
    attachmentAdapter,
  });
  const sidebarItems = props.conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title || "(无标题)",
    meta: new Date(conversation.updatedAt).toLocaleDateString(),
  }));

  return (
    <div className="flex min-w-0 flex-1">
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
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs lg:px-4 lg:py-2">
          <div className="flex items-center gap-2">
            <MobileConversationSheet
              title={props.sidebarTitle}
              items={sidebarItems}
              selectedId={props.activeConversationId}
              onSelect={props.onSelectConversation}
              onDelete={props.onDeleteConversation}
              onNew={props.onNewConversation}
              headerExtra={props.sidebarHeaderExtra}
            />
            <span>
              {props.connection === "open"
                ? "● 已连接"
                : props.connection === "closed"
                  ? "● 未连接"
                  : "● 连接中"}
            </span>
          </div>
          <button type="button" onClick={() => setDrawerOpen(true)}>
            文件
          </button>
        </div>
        {props.errors.stream ? (
          <div role="status" className="bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
            {props.errors.stream}
          </div>
        ) : null}
        {props.errors.messages ? (
          <div
            role="alert"
            className="flex items-center justify-between bg-red-50 px-3 py-2 text-sm text-red-700"
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
            className="flex items-center justify-between bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <span>{props.errors.conversations}</span>
            <button type="button" onClick={props.onReloadConversations}>
              重新加载会话
            </button>
          </div>
        ) : null}
        <AssistantRuntimeProvider runtime={runtime}>
          <AssistantThread
            pendingApproval={props.pendingApproval}
            pendingCredential={props.pendingCredential}
            approvalError={props.errors.approval}
            credentialError={props.errors.credential}
            onResolveApproval={props.onResolveApproval}
            onSubmitCredential={props.onSubmitCredential}
            placeholder={props.inputPlaceholder ?? "输入消息…"}
          />
        </AssistantRuntimeProvider>
      </div>
      <FileBrowserDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeConversationId={props.activeConversationId}
      />
    </div>
  );
}
