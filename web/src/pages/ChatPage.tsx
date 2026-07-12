import { ChatShell } from "../components/chat/ChatShell";
import { isDefaultConv } from "../lib/conversations";
import { useWebChat } from "../lib/webChat";

export function ChatPage() {
  const wc = useWebChat();
  const convs = wc.conversations.filter(isDefaultConv);
  return (
    <ChatShell
      conversations={convs}
      activeConversationId={wc.activeConversationId}
      onSelectConversation={wc.switchConversation}
      onDeleteConversation={wc.deleteConversation}
      onNewConversation={() => wc.newConversation()}
      sidebarTitle={`会话（${convs.length}）`}
      newLabel="新会话"
      messages={wc.messages}
      pendingApproval={wc.pendingApproval}
      connection={wc.connection}
      onSend={wc.send}
      onResolveApproval={wc.resolveApproval}
    />
  );
}
