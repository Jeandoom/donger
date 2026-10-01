import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AssistDraftBanner } from "../components/chat/AssistDraftBanner";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { EvictionNoticeDialog } from "../components/chat/EvictionNoticeDialog";
import { GitAccessBlocker } from "../components/chat/GitAccessBlocker";
import { SkillIssueReportDialog } from "../components/chat/SkillIssueReportDialog";
import { emptyPrefs, normalizeSidebarPrefs, type SidebarPrefs } from "../lib/agentSidebar";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { ASSIST_DRAFT_STORAGE_KEY, BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";
import { apiFetch, fetchMe } from "../lib/auth";
import {
  BUILTIN_AGENT_ENTRIES,
  BUILTIN_SELF_IMPROVER_AGENT_ID,
  isBuiltinAgentId,
} from "../lib/builtinAgents";
import { fetchGitPreflight, type GitPreflightDTO } from "../lib/gitSettings";
import { useWebChat } from "../lib/webChat";

/** 内置协助智能体的合成侧栏条目见 lib/builtinAgents.ts（BUILTIN_AGENT_ENTRIES） */

const PREFS_STORAGE_KEY = "donger.sidebarPrefs.v1";
const PREFS_SAVE_DEBOUNCE_MS = 500;

interface MeUser {
  starredAgentIds?: string[];
  agentOrder?: string[];
}

/** 本地缓存兜底（远端失败/未登录时可用；键结构不符直接弃用） */
function readLocalPrefs(): SidebarPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    if (!Array.isArray(parsed.starredAgentIds) || !Array.isArray(parsed.agentOrder)) return null;
    return { starredAgentIds: parsed.starredAgentIds, agentOrder: parsed.agentOrder };
  } catch {
    return null;
  }
}

export function ChatPage() {
  const wc = useWebChat();
  const [params] = useSearchParams();
  const deepLinkAgent = params.get("agent");

  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [prefs, setPrefs] = useState<SidebarPrefs>(emptyPrefs);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const bootstrappedRef = useRef(false);

  const [gitPreflight, setGitPreflight] = useState<GitPreflightDTO>({
    ready: false,
    requirements: [],
  });
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [assistDraft, setAssistDraft] = useState("");
  const [reportIssueOpen, setReportIssueOpen] = useState(false);

  // 载入智能体列表（内置条目置顶；平台进化官仅管理员可见）
  useEffect(() => {
    const visibleBuiltins = (admin: boolean) =>
      BUILTIN_AGENT_ENTRIES.filter((e) => admin || e.id !== BUILTIN_SELF_IMPROVER_AGENT_ID);
    Promise.all([fetchAgents(), fetchMe()])
      .then(([list, me]) => setAgents([...visibleBuiltins(me?.role === "admin"), ...list]))
      .catch(() => setAgents(visibleBuiltins(false)))
      .finally(() => setAgentsLoaded(true));
  }, []);

  // 载入侧栏偏好：本地缓存先上屏，远端（users 表）回填覆盖；接口失败退化为本地态
  useEffect(() => {
    let cancelled = false;
    const cached = readLocalPrefs();
    if (cached) setPrefs(cached);
    apiFetch("/api/auth/me")
      .then(async (response) =>
        response.ok ? ((await response.json()) as { user?: MeUser }) : null,
      )
      .then((data) => {
        if (cancelled || !data?.user) return;
        setPrefs({
          starredAgentIds: data.user.starredAgentIds ?? [],
          agentOrder: data.user.agentOrder ?? [],
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const managedIds = useMemo(
    () => agents.filter((a) => !isBuiltinAgentId(a.id)).map((a) => a.id),
    [agents],
  );
  // 剔除已删除智能体 + 新增智能体补位；渲染与持久化统一用规范化后的值
  const normalizedPrefs = useMemo(
    () => normalizeSidebarPrefs(managedIds, prefs),
    [managedIds, prefs],
  );

  const changePrefs = useCallback((next: SidebarPrefs) => {
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 忽略
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      apiFetch("/api/users/me/sidebar-prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
    }, PREFS_SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const activeConversation = wc.conversations.find(
    (conversation) => conversation.id === wc.activeConversationId,
  );
  const activeIsDraft = activeConversation?.isDraft;
  const activeAgent = agents.find((a) => a.id === activeConversation?.agentId);

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

  useEffect(() => {
    if (wc.activeConversationId) void checkGitAccess();
  }, [wc.activeConversationId, checkGitAccess]);

  // 兜底入口带入的草稿：深链进入 assist 会话时读一次（读后即删）
  useEffect(() => {
    if (deepLinkAgent !== BUILTIN_ASSIST_AGENT_ID) return;
    const draft = sessionStorage.getItem(ASSIST_DRAFT_STORAGE_KEY);
    if (draft) {
      setAssistDraft(draft);
      sessionStorage.removeItem(ASSIST_DRAFT_STORAGE_KEY);
    }
  }, [deepLinkAgent]);

  // 初始定位（仅一次）：?agent= 深链优先（继续该 agent 最近会话，没有才新建草稿）；
  // 无深链则打开最近一条智能体会话（「默认对话agent」概念已移除，新建一律走分组头「+」）。
  // 列表/智能体/偏好三者就绪后才执行。
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (!agentsLoaded || !prefsLoaded || wc.loadingConversations) return;
    bootstrappedRef.current = true;
    const deepLinkValid = deepLinkAgent !== null && agents.some((a) => a.id === deepLinkAgent);
    if (deepLinkValid && deepLinkAgent) {
      const latestOfAgent = wc.conversations.find(
        (conversation) => conversation.agentId === deepLinkAgent,
      );
      if (latestOfAgent) {
        wc.switchConversation(latestOfAgent.id);
        return;
      }
      const agent = agents.find((a) => a.id === deepLinkAgent);
      void wc.newConversation(deepLinkAgent, agent?.defaultPermissionMode);
      return;
    }
    // 列表按 updatedAt DESC 返回；跳过旧版 task-flow 会话（agentId 为空）与草稿
    const latest = wc.conversations.find((conversation) => conversation.agentId);
    if (latest) wc.switchConversation(latest.id);
  }, [
    agents,
    agentsLoaded,
    deepLinkAgent,
    prefsLoaded,
    wc.conversations,
    wc.loadingConversations,
    wc.newConversation,
    wc.switchConversation,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EvictionNoticeDialog notice={wc.evictionNotice} onClose={wc.dismissEviction} />
      {reportIssueOpen && activeAgent && activeConversation?.agentId ? (
        <SkillIssueReportDialog
          agentId={activeConversation.agentId}
          agentName={activeAgent.name}
          onClose={() => setReportIssueOpen(false)}
        />
      ) : null}
      <ChatWorkspace
        conversations={wc.conversations}
        activeConversationId={wc.activeConversationId}
        activeConversationIsDraft={
          // 未选中任何会话（初始空态）时输入内容同样属于未保存草稿
          wc.activeConversationId == null || activeIsDraft
        }
        onSelectConversation={wc.switchConversation}
        onDeleteConversation={wc.deleteConversation}
        sidebar={{
          agents,
          conversations: wc.conversations,
          activeConversationId: wc.activeConversationId,
          prefs: normalizedPrefs,
          onPrefsChange: changePrefs,
          onSelectConversation: wc.switchConversation,
          onDeleteConversation: wc.deleteConversation,
          onNewConversation: (agentId) => {
            const agent = agents.find((a) => a.id === agentId);
            void wc.newConversation(agentId, agent?.defaultPermissionMode);
          },
          onNewKbConversation: (kbId) => {
            void wc.newConversation("builtin-kb-assistant", undefined, kbId);
          },
        }}
        messages={wc.messages}
        loadingMessages={wc.loadingMessages}
        isGenerating={wc.isGenerating}
        pendingApproval={wc.pendingApproval}
        pendingCredential={wc.pendingCredential}
        pendingQuestion={wc.pendingQuestion}
        connection={wc.connection}
        onCancel={wc.cancel}
        onEnsureConversation={wc.ensureConversation}
        onPermissionModeChange={wc.setPermissionMode}
        modelOptions={wc.llmOptions.options}
        modelRef={wc.modelRef}
        onModelRefChange={wc.setModelRef}
        onResolveApproval={wc.resolveApproval}
        onDecideCredentialMissing={wc.decideCredentialMissing}
        onAnswerQuestion={wc.answerQuestion}
        inputPlaceholder={activeAgent ? `向 ${activeAgent.name} 发消息…` : "输入消息…"}
        headerExtra={
          activeAgent &&
          activeConversation?.agentId &&
          !isBuiltinAgentId(activeConversation.agentId) ? (
            <button
              type="button"
              onClick={() => setReportIssueOpen(true)}
              title="技能未就绪或行为异常时，向智能体分享者反馈"
              className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              技能问题
            </button>
          ) : undefined
        }
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
        onSend={async (text, files, mentions) => {
          const access = await checkGitAccess();
          if (access?.ready) await wc.send(text, files, mentions);
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
            />
          ) : undefined
        }
      />
    </div>
  );
}
