import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_useMentionAdapter,
  useAuiState,
} from "@assistant-ui/react";
import {
  AtSign,
  History,
  type LucideIcon,
  MessageSquareWarning,
  Paperclip,
  Plug,
  Plus,
  Slash,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_MESSAGE_ATTACHMENTS } from "../../lib/chatMessageAdapter";
import { STATUS_LABELS as FEEDBACK_STATUS_LABELS } from "../../lib/feedback";
import {
  EMPTY_MENTION_CANDIDATES,
  fetchMentionCandidates,
  type MentionCandidates,
} from "../../lib/mentionCandidates";
import {
  CONVERSATION_ALL_LABEL,
  CONVERSATION_MENTION_ALL_ID,
  conversationMarkerLabel,
  FEEDBACK_ALL_LABEL,
  FEEDBACK_MENTION_ALL_ID,
  fileMarkerLabel,
  type Mention,
  type MentionKind,
  tokenizeMentionMarkers,
} from "../../lib/mentions";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** 引用标记的插入格式：纯文本前缀 + 标记文本（文件取 basename，展示为短 chip） */
function markerFormatter(
  prefix: string,
  labelText: (item: Unstable_TriggerItem) => string = (item) => item.label,
): Unstable_DirectiveFormatter {
  return {
    serialize: (item) => `${prefix}${labelText(item)}`,
    // 纯文本输入框不做 chip 解析，恒等回传
    parse: (text) => [{ kind: "text", text }],
  };
}

/**
 * 引用标记背衬层（react-mentions 的 highlight-backdrop 模式）：
 * textarea 文字透明，本层渲染同字体/同换行的文本并把 @//​/$ 标记画成 pill 徽标。
 * 标记文本与真实文本一致（文件插入时即取短名），布局零漂移。
 */
export function MentionBackdrop(props: {
  text: string;
  backdropRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const tokens = tokenizeMentionMarkers(props.text);
  return (
    <div
      ref={props.backdropRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 text-sm leading-6 whitespace-pre-wrap break-words text-foreground"
    >
      {tokens.map((token, i) =>
        token.type === "mention" ? (
          <span
            key={`${token.kind}:${i}`}
            className="rounded bg-primary-soft px-0.5 -mx-0.5 text-primary ring-1 ring-primary/20 ring-inset"
          >
            {token.text}
          </span>
        ) : (
          <span key={i}>{token.text}</span>
        ),
      )}
    </div>
  );
}

/** 候选数据：挂载/agent 变更时拉取；+ 菜单打开时可手动 refresh（文件会随任务执行变化） */
export function useMentionCandidatesState(
  enabled: boolean,
  agentId?: string,
  currentConversationId?: string,
) {
  const [candidates, setCandidates] = useState<MentionCandidates>(EMPTY_MENTION_CANDIDATES);
  const [loading, setLoading] = useState(false);
  // 加载失败必须显式暴露——静默吞成空列表会把接口故障伪装成「无候选」（2026-09-17 生产事故教训）
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!enabled || !agentId) {
      setCandidates(EMPTY_MENTION_CANDIDATES);
      setError(null);
      return;
    }
    setLoading(true);
    fetchMentionCandidates(agentId, currentConversationId)
      .then((c) => {
        setCandidates(c);
        setError(null);
      })
      .catch((e: unknown) => {
        setCandidates(EMPTY_MENTION_CANDIDATES);
        setError(e instanceof Error ? e.message : "候选加载失败");
      })
      .finally(() => setLoading(false));
  }, [enabled, agentId, currentConversationId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { candidates, loading, error, refresh };
}

export interface ComposerPlusMenuProps {
  /** 会话是否绑定了可引用资源的智能体（内置协助智能体/闲聊会话只保留附件入口） */
  hasAgent: boolean;
  onInsertTrigger: (char: string) => void;
  onOpen: () => void;
}

/** 输入框左下角 ➕ 按钮：附件 / @资源 / /技能 / $连接器 */
export function ComposerPlusMenu(props: ComposerPlusMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const attachmentCount = useAuiState(({ composer }) => composer.attachments.length);
  const attachmentFull = attachmentCount >= MAX_MESSAGE_ATTACHMENTS;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const closeAndInsert = (char: string) => {
    setOpen(false);
    props.onInsertTrigger(char);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="添加内容"
        aria-expanded={open}
        className="min-h-11 min-w-11 rounded-full text-muted-foreground"
        onClick={() => {
          if (!open) props.onOpen();
          setOpen((v) => !v);
        }}
      >
        <Plus aria-hidden="true" size={18} />
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="添加内容菜单"
          className="absolute bottom-full left-0 z-20 mb-2 w-72 max-w-[calc(100vw-9rem)] overflow-hidden rounded-xl border bg-background p-1 shadow-lg"
        >
          <ComposerPrimitive.AddAttachment asChild>
            <button
              type="button"
              role="menuitem"
              disabled={attachmentFull}
              onClick={() => setOpen(false)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none",
                "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Paperclip aria-hidden="true" size={15} className="shrink-0 text-muted-foreground" />
              <span className="shrink-0">添加附件</span>
              <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                {attachmentFull ? `最多 ${MAX_MESSAGE_ATTACHMENTS} 个` : "任意文件 ≤20MB"}
              </span>
            </button>
          </ComposerPrimitive.AddAttachment>
          {props.hasAgent ? (
            <>
              <div className="my-1 border-t border-border/60" aria-hidden="true" />
              <PlusMenuItem
                icon={AtSign}
                trigger="@"
                label="引用资源文件"
                hint="智能体工作区中的文件"
                onClick={() => closeAndInsert("@")}
              />
              <PlusMenuItem
                icon={Slash}
                trigger="/"
                label="引用技能"
                hint="该智能体可用的技能"
                onClick={() => closeAndInsert("/")}
              />
              <PlusMenuItem
                icon={Plug}
                trigger="$"
                label="引用连接器"
                hint="该智能体挂载的连接器"
                onClick={() => closeAndInsert("$")}
              />
              <PlusMenuItem
                icon={History}
                trigger="%"
                label="引用历史会话"
                hint="该智能体开启的历史会话记录"
                onClick={() => closeAndInsert("%")}
              />
              <PlusMenuItem
                icon={MessageSquareWarning}
                trigger="#"
                label="引用反馈记录"
                hint="该智能体开启的反馈记录（含截图）"
                onClick={() => closeAndInsert("#")}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlusMenuItem(props: {
  icon: LucideIcon;
  trigger: string;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-muted"
    >
      <props.icon aria-hidden size={15} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          {props.label}
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {props.trigger}
          </kbd>
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{props.hint}</span>
      </span>
    </button>
  );
}

export interface ComposerMentionTriggersProps {
  candidates: MentionCandidates;
  loading: boolean;
  /** 候选接口加载失败信息（非空时浮层显式报错而非伪装成空列表） */
  error?: string | null;
  onMentionInserted: (mention: Mention) => void;
  /** 取 composer 的 textarea（插入后同步库内光标状态，驱动浮层关闭） */
  getTextarea: () => HTMLTextAreaElement | null;
}

/** @/​/$ 三个触发字符的候选浮层（须置于 ComposerPrimitive.Unstable_TriggerPopoverRoot 内） */
export function ComposerMentionTriggers(props: ComposerMentionTriggersProps) {
  // 插入标记后把 DOM 光标推到末尾并补发 input 事件：库的光标检测只在 textarea
  // onChange/onSelect 中同步内部光标，不补发则浮层停留在空 query 状态不关闭
  // （2026-09-17 e2e/用户实测：鼠标单击选中后浮层不自动关闭）。
  const syncCaretAfterInsert = useCallback(() => {
    const ta = props.getTextarea();
    if (!ta) return;
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, [props]);
  const fileItems = useMemo(
    () =>
      props.candidates.files.map(
        (f): Unstable_TriggerItem => ({ id: `${f.scope}:${f.path}`, type: "file", label: f.label }),
      ),
    [props.candidates.files],
  );
  const fileAdapter = unstable_useMentionAdapter({
    items: fileItems,
    // 标记只展示 basename（唯一性由 mentions[].id 的 scope:全路径承担）
    formatter: markerFormatter("@", (item) => fileMarkerLabel(item.label)),
    onInserted: (item) => {
      const label = fileMarkerLabel(item.label);
      props.onMentionInserted({ kind: "file", id: item.id, label });
      syncCaretAfterInsert();
    },
  });
  const skillAdapter = unstable_useMentionAdapter({
    items: useMemo(
      () =>
        props.candidates.skills.map(
          (s): Unstable_TriggerItem => ({
            id: s.id,
            type: "skill",
            label: s.name,
            description: s.description,
          }),
        ),
      [props.candidates.skills],
    ),
    formatter: markerFormatter("/"),
    onInserted: (item) => {
      props.onMentionInserted({ kind: "skill", id: item.id, label: item.label });
      syncCaretAfterInsert();
    },
  });
  const connectorAdapter = unstable_useMentionAdapter({
    items: useMemo(
      () =>
        props.candidates.connectors.map(
          (c): Unstable_TriggerItem => ({
            id: c.id,
            type: "connector",
            label: c.name,
            description: c.description,
          }),
        ),
      [props.candidates.connectors],
    ),
    formatter: markerFormatter("$"),
    onInserted: (item) =>
      props.onMentionInserted({ kind: "connector", id: item.id, label: item.label }),
  });
  const conversationAdapter = unstable_useMentionAdapter({
    items: useMemo(() => {
      const all: Unstable_TriggerItem = {
        id: CONVERSATION_MENTION_ALL_ID,
        type: "conversation",
        label: CONVERSATION_ALL_LABEL,
        description: "按智能体会话配置，引用全部符合条件的会话",
      };
      const list = props.candidates.conversations.map(
        (c): Unstable_TriggerItem => ({
          id: c.id,
          type: "conversation",
          // 插入的标记文本与展示 label 同源（去空白消毒）；标题另在描述行展示原文
          label: conversationMarkerLabel(c.title, c.updatedAt),
          description: `${c.title} · ${c.updatedAt.slice(0, 10)}`,
        }),
      );
      return [all, ...list];
    }, [props.candidates.conversations]),
    formatter: markerFormatter("%"),
    onInserted: (item) => {
      props.onMentionInserted({ kind: "conversation", id: item.id, label: item.label });
      syncCaretAfterInsert();
    },
  });
  const feedbackAdapter = unstable_useMentionAdapter({
    items: useMemo(() => {
      const all: Unstable_TriggerItem = {
        id: FEEDBACK_MENTION_ALL_ID,
        type: "feedback",
        label: FEEDBACK_ALL_LABEL,
        description: "按智能体反馈配置，引用全部符合条件的反馈",
      };
      const list = props.candidates.feedbacks.map(
        (f): Unstable_TriggerItem => ({
          id: f.id,
          type: "feedback",
          // label 由后端从正文派生（feedbackMarkerLabel）；原文前缀另在描述行展示
          label: f.label,
          description: `${FEEDBACK_STATUS_LABELS[f.status]} · ${f.preview}`,
        }),
      );
      return [all, ...list];
    }, [props.candidates.feedbacks]),
    formatter: markerFormatter("#"),
    onInserted: (item) => {
      props.onMentionInserted({ kind: "feedback", id: item.id, label: item.label });
      syncCaretAfterInsert();
    },
  });
  return (
    <>
      <MentionTrigger
        char="@"
        kind="file"
        adapter={fileAdapter.adapter}
        directive={fileAdapter.directive}
        isLoading={props.loading}
        error={props.error}
        emptyText="暂无可引用的文件"
        rowLabel="文件"
      />
      <MentionTrigger
        char="/"
        kind="skill"
        adapter={skillAdapter.adapter}
        directive={skillAdapter.directive}
        isLoading={props.loading}
        error={props.error}
        emptyText="该智能体暂无可用技能"
        rowLabel="技能"
      />
      <MentionTrigger
        char="$"
        kind="connector"
        adapter={connectorAdapter.adapter}
        directive={connectorAdapter.directive}
        isLoading={props.loading}
        error={props.error}
        emptyText="该智能体暂无可用连接器"
        rowLabel="连接器"
      />
      <MentionTrigger
        char="%"
        kind="conversation"
        adapter={conversationAdapter.adapter}
        directive={conversationAdapter.directive}
        isLoading={props.loading}
        error={props.error}
        emptyText={
          props.candidates.conversationRefEnabled
            ? "暂无可引用的历史会话"
            : "会话引用功能未开启，请在智能体编辑页的资源分区开启"
        }
        rowLabel="历史会话"
      />
      <MentionTrigger
        char="#"
        kind="feedback"
        adapter={feedbackAdapter.adapter}
        directive={feedbackAdapter.directive}
        isLoading={props.loading}
        error={props.error}
        emptyText={
          props.candidates.feedbackRefEnabled
            ? "暂无可引用的反馈记录"
            : "反馈引用功能未开启，请在智能体编辑页的资源分区开启"
        }
        rowLabel="反馈"
      />
    </>
  );
}

type MentionAdapterBundle = ReturnType<typeof unstable_useMentionAdapter>;

interface MentionTriggerProps {
  char: string;
  kind: MentionKind;
  adapter: MentionAdapterBundle["adapter"];
  directive: MentionAdapterBundle["directive"];
  isLoading: boolean;
  error?: string | null;
  emptyText: string;
  rowLabel: string;
}

function MentionTrigger(props: MentionTriggerProps) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char={props.char}
      adapter={props.adapter}
      isLoading={props.isLoading}
      aria-label={`引用${props.rowLabel}`}
      className="absolute bottom-full left-2 z-20 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border bg-background p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive {...props.directive} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="flex flex-col">
        {(items) =>
          items.length === 0 ? (
            <div
              className={cn(
                "px-3 py-2.5 text-xs",
                props.error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {props.error ? `候选加载失败：${props.error}` : props.emptyText}
            </div>
          ) : (
            items.map((item, index) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={index}
                className="flex items-start gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none data-[highlighted]:bg-muted"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground"
                >
                  {props.char}
                </span>
                <span className="min-w-0">
                  <span className="block break-all leading-5">{item.label}</span>
                  {item.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))
          )
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
