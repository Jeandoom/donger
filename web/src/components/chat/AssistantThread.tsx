import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  GitFork,
  Loader2,
  Pencil,
  Quote,
  RotateCcw,
  Square,
  UserRound,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import remarkGfm from "remark-gfm";
import { type AttachmentKind, attachmentKindForName, uploadUrl } from "../../lib/attachments";
import { fetchMe } from "../../lib/auth";
import type { FileInfo } from "../../lib/chatReducer";
import { extractChangedFilePaths, shortChangePath } from "../../lib/fileChanges";
import { lineRefBadge } from "../../lib/lineRefBadge";
import type { Mention } from "../../lib/mentions";
import { tokenizeMentionMarkers } from "../../lib/mentions";
import { collapseToolNarration } from "../../lib/toolNarration";
import { cn } from "../../lib/utils";
import type {
  MessageDelivery,
  PendingApproval,
  PendingCredential,
  PendingQuestion,
  TurnUsage,
} from "../../types";
import { Button } from "../ui/button";
import { ActivityStrip } from "./ActivityStrip";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";
import {
  ComposerMentionTriggers,
  ComposerPlusMenu,
  MentionBackdrop,
  useMentionCandidatesState,
} from "./ComposerMentions";
import { JumpToBottom } from "./JumpToBottom";
import { MarkdownCodeHeader, MarkdownSyntaxHighlighter } from "./MarkdownCodeBlock";
import { PendingInteraction } from "./PendingInteraction";
import { QuestionCard } from "./QuestionCard";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCard } from "./ToolCard";
import { TurnMetaBadge } from "./TurnMetaBadge";

const THREAD_CONTENT_WIDTH = "mx-auto w-full max-w-3xl px-3 sm:px-5";

/** 助手消息「变更文件」链接 → 打开右侧文件抽屉的变更 tab（ChatWorkspace 提供） */
const OpenFileChangeContext = createContext<(path: string) => void>(() => {});

/** 消息级「从此分叉」（specs/2026-10-23-conversation-fork-design.md §8.1）：ChatWorkspace 提供 */
const ForkMessageContext = createContext<((messageId: string) => void) | null>(null);

/** 消息级「编辑」（chat UE 轮 D2：编辑=从该条分叉新会话 + 原文回填 composer）：AssistantThread 内部提供 */
const EditMessageContext = createContext<((messageId: string, text: string) => void) | null>(null);

/** 「引用回填」：把消息文本引回 composer（chat UE 轮 E4-B） */
const QuoteContext = createContext<((text: string) => void) | null>(null);

/** 失败消息一键重发（chat UE 轮 E5-A） */
const RetryContext = createContext<((messageId: string) => void) | null>(null);

/** 助手名（chat UE 轮 E2-C：随当前 agent 变化，替换旧硬编码 "donger"） */
const AssistantNameContext = createContext<string>("助手");

/** 自定义元数据读取（chatMessageAdapter metadata.custom 透传面） */
function useCustom<T>(): (T & { delivery?: MessageDelivery; files?: FileInfo[] }) | undefined {
  return useAuiState(({ message }) => {
    const metadata = message.metadata as { custom?: T & Record<string, unknown> } | undefined;
    return metadata?.custom as (T & { delivery?: MessageDelivery; files?: FileInfo[] }) | undefined;
  });
}

/** hover/触屏常显的操作钮行（E6-B reveal-hover 规范） */
const MESSAGE_ACTION_CLASS =
  "flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/** 消息操作面：复制 / 引用回填 / 分叉（用户消息另含编辑=fork，D2） */
function MessageActions({
  text,
  messageId,
  isUser,
}: {
  text: string;
  messageId?: string;
  isUser: boolean;
}) {
  const onFork = useContext(ForkMessageContext);
  const onEdit = useContext(EditMessageContext);
  const quote = useContext(QuoteContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  }, [text]);
  return (
    <span className="reveal-hover inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-label={copied ? "已复制" : "复制全文"}
        title={copied ? "已复制" : "复制全文"}
        onClick={copy}
        className={MESSAGE_ACTION_CLASS}
      >
        {copied ? (
          <Check size={12} className="text-primary" aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
      </button>
      {quote && text.trim() ? (
        <button
          type="button"
          aria-label="引用到输入框"
          title="引用到输入框"
          onClick={() => quote(text)}
          className={MESSAGE_ACTION_CLASS}
        >
          <Quote size={12} aria-hidden="true" />
        </button>
      ) : null}
      {isUser && onEdit && messageId ? (
        <button
          type="button"
          aria-label="编辑（从此条分叉）"
          title="编辑重问：从此条创建分叉会话，原文回填输入框可修改后发送"
          onClick={() => onEdit(messageId, text)}
          className={MESSAGE_ACTION_CLASS}
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      ) : null}
      {/* 助手回合的 messageId 由 ForkIcon 自身从 metadata.custom 读（回合末条消息 id），故不在此判 messageId */}
      {onFork ? <ForkIcon /> : null}
    </span>
  );
}

/** 消息级「从此分叉」（D5 单档「含此条」） */
function ForkIcon() {
  const onFork = useContext(ForkMessageContext);
  const messageId = useAuiState(({ message }) => {
    if (message.role === "user") return message.id || undefined;
    const custom = message.metadata as { custom?: { forkPointMessageId?: string } } | undefined;
    return custom?.custom?.forkPointMessageId;
  });
  if (!onFork || !messageId) return null;
  return (
    <button
      type="button"
      aria-label="从此分叉"
      title="从此处创建分叉（复制起始到本条的全部内容到新会话，原会话不受影响）"
      onClick={() => onFork(messageId)}
      className={MESSAGE_ACTION_CLASS}
    >
      <GitFork aria-hidden="true" size={12} />
    </button>
  );
}

function ThreadWelcome({ hidden }: { hidden: boolean }) {
  if (hidden) return null;
  return (
    <ThreadPrimitive.If running={false}>
      <ThreadPrimitive.Empty>
        <div
          className={cn(
            THREAD_CONTENT_WIDTH,
            "flex min-h-[50vh] flex-col items-center justify-center text-center",
          )}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary shadow-sm">
            <Bot aria-hidden="true" size={24} />
          </div>
          <h1 className="mt-5 text-[22px] font-bold tracking-tight">开始新的会话</h1>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            发送消息或添加附件，开始一个新的任务。
          </p>
        </div>
      </ThreadPrimitive.Empty>
    </ThreadPrimitive.If>
  );
}

/** 思考中指示（E2-D）：>10s 追加「仍在工作」提示 */
function ThinkingContent() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role="status"
      aria-label="思考中"
      className="flex items-center gap-1 text-sm text-muted-foreground"
    >
      <span>思考中</span>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          aria-hidden="true"
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${index * 150}ms` }}
        />
      ))}
      {slow ? <span className="ml-1">（仍在工作，复杂任务可能需要数分钟）</span> : null}
    </div>
  );
}

/** 非图片附件缩略块的类别图标（word 蓝 / excel 绿 / 文本灰） */
function AttachmentKindIcon({ kind }: { kind: AttachmentKind }) {
  if (kind === "docx") return <FileText aria-hidden="true" size={20} className="text-blue-600" />;
  if (kind === "xlsx")
    return <FileSpreadsheet aria-hidden="true" size={20} className="text-green-600" />;
  return <FileIcon aria-hidden="true" size={20} className="text-muted-foreground" />;
}

/** 单个附件缩略记录：正方形圆角块（图片直出缩略，其余为图标块）+ 下方文件名 */
function FileThumb({ file, onOpen }: { file: FileInfo; onOpen: () => void }) {
  const kind = attachmentKindForName(file.name);
  const url = uploadUrl(file.path);
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : "文件";
  return (
    <div className="flex w-16 flex-col items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`预览 ${file.name}`}
        title={`预览 ${file.name}`}
        className="block overflow-hidden rounded-xl transition-shadow hover:shadow-md hover:ring-2 hover:ring-primary/40"
      >
        {kind === "image" && url ? (
          <img
            src={url}
            alt={file.name}
            className="h-16 w-16 rounded-xl object-cover ring-1 ring-black/10"
          />
        ) : (
          <span className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-card">
            <AttachmentKindIcon kind={kind} />
            <span className="max-w-full truncate px-1 text-[10px] font-medium text-muted-foreground uppercase">
              {ext}
            </span>
          </span>
        )}
      </button>
      <span
        className="w-16 truncate text-center text-[10px] text-muted-foreground"
        title={file.name}
      >
        {file.name}
      </span>
    </div>
  );
}

/** 用户消息附件区：气泡外部的缩略记录行（超出气泡宽度自动换行），点击弹预览 */
function MessageFiles() {
  const files = useCustom<{ files?: FileInfo[] }>()?.files ?? [];
  const [preview, setPreview] = useState<FileInfo | null>(null);
  if (files.length === 0) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {files.map((file) => (
          <FileThumb key={file.path} file={file} onOpen={() => setPreview(file)} />
        ))}
      </div>
      {preview ? <AttachmentPreviewDialog file={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

/** 消息时间（E2-6 修复：60s 定时刷新，跨天驻留标签不冻结） */
function MessageTime() {
  const createdAt = useAuiState(({ message }) => {
    // runtime 会把 ThreadMessageLike.createdAt 规范为 Date
    return (message as unknown as { createdAt?: Date | string }).createdAt;
  });
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!createdAt) return null;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const text =
    d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  return <span className="font-normal opacity-75"> · {text}</span>;
}

/** 用户消息正文：@/​/$ 引用标记渲染为 pill 徽标（与输入框背衬一致；保守分词不误伤邮箱/金额） */
function UserText(props: TextMessagePartProps) {
  const tokens = tokenizeMentionMarkers(props.text);
  return (
    <>
      {tokens.map((token, i) => {
        const key = `${token.type}:${i}`;
        return token.type === "mention" ? (
          <span
            key={key}
            className="rounded bg-black/20 px-0.5 -mx-0.5 font-medium text-inherit ring-1 ring-inset ring-white/30"
          >
            {token.text}
          </span>
        ) : (
          <span key={key}>{token.text}</span>
        );
      })}
    </>
  );
}

function UserMessage() {
  const delivery = useCustom()?.delivery ?? "accepted";
  const text = useAuiState(({ message }) =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join(""),
  );
  const messageId = useAuiState(({ message }) => message.id || undefined);
  const retry = useContext(RetryContext);
  const failed = delivery === "failed";
  const sending = delivery === "sending";
  return (
    <MessagePrimitive.Root
      aria-label="用户消息"
      className={cn(THREAD_CONTENT_WIDTH, "group flex items-start justify-end gap-3 py-4")}
    >
      {/* 气泡与附件缩略记录纵向排布（附件在气泡外部，右对齐随气泡），超宽自动换行 */}
      <div className="flex min-w-0 max-w-[85%] flex-col items-end">
        <div
          className={cn(
            "max-w-full min-w-0 rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm",
            sending && "opacity-60",
            failed && "ring-2 ring-destructive ring-offset-1 ring-offset-background",
          )}
        >
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium opacity-75">
            {failed ? (
              <>
                <span className="font-semibold text-destructive-foreground">未送达</span>
                {retry ? (
                  <button
                    type="button"
                    aria-label="重试发送"
                    title="重试发送"
                    onClick={() => retry(messageId ?? "")}
                    className="inline-flex items-center gap-0.5 rounded bg-white/15 px-1.5 py-0.5 text-[11px] font-semibold hover:bg-white/25"
                  >
                    <RotateCcw size={10} aria-hidden="true" />
                    重试
                  </button>
                ) : null}
                <MessageActions text={text} messageId={messageId} isUser />
              </>
            ) : (
              <>
                你
                <MessageTime />
                <span className="reveal-hover">
                  <MessageActions text={text} messageId={messageId} isUser />
                </span>
                {sending ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : null}
              </>
            )}
          </div>
          <div className="whitespace-pre-wrap break-words">
            <MessagePrimitive.Parts components={{ Text: UserText }} />
          </div>
        </div>
        <MessageFiles />
      </div>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-primary-foreground">
        <UserAvatarImage />
      </div>
    </MessagePrimitive.Root>
  );
}

/** 当前用户头像（钉钉头像），加载失败回退到图标 */
function UserAvatarImage() {
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    void fetchMe().then((u) => setAvatar(u?.avatar ?? null));
  }, []);
  if (avatar) {
    // eslint 无碍：头像 URL 来自服务端用户资料
    return <img src={avatar} alt="" className="h-full w-full object-cover" />;
  }
  return <UserRound aria-hidden="true" size={16} />;
}

function AssistantText() {
  // 启用 GFM：支持表格/删除线/任务列表（否则表格以竖线纯文本显示）；
  // preprocess：全角行号引用转行内代码徽标（lineRefBadge）→ 超长工具 Output 折叠（防刷屏）；
  // 代码块：语法高亮（prism-react-renderer）+ 语言标签 + 复制按钮；表格：容器横滚 + 单元格样式
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      preprocess={(text) => collapseToolNarration(lineRefBadge(text))}
      components={{
        CodeHeader: MarkdownCodeHeader,
        SyntaxHighlighter: MarkdownSyntaxHighlighter,
        table: ({ node: _node, children, ...props }) => (
          <div className="my-3 w-full overflow-x-auto">
            <table
              {...props}
              className="w-full border-collapse text-[13px] [&_td]:min-w-20 [&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_th]:min-w-20 [&_th]:border-b-2 [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium"
            >
              {children}
            </table>
          </div>
        ),
      }}
    />
  );
}

/** 助手回合写入/编辑过的文件链接行：点击打开右侧文件抽屉的变更 tab 并定位该文件 */
function FileChangeLinks() {
  const content = useAuiState(({ message }) => message.content);
  const openFileChange = useContext(OpenFileChangeContext);
  const paths = useMemo(
    () =>
      extractChangedFilePaths(
        content.flatMap((part) =>
          part.type === "tool-call"
            ? [
                {
                  tool: part.toolName,
                  inputPreview: part.argsText ?? "",
                },
              ]
            : [],
        ),
      ),
    [content],
  );
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">变更文件：</span>
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          title={`${shortChangePath(path)}（点击查看变更内容）`}
          onClick={() => openFileChange(path)}
          className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 font-medium text-primary underline-offset-2 hover:bg-muted hover:underline"
        >
          <FileText aria-hidden="true" size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{shortChangePath(path)}</span>
        </button>
      ))}
    </div>
  );
}

/** 助手回合全文（操作面复制/引用用：仅 text 分片拼接，不含工具/思考） */
function AssistantTurnText(): string {
  return (
    useAuiState(({ message }) =>
      message.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n\n"),
    ) ?? ""
  );
}

function AssistantMessage() {
  const assistantName = useContext(AssistantNameContext);
  const custom = useCustom<{ meta?: TurnUsage; stopped?: boolean; turnState?: string }>();
  const isThinking = useAuiState(
    ({ message }) =>
      message.status?.type === "running" &&
      message.content.every((part) => part.type === "text" && !part.text.trim()),
  );
  const isRunning = useAuiState(({ message }) => message.status?.type === "running");
  const hasContent = useAuiState(({ message }) =>
    message.content.some((part) => part.type === "text" && part.text.trim()),
  );
  const turnText = AssistantTurnText();
  return (
    <MessagePrimitive.Root
      aria-label="助手消息"
      className={cn(THREAD_CONTENT_WIDTH, "group flex items-start gap-3 py-5")}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Bot aria-hidden="true" size={16} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-medium text-muted-foreground">
          {assistantName}
          <MessageTime />
          <TurnMetaBadge
            meta={custom?.meta}
            stopped={custom?.stopped}
            isError={custom?.turnState === "error"}
          />
          <span className="reveal-hover">
            <MessageActions text={turnText} isUser={false} />
          </span>
        </div>
        <div
          className={cn(
            "min-w-0 break-words text-sm leading-7 [&_a]:underline [&_pre]:max-w-full",
            // 行内代码视觉区隔（仅行内，块级代码走 SyntaxHighlighter 的深色主题并保持横向滚动）
            "[&_code:not(pre_code)]:break-all [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:border [&_code:not(pre_code)]:border-border [&_code:not(pre_code)]:bg-muted [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:text-[0.85em]",
            "[&_pre_code]:whitespace-pre",
          )}
        >
          {isThinking ? (
            <ThinkingContent />
          ) : (
            <>
              <MessagePrimitive.Parts
                components={{
                  Text: AssistantText,
                  Reasoning: ReasoningBlock,
                  tools: { Fallback: ToolCard },
                }}
              />
              {isRunning && hasContent ? (
                <span className="stream-caret" aria-hidden="true" />
              ) : null}
            </>
          )}
        </div>
        <FileChangeLinks />
      </div>
    </MessagePrimitive.Root>
  );
}

function ComposerAttachmentPreview() {
  const attachment = useAuiState(({ attachment }) => attachment);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.type !== "image" || !attachment.file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.file, attachment.type]);

  return previewUrl ? (
    <img src={previewUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
  ) : (
    <AttachmentPrimitive.unstable_Thumb className="flex h-9 w-9 items-center justify-center rounded-lg bg-background" />
  );
}

function ComposerAttachment() {
  return (
    <AttachmentPrimitive.Root className="flex max-w-full items-center gap-2 rounded-xl border bg-background px-2 py-1.5 text-xs shadow-sm">
      <ComposerAttachmentPreview />
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove
        aria-label="移除附件"
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X aria-hidden="true" size={14} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

export interface AssistantThreadProps {
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  pendingQuestion: PendingQuestion | null;
  questionError?: string;
  onAnswerQuestion: (answers: Record<string, string>, response?: string) => void;
  approvalError?: string;
  credentialError?: string;
  onResolveApproval: (approved: boolean, reason?: string, adoptPrefix?: string) => void;
  onDecideCredentialMissing: (decision: string) => void;
  placeholder: string;
  /** 当前会话绑定的智能体 id（引用候选按该 agent 装配集过滤；空 = 闲聊会话，仅附件入口） */
  agentId?: string;
  /** 助手显示名（chat UE 轮 E2-C：当前 agent 名；空 = 「助手」） */
  assistantName?: string;
  /** 当前会话 id（% 会话候选服务端排除自身；不传则候选可能含当前会话） */
  conversationId?: string;
  /** 选中引用候选后回调（发送时对账后随消息上送） */
  onMentionInserted: (mention: Mention) => void;
  /** 输入区上方插槽（assist 草稿横幅等） */
  aboveComposer?: React.ReactNode;
  /** 输入框底部行插槽：➕ 菜单右侧（会话权限模式切换器等） */
  composerLeading?: React.ReactNode;
  /** 点击助手消息的「变更文件」链接：打开右侧文件抽屉的变更 tab 并定位该文件 */
  onOpenFileChange?: (path: string) => void;
  /** 消息级「从此分叉」（specs/2026-10-23-conversation-fork-design.md §8.1）；生成中不提供 */
  onForkFromMessage?: (messageId: string) => void;
  /** 消息级「编辑」（D2：编辑=从该条分叉新会话 + 原文回填 composer）；生成中不提供 */
  onEditFromMessage?: (messageId: string, text: string) => void;
  /** 失败消息一键重发（E5-A） */
  onRetryMessage?: (messageId: string) => void;
  /** 执行活动摘要行（E2-A：activity SSE 滚窗） */
  activityLines?: string[];
  /** busy 排队深度（E3-C） */
  queueDepth?: number;
  isGenerating?: boolean;
  /** composer 预填桥（D2 编辑=fork：fork 成功后父层经此回填原文） */
  composerBridge?: React.MutableRefObject<((text: string) => void) | null>;
}

export function AssistantThread(props: AssistantThreadProps) {
  const hasPendingInteraction = Boolean(props.pendingApproval || props.pendingCredential);
  const hasAgent = Boolean(props.agentId);
  const { candidates, loading, error, refresh } = useMentionCandidatesState(
    hasAgent,
    props.agentId,
    props.conversationId,
  );
  const aui = useAui();
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const composerText = useAuiState((s) => s.composer.text) ?? "";
  const getTextarea = useCallback(
    () => inputWrapRef.current?.querySelector("textarea") ?? null,
    [],
  );
  const syncBackdropScroll = useCallback(() => {
    const ta = inputWrapRef.current?.querySelector("textarea");
    if (backdropRef.current && ta) backdropRef.current.scrollTop = ta.scrollTop;
  }, []);
  // 菜单插入触发字符：经原生 value setter + input 事件写入（等同真实键入）。
  // 库的光标检测只在 textarea onChange/onSelect 中同步内部光标位置，纯 setText
  // 不触发该链路，导致插入的 @ 不弹候选浮层（2026-09-17 e2e 实锤，勿改回纯 setText）。
  const insertTrigger = useCallback(
    (char: string) => {
      const current = aui.composer().getState().text ?? "";
      const next =
        current.length > 0 && !/\s$/.test(current) ? `${current} ${char}` : `${current}${char}`;
      const textarea = inputWrapRef.current?.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) {
          setter.call(textarea, next);
          textarea.setSelectionRange(next.length, next.length);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
      }
      aui.composer().setText(next);
    },
    [aui],
  );
  /** 引用回填（E4-B）：保留既有输入，引用块追加尾部（同 insertTrigger 的原生 setter 链路） */
  const quoteToComposer = useCallback(
    (text: string) => {
      const clipped = text.length > 800 ? `${text.slice(0, 800)}…` : text;
      const quoted = `\n\n> ${clipped.split("\n").join("\n> ")}\n`;
      const current = aui.composer().getState().text ?? "";
      const next = `${current}${quoted}`;
      const textarea = inputWrapRef.current?.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) {
          setter.call(textarea, next);
          textarea.setSelectionRange(next.length, next.length);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
      }
      aui.composer().setText(next);
    },
    [aui],
  );
  const openFileChange = props.onOpenFileChange;
  // composer 预填桥注册（D2）：与 insertTrigger 同一条原生 setter 链路（纯 setText 不触发
  // 库的光标同步，2026-09-17 e2e 实锤），独占写入（覆盖而非追加——编辑回填场景语义）
  const setTextViaComposer = useCallback(
    (text: string) => {
      const textarea = inputWrapRef.current?.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) {
          setter.call(textarea, text);
          textarea.setSelectionRange(text.length, text.length);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
      }
      aui.composer().setText(text);
    },
    [aui],
  );
  useEffect(() => {
    const bridge = props.composerBridge;
    if (!bridge) return;
    bridge.current = setTextViaComposer;
    return () => {
      bridge.current = null;
    };
  }, [props.composerBridge, setTextViaComposer]);
  const decisionsActive = props.pendingApproval || props.pendingCredential;
  return (
    <OpenFileChangeContext.Provider value={openFileChange ?? (() => {})}>
      <ForkMessageContext.Provider value={props.onForkFromMessage ?? null}>
        <EditMessageContext.Provider value={props.onEditFromMessage ?? null}>
          <QuoteContext.Provider value={quoteToComposer}>
            <RetryContext.Provider value={props.onRetryMessage ?? null}>
              <AssistantNameContext.Provider value={props.assistantName ?? "助手"}>
                <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-muted/20">
                  <ThreadPrimitive.Viewport className="donger-thread-viewport min-h-0 min-w-0 flex-1 overflow-y-auto pb-32 pt-4">
                    <ThreadWelcome hidden={hasPendingInteraction} />
                    <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
                  </ThreadPrimitive.Viewport>
                  <div className="pointer-events-none sticky bottom-0 z-10 -mt-24 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-3 pt-10 sm:px-5">
                    {/* 决策 Dock（E3-A）：审批/凭证/问询三类「需用户决策」的卡统一锚定输入区上方，
                        浏览历史时仍可见可操作（此前审批卡随流滚动不可达） */}
                    <JumpToBottom />
                    <ActivityStrip
                      lines={props.activityLines ?? []}
                      queueDepth={props.queueDepth ?? 0}
                      running={props.isGenerating === true}
                    />
                    {decisionsActive ? (
                      <div className="pointer-events-auto mb-2">
                        <PendingInteraction
                          approval={props.pendingApproval}
                          credential={props.pendingCredential}
                          approvalError={props.approvalError}
                          credentialError={props.credentialError}
                          onResolveApproval={props.onResolveApproval}
                          onDecideCredentialMissing={props.onDecideCredentialMissing}
                        />
                      </div>
                    ) : null}
                    {/* 问题卡锚定输入框正上方（sticky 底栏，不随消息流滚动，浏览历史时仍可见可答） */}
                    {props.pendingQuestion ? (
                      <QuestionCard
                        key={props.pendingQuestion.reqId}
                        question={props.pendingQuestion}
                        error={props.questionError}
                        onAnswer={props.onAnswerQuestion}
                      />
                    ) : null}
                    {props.aboveComposer}
                    <ComposerPrimitive.Root
                      aria-label="消息输入"
                      className="pb-safe pointer-events-auto relative mx-auto w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-sm"
                    >
                      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
                        <div className="mb-2 flex max-w-full flex-wrap gap-2 px-1">
                          <ComposerPrimitive.Attachments
                            components={{ Attachment: ComposerAttachment }}
                          />
                        </div>
                        <div ref={inputWrapRef} className="relative">
                          {/* 引用 chip 背衬层：textarea 文字透明、本层负责可见文本与 pill 渲染（react-mentions 模式） */}
                          {hasAgent ? (
                            <MentionBackdrop text={composerText} backdropRef={backdropRef} />
                          ) : null}
                          <ComposerPrimitive.Input
                            className={cn(
                              "max-h-48 min-h-16 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground",
                              hasAgent && "text-transparent caret-primary selection:bg-primary/30",
                            )}
                            onScroll={syncBackdropScroll}
                            placeholder={props.placeholder}
                          />
                          {/* 闲聊/协助会话无候选来源，不挂触发器（避免 @ 弹出恒空的浮层） */}
                          {hasAgent ? (
                            <ComposerMentionTriggers
                              candidates={candidates}
                              loading={loading}
                              error={error}
                              onMentionInserted={props.onMentionInserted}
                              getTextarea={getTextarea}
                            />
                          ) : null}
                        </div>
                        {/* 移动端窄屏：左簇可压缩（min-w-0），发送按钮不得被挤出屏外；wrap 兜底 */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-1 items-center gap-1">
                            <ComposerPlusMenu
                              hasAgent={hasAgent}
                              onInsertTrigger={insertTrigger}
                              onOpen={refresh}
                            />
                            {props.composerLeading}
                          </div>
                          <ThreadPrimitive.If running={false}>
                            <ComposerPrimitive.Send asChild>
                              <Button
                                type="submit"
                                size="icon"
                                aria-label="发送消息"
                                className="min-h-11 min-w-11 shrink-0 rounded-full"
                              >
                                <ArrowUp aria-hidden="true" size={18} />
                              </Button>
                            </ComposerPrimitive.Send>
                          </ThreadPrimitive.If>
                          <ThreadPrimitive.If running>
                            <ComposerPrimitive.Cancel asChild>
                              <Button
                                type="button"
                                size="icon"
                                aria-label="停止输出"
                                title="停止生成（Esc 亦可）"
                                className="min-h-11 min-w-11 rounded-full"
                              >
                                <Square aria-hidden="true" size={16} fill="currentColor" />
                              </Button>
                            </ComposerPrimitive.Cancel>
                          </ThreadPrimitive.If>
                        </div>
                      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
                    </ComposerPrimitive.Root>
                  </div>
                </ThreadPrimitive.Root>
              </AssistantNameContext.Provider>
            </RetryContext.Provider>
          </QuoteContext.Provider>
        </EditMessageContext.Provider>
      </ForkMessageContext.Provider>
    </OpenFileChangeContext.Provider>
  );
}
