import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { isDefaultConv } from "../lib/conversations";
import { useWebChat } from "../lib/webChat";

export function ChatPage() {
  const wc = useWebChat();
  const conversations = wc.conversations.filter(isDefaultConv);
  return (
    <ChatWorkspace
      conversations={conversations}
      activeConversationId={wc.activeConversationId}
      onSelectConversation={wc.switchConversation}
      onDeleteConversation={wc.deleteConversation}
      onNewConversation={() => void wc.newConversation()}
      sidebarTitle={`会话（${conversations.length}）`}
      messages={wc.messages}
      loadingMessages={wc.loadingMessages}
      pendingApproval={wc.pendingApproval}
      pendingCredential={wc.pendingCredential}
      connection={wc.connection}
      onSend={wc.send}
      onResolveApproval={wc.resolveApproval}
      onSubmitCredential={wc.submitCredential}
      errors={wc.errors}
      onReloadConversations={() => void wc.loadConversations()}
      onReloadMessages={() => wc.switchConversation(wc.activeConversationId)}
    />
  );
}
