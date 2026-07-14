import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { isAgentConv } from "../lib/conversations";
import { useWebChat } from "../lib/webChat";

export function AgentSessionsPage() {
  const wc = useWebChat();
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [agentId, setAgentId] = useState("");
  const [params] = useSearchParams();
  const deepLinkAgent = params.get("agent");
  const agent = agents.find((item) => item.id === agentId);

  // 载入智能体列表
  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch(() => {});
  }, []);

  // 初始选中：深链 ?agent= 优先，否则第一个
  useEffect(() => {
    if (agentId) return;
    const first = agents[0];
    if (!first) return;
    setAgentId(deepLinkAgent ?? first.id);
  }, [agentId, agents, deepLinkAgent]);

  // 自稳定：当前活跃会话不属于选中智能体 → 继续该智能体最近一条；
  //         深链且该智能体无会话 → 新建一条。
  useEffect(() => {
    if (!agentId) return;
    const mine = wc.conversations.filter((conversation) => isAgentConv(conversation, agentId));
    const activeIsMine =
      !!wc.activeConversationId &&
      mine.some((conversation) => conversation.id === wc.activeConversationId);
    if (activeIsMine) return;
    const latest = mine[0];
    if (latest) {
      wc.switchConversation(latest.id);
    } else if (deepLinkAgent === agentId) {
      void wc.newConversation(agentId);
    }
  }, [
    agentId,
    wc.conversations,
    wc.activeConversationId,
    deepLinkAgent,
    wc.switchConversation,
    wc.newConversation,
  ]);

  const conversations = agentId
    ? wc.conversations.filter((conversation) => isAgentConv(conversation, agentId))
    : [];

  return (
    <ChatWorkspace
      conversations={conversations}
      activeConversationId={wc.activeConversationId}
      onSelectConversation={wc.switchConversation}
      onDeleteConversation={wc.deleteConversation}
      onNewConversation={() => {
        if (agentId) void wc.newConversation(agentId);
      }}
      sidebarTitle={agent ? `智能体：${agent.name}` : "智能体会话"}
      sidebarHeaderExtra={
        <select
          className="w-full rounded border bg-background px-2 py-1 text-xs"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {agents.length === 0 ? <option value="">（暂无可用智能体）</option> : null}
          {agents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      }
      messages={wc.messages}
      loadingMessages={wc.loadingMessages}
      pendingApproval={wc.pendingApproval}
      pendingCredential={wc.pendingCredential}
      connection={wc.connection}
      onSend={wc.send}
      onResolveApproval={wc.resolveApproval}
      onSubmitCredential={wc.submitCredential}
      inputPlaceholder={agent ? `向 ${agent.name} 发消息…` : "输入消息…"}
    />
  );
}
