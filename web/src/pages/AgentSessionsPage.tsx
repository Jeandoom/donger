import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AssistDraftBanner } from "../components/chat/AssistDraftBanner";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { GitAccessBlocker } from "../components/chat/GitAccessBlocker";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { ASSIST_DRAFT_STORAGE_KEY, BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";
import { isAgentConv } from "../lib/conversations";
import { fetchGitPreflight, type GitPreflightDTO, grantGitRepositories } from "../lib/gitSettings";
import { useWebChat } from "../lib/webChat";

/** 内置协助智能体的合成下拉条目（不入库，前端常量） */
const BUILTIN_ASSIST_ENTRY: AgentListDTO = {
  id: BUILTIN_ASSIST_AGENT_ID,
  ownerId: "",
  _mine: true,
  name: "AI 生成助手",
  description: "对话式创建 agent / skill",
  skills: [],
  tools: { mode: "whitelist", whitelist: [] },
  mcpServers: [],
  llm: {},
  createdAt: "",
  updatedAt: "",
};

export function AgentSessionsPage() {
  const wc = useWebChat();
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [agentId, setAgentId] = useState("");
  const [params] = useSearchParams();
  const [gitPreflight, setGitPreflight] = useState<GitPreflightDTO>({
    ready: false,
    requirements: [],
  });
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [assistDraft, setAssistDraft] = useState("");
  const deepLinkAgent = params.get("agent");
  const agent = agents.find((item) => item.id === agentId);
  const activeIsDraft = wc.conversations.find(
    (conversation) => conversation.id === wc.activeConversationId,
  )?.isDraft;

  const checkGitAccess = useCallback(async (): Promise<GitPreflightDTO | undefined> => {
    if (!wc.activeConversationId || activeIsDraft) {
      return activeIsDraft ? { ready: true, requirements: [] } : undefined;
    }
    setGitLoading(true);
    setGitError("");
    try {
      const result = await fetchGitPreflight(wc.activeConversationId);
      setGitPreflight(result);
      return result;
    } catch (reason) {
      setGitError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setGitLoading(false);
    }
  }, [activeIsDraft, wc.activeConversationId]);

  // 载入智能体列表（内置 assist 条目置顶）
  useEffect(() => {
    fetchAgents()
      .then((list) => setAgents([BUILTIN_ASSIST_ENTRY, ...list]))
      .catch(() => {});
  }, []);

  // 兜底入口（B）带入的草稿：深链进入 assist 会话时读一次（读后即删）
  useEffect(() => {
    if (deepLinkAgent !== BUILTIN_ASSIST_AGENT_ID) return;
    const draft = sessionStorage.getItem(ASSIST_DRAFT_STORAGE_KEY);
    if (draft) {
      setAssistDraft(draft);
      sessionStorage.removeItem(ASSIST_DRAFT_STORAGE_KEY);
    }
  }, [deepLinkAgent]);

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

  useEffect(() => {
    if (wc.activeConversationId) void checkGitAccess();
  }, [wc.activeConversationId, checkGitAccess]);

  const conversations = agentId
    ? wc.conversations.filter((conversation) => isAgentConv(conversation, agentId))
    : [];

  return (
    <ChatWorkspace
      conversations={conversations}
      activeConversationId={wc.activeConversationId}
      activeConversationIsDraft={activeIsDraft}
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
      isGenerating={wc.isGenerating}
      pendingApproval={wc.pendingApproval}
      pendingCredential={wc.pendingCredential}
      connection={wc.connection}
      onCancel={wc.cancel}
      onEnsureConversation={wc.ensureConversation}
      onResolveApproval={wc.resolveApproval}
      onSubmitCredential={wc.submitCredential}
      inputPlaceholder={agent ? `向 ${agent.name} 发消息…` : "输入消息…"}
      aboveComposer={
        assistDraft ? (
          <AssistDraftBanner
            draft={assistDraft}
            onSend={(text) => {
              setAssistDraft("");
              void wc.send(text);
            }}
            onDismiss={() => setAssistDraft("")}
          />
        ) : undefined
      }
      errors={wc.errors}
      onReloadConversations={() => void wc.loadConversations()}
      onReloadMessages={() => wc.switchConversation(wc.activeConversationId)}
      onSend={async (text, files) => {
        const access = await checkGitAccess();
        if (access?.ready) await wc.send(text, files);
      }}
      blockingContent={
        wc.activeConversationId &&
        !activeIsDraft &&
        (gitLoading || !gitPreflight.ready || gitError) ? (
          <GitAccessBlocker
            loading={gitLoading}
            requirements={gitPreflight.requirements}
            error={gitError || undefined}
            onRetry={() => void checkGitAccess()}
            onGrant={(repositoryIds) => {
              setGitLoading(true);
              setGitError("");
              void grantGitRepositories(wc.activeConversationId ?? "", repositoryIds)
                .then(setGitPreflight)
                .catch((reason: unknown) =>
                  setGitError(reason instanceof Error ? reason.message : String(reason)),
                )
                .finally(() => setGitLoading(false));
            }}
          />
        ) : undefined
      }
    />
  );
}
