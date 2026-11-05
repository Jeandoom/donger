import {
  Archive,
  ArchiveRestore,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterConversations,
  formatRelativeTime,
  groupConversationsByTime,
  type SidebarPrefs,
  type SidebarView,
  toggleStarred,
} from "../../lib/agentSidebar";
import type { AgentListDTO } from "../../lib/agents";
import { cn } from "../../lib/utils";
import type { ConversationSummary } from "../../types";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useToast } from "../ui/toast";

export interface ConversationSidebarProps {
  agents: AgentListDTO[];
  /** 活跃会话（含本地草稿；updatedAt 倒序） */
  conversations: ConversationSummary[];
  /** 归档会话（视图数据；由页面层按需加载） */
  archivedConversations?: ConversationSummary[];
  activeConversationId: string | null;
  /** 星标智能体偏好（「星标」视图 + chips 数据源） */
  prefs: SidebarPrefs;
  onPrefsChange: (next: SidebarPrefs) => void;
  onSelectConversation: (id: string) => void;
  /** 归档（软删除）；撤销走 onUndoArchive */
  onDeleteConversation: (id: string) => void;
  /** 撤销归档（传快照；页面层 PATCH archived:false 并回列表） */
  onUndoArchive?: (conversation: ConversationSummary) => void;
  /** 归档视图的「恢复」 */
  onRestoreConversation?: (id: string) => void;
  /** 重命名（返回 false 表示失败，输入态保持） */
  onRenameConversation?: (id: string, title: string) => Promise<boolean> | boolean;
  /** 归档视图打开时按需拉取（页面层 loadArchivedConversations） */
  onOpenArchive?: () => void;
  /** 新建会话（指定 agent） */
  onNewConversation: (agentId: string) => void;
  /** 移动端 sheet 选中会话后回调关闭 */
  onItemSelected?: () => void;
  className?: string;
}

const COLLAPSED_KEY = "donger.sidebar.collapsed.v2";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 忽略
  }
}

/** agent 名彩色圆点（按 id 哈希到固定色相，无彩色依赖） */
function agentDotColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 65% 45%)`;
}

const VIEW_TABS: Array<{ key: SidebarView; label: string }> = [
  { key: "all", label: "全部" },
  { key: "starred", label: "星标" },
  { key: "archived", label: "归档" },
];

export function ConversationSidebar(props: ConversationSidebarProps) {
  const toast = useToast();
  const [view, setView] = useState<SidebarView>("all");
  const [keyword, setKeyword] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsed());
  const [pendingArchive, setPendingArchive] = useState<ConversationSummary | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // 行内重命名输入（挂载即聚焦替代 autoFocus，绕开 a11y lint 且行为一致）
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  // 切入归档视图时按需拉取一次（依赖只有 view 的跳变；onOpenArchive 身份每渲染都变，不能作为触发条件）
  const prevViewRef = useRef<SidebarView>("all");
  useEffect(() => {
    if (view === "archived" && prevViewRef.current !== "archived") props.onOpenArchive?.();
    prevViewRef.current = view;
  }, [view, props.onOpenArchive]);

  useEffect(() => {
    if (!agentPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setAgentPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [agentPickerOpen]);

  const agentName = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of props.agents) map.set(agent.id, agent.name);
    return map;
  }, [props.agents]);

  const isStarredAgent = (id: string) => props.prefs.starredAgentIds.includes(id);
  const drafts = props.conversations.filter((c) => c.isDraft);
  const source = view === "archived" ? (props.archivedConversations ?? []) : props.conversations;
  // 列表量级 ≤ 数百，直算不 memo（依赖里塞派生闭包会触发 exhaustive-deps 告警）
  const filtered = filterConversations(
    source,
    {
      view,
      starredAgentIds: props.prefs.starredAgentIds,
      agentId: agentFilter || undefined,
      keyword,
    },
    isStarredAgent,
  );
  const groups = useMemo(() => groupConversationsByTime(filtered), [filtered]);
  const archiveCounts = (props.archivedConversations ?? []).length;

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  };

  const startRename = (conversation: ConversationSummary) => {
    setRenamingId(conversation.id);
    setRenameDraft(conversation.title || "");
  };

  const commitRename = async (conversation: ConversationSummary) => {
    setRenamingId(null);
    const next = renameDraft.trim();
    if (!next || next === conversation.title) return;
    const ok = await props.onRenameConversation?.(conversation.id, next);
    if (ok === false) {
      toast.error("重命名失败");
    }
  };

  const confirmArchive = () => {
    const conversation = pendingArchive;
    setPendingArchive(null);
    if (!conversation) return;
    props.onDeleteConversation(conversation.id);
    // 归档可撤销（E1-C）：确认文案与后端软删语义一致，Undo 走快照恢复
    if (props.onUndoArchive) {
      toast.info("会话已移入归档，可在「归档」视图中恢复", "撤销", () =>
        props.onUndoArchive?.(conversation),
      );
    }
  };

  const selectAndClose = (id: string) => {
    props.onSelectConversation(id);
    props.onItemSelected?.();
  };

  const renderItem = (conversation: ConversationSummary, isDraft = false) => {
    const active = conversation.id === props.activeConversationId;
    const agent = conversation.agentId ? agentName.get(conversation.agentId) : undefined;
    const renaming = renamingId === conversation.id;
    const unread = conversation.unreadCount ?? 0;
    return (
      <div
        key={conversation.id}
        className="group flex min-w-0 items-center gap-1 rounded-lg pr-0.5 hover:bg-muted"
      >
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameDraft}
            aria-label="重命名会话"
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => void commitRename(conversation)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename(conversation);
              if (e.key === "Escape") {
                e.preventDefault();
                setRenamingId(null);
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-primary bg-card px-1.5 py-1 text-[13px] outline-none"
          />
        ) : (
          <button
            type="button"
            aria-label={`打开会话：${conversation.title || "无标题"}`}
            aria-current={active ? "true" : undefined}
            onClick={() => selectAndClose(conversation.id)}
            className={cn(
              "min-w-0 flex-1 rounded-lg px-1.5 py-1.5 text-left",
              active ? "bg-primary-soft" : "",
            )}
            title={
              conversation.lastMessagePreview
                ? `${conversation.title || "(无标题)"}\n${conversation.lastMessagePreview}`
                : conversation.title || "(无标题)"
            }
          >
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-[13px]",
                active ? "font-medium text-primary" : "text-foreground/90",
              )}
            >
              {isDraft || conversation.isDraft ? (
                <span
                  role="img"
                  aria-label="未保存"
                  className="inline-block size-1.5 shrink-0 rounded-full bg-warning"
                />
              ) : unread > 0 ? (
                <span
                  title={`${unread} 条未读`}
                  className="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground"
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null}
              <span className="truncate">{conversation.title || "(无标题)"}</span>
            </span>
            {conversation.lastMessagePreview ? (
              <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                {conversation.lastMessagePreview}
              </span>
            ) : null}
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {agent ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-block size-1.5 shrink-0 rounded-full"
                    style={{ background: agentDotColor(conversation.agentId) }}
                  />
                  <span className="truncate">{agent}</span>
                </span>
              ) : (
                <span className="shrink-0">系统会话</span>
              )}
              <span className="hover-time shrink-0">
                {formatRelativeTime(conversation.updatedAt)}
              </span>
            </span>
          </button>
        )}
        <div className="flex shrink-0 items-center">
          {view === "archived" ? (
            <button
              type="button"
              aria-label={`恢复会话：${conversation.title || "无标题"}`}
              title="恢复到会话列表"
              onClick={() => props.onRestoreConversation?.(conversation.id)}
              className="reveal-hover flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-success-soft hover:text-success"
            >
              <ArchiveRestore size={13} />
            </button>
          ) : (
            <button
              type="button"
              aria-label={`重命名会话：${conversation.title || "无标题"}`}
              title="重命名"
              onClick={() => startRename(conversation)}
              className="reveal-hover flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil size={12} />
            </button>
          )}
          <button
            type="button"
            aria-label={`归档会话：${conversation.title || "无标题"}`}
            title="移入归档（可在「归档」视图恢复）"
            onClick={() => setPendingArchive(conversation)}
            className="reveal-hover flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Archive size={12} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn(
        "flex w-64 shrink-0 flex-col border-r border-border bg-background",
        props.className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-xs font-semibold text-muted-foreground">会话</span>
        <div ref={pickerRef} className="relative">
          <button
            type="button"
            aria-label="新建会话"
            title="新建会话"
            onClick={() => setAgentPickerOpen((v) => !v)}
            className="inline-flex min-h-7 min-w-7 items-center justify-center rounded text-muted-foreground hover:bg-primary-soft hover:text-primary"
          >
            <MessageSquarePlus size={15} />
          </button>
          {agentPickerOpen ? (
            <div
              role="menu"
              aria-label="选择智能体"
              className="absolute top-full right-0 z-30 mt-1 max-h-64 w-52 overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-lg"
            >
              {props.agents.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                  还没有可用智能体；可在「智能体」页创建。
                </div>
              ) : (
                props.agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    role="menuitem"
                    title={agent.description || agent.name}
                    onClick={() => {
                      setAgentPickerOpen(false);
                      props.onNewConversation(agent.id);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ background: agentDotColor(agent.id) }}
                    />
                    <span className="min-w-0 truncate">{agent.name}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div className="px-2 pt-2">
        <div className="relative">
          <Search
            size={13}
            aria-hidden="true"
            className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setKeyword("");
            }}
            placeholder="搜索会话…"
            aria-label="搜索会话"
            className="w-full rounded-lg border border-border bg-card py-1.5 pr-7 pl-7 text-xs focus:border-primary focus:outline-none"
          />
          {keyword ? (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setKeyword("")}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex items-center gap-1">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              aria-pressed={view === tab.key}
              onClick={() => setView(tab.key)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                view === tab.key
                  ? "bg-primary-soft text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.key === "archived" && archiveCounts > 0 ? (
                <span className="ml-0.5 text-[10px] opacity-75">{archiveCounts}</span>
              ) : null}
            </button>
          ))}
        </div>
        {/* 星标 agent chips：点击=只看该智能体（再点取消）；含星形取消收藏 */}
        {props.prefs.starredAgentIds.length > 0 && view !== "archived" ? (
          <div className="no-scrollbar mt-1.5 flex items-center gap-1 overflow-x-auto pb-1">
            <button
              type="button"
              aria-pressed={agentFilter === ""}
              onClick={() => setAgentFilter("")}
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                agentFilter === ""
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              全部
            </button>
            {props.prefs.starredAgentIds.map((agentId) => (
              <span
                key={agentId}
                className={cn(
                  "flex shrink-0 items-center rounded-full border text-[11px]",
                  agentFilter === agentId
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                <button
                  type="button"
                  aria-pressed={agentFilter === agentId}
                  title={`只看「${agentName.get(agentId) ?? agentId}」`}
                  onClick={() => setAgentFilter(agentFilter === agentId ? "" : agentId)}
                  className="max-w-28 truncate py-0.5 pl-2"
                >
                  {agentName.get(agentId) ?? agentId}
                </button>
                <button
                  type="button"
                  aria-label={`取消收藏「${agentName.get(agentId) ?? agentId}」`}
                  title="取消收藏"
                  onClick={() => props.onPrefsChange(toggleStarred(props.prefs, agentId))}
                  className="py-0.5 pr-1.5 text-muted-foreground hover:text-warning-foreground"
                >
                  <Star size={10} fill="currentColor" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1.5">
        {view !== "archived" && drafts.length > 0 ? (
          <div className="mb-1.5">
            <div className="px-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              未保存
            </div>
            {drafts.map((c) => renderItem(c, true))}
          </div>
        ) : null}
        {view === "archived" && (props.archivedConversations ?? []).length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无归档会话</div>
        ) : null}
        {view !== "archived" && props.agents.length === 0 && props.conversations.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            还没有可用智能体；可在「智能体」页创建。
          </div>
        ) : null}
        {groups.map((group) => {
          const collapsed = !keyword && collapsedGroups.has(group.key);
          return (
            <div key={group.key} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggleGroupCollapsed(group.key)}
                aria-expanded={!collapsed}
                className="flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase hover:bg-muted"
              >
                {group.label}
                <span className="font-normal opacity-75">{group.items.length}</span>
                <Plus
                  size={10}
                  aria-hidden="true"
                  className={cn("ml-auto transition-transform", collapsed ? "" : "rotate-45")}
                />
              </button>
              {!collapsed ? (
                <div className="ml-1 border-l border-border/70 pl-1">
                  {group.items.map((c) => renderItem(c))}
                </div>
              ) : null}
            </div>
          );
        })}
        {view !== "archived" &&
        drafts.length === 0 &&
        groups.length === 0 &&
        (keyword || agentFilter || view === "starred") ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">没有匹配的会话</div>
        ) : null}
      </div>
      <ConfirmDialog
        open={pendingArchive !== null}
        title={`归档「${pendingArchive?.title || "无标题"}」？`}
        description="会话将从列表移除并进入「归档」视图，可随时恢复（不会真正删除）。"
        confirmText="移入归档"
        destructive
        onConfirm={confirmArchive}
        onCancel={() => setPendingArchive(null)}
      />
    </div>
  );
}
