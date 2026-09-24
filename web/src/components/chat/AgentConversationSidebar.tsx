import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  formatRelativeTime,
  groupConversations,
  reorderIds,
  type SidebarPrefs,
  toggleStarred,
} from "../../lib/agentSidebar";
import type { AgentListDTO } from "../../lib/agents";
import { isBuiltinAgentId } from "../../lib/builtinAgents";
import { fetchKnowledgeBases, type KbLibraryDTO } from "../../lib/kb";
import { cn } from "../../lib/utils";
import type { ConversationSummary } from "../../types";
import { PlusIcon } from "../icons/PlusIcon";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Segmented } from "../ui/segmented";

export interface AgentConversationSidebarProps {
  /** 全量智能体（含内置合成条目；内置固定置底、不参与星标/拖拽） */
  agents: AgentListDTO[];
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  prefs: SidebarPrefs;
  /** 偏好变更（拖拽/星标）；持久化由页面层负责 */
  onPrefsChange: (next: SidebarPrefs) => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** 新建会话（分组头「+」=该 agent；由调用方决定如何落库） */
  onNewConversation: (agentId: string) => void;
  /** 新建/进入知识库会话（知识库模式分组「+」；agentId 恒为 builtin-kb-assistant） */
  onNewKbConversation: (kbId: string) => void;
  /** 移动端 sheet 选中会话后回调关闭 */
  onItemSelected?: () => void;
  className?: string;
}

const SHOW_COUNT = 5;
const COLLAPSED_KEY = "donger.sidebar.collapsed.v1";
const SIDEBAR_MODE_KEY = "donger.sidebar.mode.v1";
const SYSTEM_GROUP_ID = "__system__";

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

interface GroupView {
  agentId: string;
  name: string;
  title?: string;
  conversations: ConversationSummary[];
  starred: boolean;
}

interface GroupCallbacks {
  activeConversationId: string | null;
  collapsedIds: Set<string>;
  showAllIds: Set<string>;
  searching: boolean;
  onToggleCollapsed: (id: string) => void;
  onToggleShowAll: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onNew?: () => void;
  onToggleStar?: () => void;
  dragHandle?: React.ReactNode;
}

/** 星标/智能体/系统/assist 通用的分组渲染；dnd 由外层 SortableAgentGroup 包装 */
function AgentGroup(props: { view: GroupView; callbacks: GroupCallbacks }) {
  const { view, callbacks } = props;
  const hasConversations = view.conversations.length > 0;
  const collapsed = !callbacks.searching && callbacks.collapsedIds.has(view.agentId);
  const visible = callbacks.searching
    ? view.conversations
    : callbacks.showAllIds.has(view.agentId)
      ? view.conversations
      : view.conversations.slice(0, SHOW_COUNT);
  const hidden = view.conversations.length - visible.length;
  return (
    <div className="mb-0.5">
      <div className="group flex min-w-0 items-center rounded-lg hover:bg-muted">
        <button
          type="button"
          onClick={() => callbacks.onToggleCollapsed(view.agentId)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 py-2 text-left"
          aria-expanded={!collapsed}
        >
          {hasConversations ? (
            collapsed ? (
              <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
          )}
          <span className="truncate text-[13px] font-medium" title={view.title || view.name}>
            {view.name}
          </span>
          {hasConversations ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {view.conversations.length}
            </span>
          ) : null}
        </button>
        {/* 智能体右侧常显「+」：直接创建该 agent 的对话（全站唯一的新建会话入口） */}
        {callbacks.onNew ? (
          <button
            type="button"
            title={`在「${view.name}」下新建会话`}
            aria-label={`在「${view.name}」下新建会话`}
            onClick={callbacks.onNew}
            className="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary-soft hover:text-primary"
          >
            <PlusIcon size={14} />
          </button>
        ) : null}
        <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {callbacks.onToggleStar ? (
            <button
              type="button"
              title={view.starred ? "取消置顶（移回智能体区）" : "星标置顶固定区（收藏）"}
              aria-label={view.starred ? "取消置顶" : "星标置顶"}
              onClick={callbacks.onToggleStar}
              className="inline-flex min-h-7 min-w-7 items-center justify-center rounded text-muted-foreground hover:bg-warning-soft hover:text-warning-foreground"
            >
              <Star size={14} fill={view.starred ? "currentColor" : "none"} />
            </button>
          ) : null}
        </div>
        {callbacks.dragHandle}
      </div>
      {!collapsed && hasConversations ? (
        <div className="mb-1 ml-2 border-l border-border/70 pl-1">
          {visible.map((conversation) => (
            <div
              key={conversation.id}
              className="group flex min-w-0 items-center rounded-lg pr-0.5 hover:bg-muted"
            >
              <button
                type="button"
                aria-label={`打开会话：${conversation.title || "无标题"}`}
                onClick={() => callbacks.onSelect(conversation.id)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-lg px-1.5 py-1.5 text-left text-[13px]",
                  conversation.id === callbacks.activeConversationId
                    ? "bg-primary-soft font-medium text-primary"
                    : "text-foreground/90",
                )}
                title={conversation.title || "(无标题)"}
              >
                {conversation.isDraft ? (
                  <span
                    role="img"
                    aria-label="未保存"
                    className="mr-1 inline-block size-1.5 shrink-0 rounded-full bg-warning align-middle"
                  />
                ) : null}
                {conversation.title || "(无标题)"}
              </button>
              <span className="shrink-0 pr-1 text-[10px] text-muted-foreground group-hover:hidden">
                {formatRelativeTime(conversation.updatedAt)}
              </span>
              <button
                type="button"
                aria-label={`删除会话：${conversation.title || "无标题"}`}
                onClick={() => callbacks.onDelete(conversation)}
                className="hidden min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
              >
                ×
              </button>
            </div>
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => callbacks.onToggleShowAll(view.agentId)}
              className="px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Show more（{hidden}）
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** dnd-kit 排序包装：把拖拽手柄（listeners 挂把手图标）注入 AgentGroup */
function SortableAgentGroup({ view, callbacks }: { view: GroupView; callbacks: GroupCallbacks }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.agentId,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-10 opacity-60" : undefined}
    >
      <AgentGroup
        view={view}
        callbacks={{
          ...callbacks,
          dragHandle: (
            <button
              type="button"
              aria-label={`拖拽排序：${view.name}`}
              className="hidden cursor-grab touch-none pr-1 text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing lg:inline-flex"
              {...attributes}
              {...listeners}
            >
              <GripVertical size={13} />
            </button>
          ),
        }}
      />
    </div>
  );
}

export function AgentConversationSidebar(props: AgentConversationSidebarProps) {
  const [keyword, setKeyword] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => loadCollapsed());
  const [showAllIds, setShowAllIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  // 侧栏模式（spec §11）：智能体（默认）/ 知识库；持久化 localStorage
  const [mode, setMode] = useState<"agents" | "kb">(() =>
    localStorage.getItem(SIDEBAR_MODE_KEY) === "kb" ? "kb" : "agents",
  );
  const [kbLibs, setKbLibs] = useState<KbLibraryDTO[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    if (mode !== "kb" || kbLibs) return;
    fetchKnowledgeBases()
      .then(setKbLibs)
      .catch(() => setKbLibs([]));
  }, [mode, kbLibs]);

  const switchMode = (next: "agents" | "kb"): void => {
    setMode(next);
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, next);
    } catch {
      // 忽略
    }
  };

  const knownIds = useMemo(() => new Set(props.agents.map((a) => a.id)), [props.agents]);
  // 知识库会话（kbId 非空）不进智能体模式分组（spec §10.1：按 kbId 在知识库模式展示）
  const agentConversations = useMemo(
    () => props.conversations.filter((c) => !c.kbId),
    [props.conversations],
  );
  const { byAgent, orphans } = useMemo(
    () => groupConversations(agentConversations, knownIds),
    [agentConversations, knownIds],
  );
  const managedIds = useMemo(
    () => props.agents.filter((a) => !isBuiltinAgentId(a.id)).map((a) => a.id),
    [props.agents],
  );
  const kw = keyword.trim().toLowerCase();
  const searching = kw.length > 0;
  const match = (list: ConversationSummary[]) =>
    searching ? list.filter((c) => (c.title || "(无标题)").toLowerCase().includes(kw)) : list;

  const buildView = (agentId: string): GroupView | null => {
    const agent = props.agents.find((a) => a.id === agentId);
    if (!agent) return null;
    const conversations = match(byAgent.get(agentId) ?? []);
    if (searching && conversations.length === 0) return null;
    return {
      agentId,
      name: agent.name,
      title: agent.description,
      conversations,
      starred: props.prefs.starredAgentIds.includes(agentId),
    };
  };

  const starredViews = props.prefs.starredAgentIds
    .map(buildView)
    .filter((v): v is GroupView => v !== null);
  const normalViews = props.prefs.agentOrder
    .map(buildView)
    .filter((v): v is GroupView => v !== null);
  const builtinViews = props.agents
    .filter((a) => isBuiltinAgentId(a.id))
    .map((a) => buildView(a.id))
    .filter((v): v is GroupView => v !== null);
  const totalConversations = props.conversations.filter((c) => c.agentId).length;

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDragEnd = (zone: "starred" | "normal") => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const list = zone === "starred" ? props.prefs.starredAgentIds : props.prefs.agentOrder;
    const from = list.indexOf(String(active.id));
    const to = list.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = reorderIds(list, from, to);
    props.onPrefsChange(
      zone === "starred"
        ? { ...props.prefs, starredAgentIds: next }
        : { ...props.prefs, agentOrder: next },
    );
  };

  const groupCallbacks: GroupCallbacks = {
    activeConversationId: props.activeConversationId,
    collapsedIds,
    showAllIds,
    searching,
    onToggleCollapsed: (id) => {
      const next = new Set(collapsedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setCollapsedIds(next);
      saveCollapsed(next);
    },
    onToggleShowAll: (id) => toggleIn(setShowAllIds, id),
    onSelect: (id) => {
      props.onSelectConversation(id);
      props.onItemSelected?.();
    },
    onDelete: setPendingDelete,
  };

  const renderSortable = (view: GroupView) => (
    <SortableAgentGroup
      key={view.agentId}
      view={view}
      callbacks={{
        ...groupCallbacks,
        onNew: () => props.onNewConversation(view.agentId),
        onToggleStar: () => props.onPrefsChange(toggleStarred(props.prefs, view.agentId)),
      }}
    />
  );

  return (
    <div
      className={cn(
        "flex w-64 shrink-0 flex-col border-r border-border bg-background",
        props.className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-xs font-semibold text-muted-foreground">会话</span>
        <Segmented
          options={[
            { value: "agents", label: "智能体" },
            { value: "kb", label: "知识库" },
          ]}
          value={mode}
          onChange={switchMode}
        />
      </div>
      {mode === "kb" ? (
        <div className="flex-1 overflow-x-hidden overflow-y-auto p-1.5">
          {kbLibs === null ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">加载中…</div>
          ) : null}
          {(() => {
            const kbConvs = props.conversations.filter((c) => c.kbId);
            const mineOrShared = kbLibs?.filter((l) => !l.builtin) ?? [];
            const sorted = [...mineOrShared].sort((a, b) =>
              a.personal === b.personal ? 0 : a.personal ? -1 : 1,
            );
            const builtins = kbLibs?.filter((l) => l.builtin) ?? [];
            return (
              <>
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  知识库
                </div>
                {sorted.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    暂无知识库；可在「知识库」页创建
                  </div>
                ) : null}
                {sorted.map((kb) => {
                  const count = kbConvs.filter((c) => c.kbId === kb.id).length;
                  return (
                    <div
                      key={kb.id}
                      className="group mb-0.5 flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-2 hover:bg-muted"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => {
                          props.onNewKbConversation(kb.id);
                          props.onItemSelected?.();
                        }}
                        title="打开知识库会话"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {kb.name}
                        </span>
                        {kb.personal ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">个人</span>
                        ) : null}
                        {count > 0 ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {count}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        aria-label={`新建 ${kb.name} 会话`}
                        title="新建该知识库会话"
                        className="hidden rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground group-hover:inline-flex"
                        onClick={() => {
                          props.onNewKbConversation(kb.id);
                          props.onItemSelected?.();
                        }}
                      >
                        <PlusIcon size={14} />
                      </button>
                    </div>
                  );
                })}
                <div className="mt-2 border-t border-border pt-1.5">
                  <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    内置知识库
                  </div>
                  {builtins.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">暂无内置知识库</div>
                  ) : (
                    builtins.map((kb) => (
                      <button
                        key={kb.id}
                        type="button"
                        className="mb-0.5 flex w-full min-w-0 items-center rounded-lg px-1.5 py-2 text-left hover:bg-muted"
                        onClick={() => {
                          props.onNewKbConversation(kb.id);
                          props.onItemSelected?.();
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {kb.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">内置</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            );
          })()}
        </div>
      ) : (
        <>
          {totalConversations >= 8 ? (
            <div className="border-b border-border px-2 py-1.5">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索会话…"
                aria-label="搜索会话"
                className="w-full rounded-md border border-border bg-card px-2 py-1 text-xs focus:border-primary focus:outline-none"
              />
            </div>
          ) : null}
          <div className="flex-1 overflow-x-hidden overflow-y-auto p-1.5">
            {managedIds.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                还没有可用智能体；可先在「智能体」页创建，或使用下方 AI 生成助手。
              </div>
            ) : null}
            {starredViews.length > 0 ? (
              <div className="mb-2">
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  固定
                </div>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd("starred")}
                >
                  <SortableContext
                    items={starredViews.map((v) => v.agentId)}
                    strategy={verticalListSortingStrategy}
                  >
                    {starredViews.map(renderSortable)}
                  </SortableContext>
                </DndContext>
              </div>
            ) : null}
            {normalViews.length > 0 ? (
              <div>
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  智能体
                </div>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd("normal")}
                >
                  <SortableContext
                    items={normalViews.map((v) => v.agentId)}
                    strategy={verticalListSortingStrategy}
                  >
                    {normalViews.map(renderSortable)}
                  </SortableContext>
                </DndContext>
              </div>
            ) : null}
            {orphans.length > 0 ? (
              <div className="mt-2">
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  系统
                </div>
                <AgentGroup
                  view={{
                    agentId: SYSTEM_GROUP_ID,
                    name: "系统会话",
                    conversations: match(orphans),
                    starred: false,
                  }}
                  callbacks={{ ...groupCallbacks, onNew: undefined, onToggleStar: undefined }}
                />
              </div>
            ) : null}
            {builtinViews.length > 0 ? (
              <div className="mt-2 border-t border-border pt-1.5">
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  内置智能体
                </div>
                {builtinViews.map((view) => (
                  <AgentGroup
                    key={view.agentId}
                    view={view}
                    callbacks={{
                      ...groupCallbacks,
                      onNew: () => props.onNewConversation(view.agentId),
                      onToggleStar: undefined,
                    }}
                  />
                ))}
              </div>
            ) : null}
            {searching &&
            starredViews.length === 0 &&
            normalViews.length === 0 &&
            match(orphans).length === 0 &&
            builtinViews.every((v) => v.conversations.length === 0) ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">没有匹配的会话</div>
            ) : null}
          </div>
        </>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除「${pendingDelete?.title || "无标题"}」？`}
        description="删除后该会话将从列表移除，且无法恢复。"
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (pendingDelete) props.onDeleteConversation(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
