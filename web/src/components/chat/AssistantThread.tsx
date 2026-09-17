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
import { ArrowUp, Bot, Square, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { BUILTIN_ASSIST_AGENT_ID } from "../../lib/assist";
import { fetchMe, getToken } from "../../lib/auth";
import type { FileInfo } from "../../lib/chatReducer";
import { lineRefBadge } from "../../lib/lineRefBadge";
import type { Mention } from "../../lib/mentions";
import { tokenizeMentionMarkers } from "../../lib/mentions";
import { collapseToolNarration } from "../../lib/toolNarration";
import { cn } from "../../lib/utils";
import type { PendingApproval, PendingCredential, PendingQuestion } from "../../types";
import { Button } from "../ui/button";
import {
  ComposerMentionTriggers,
  ComposerPlusMenu,
  useMentionCandidatesState,
} from "./ComposerMentions";
import { MarkdownCodeHeader, MarkdownSyntaxHighlighter } from "./MarkdownCodeBlock";
import { PendingInteraction } from "./PendingInteraction";
import { QuestionCard } from "./QuestionCard";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCard } from "./ToolCard";

const THREAD_CONTENT_WIDTH = "mx-auto w-full max-w-3xl px-3 sm:px-5";

function uploadUrl(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const relativePath = normalized.split("/sessions/")[1];
  if (!relativePath) return null;
  const [conversationId, ...parts] = relativePath.split("/");
  const fileName = parts.at(-1);
  if (!conversationId || !fileName) return null;
  // 附件已不无鉴权直出（规格 M4）：img 请求带属主 token
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/uploads/${encodeURIComponent(conversationId)}/${encodeURIComponent(fileName)}${qs}`;
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

function ThinkingContent() {
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
    </div>
  );
}

function MessageFiles() {
  const files = useAuiState(({ message }) => (message.metadata.custom.files ?? []) as FileInfo[]);
  if (files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {files.map((file) => {
        const url = uploadUrl(file.path);
        if (file.type === "image" && url) {
          return (
            <img
              key={file.path}
              src={url}
              alt={file.name}
              className="max-h-32 max-w-full rounded object-contain"
            />
          );
        }
        return url ? (
          <a
            key={file.path}
            href={url}
            download={file.name}
            className="rounded-lg bg-muted px-2 py-1 text-xs underline"
          >
            {file.name}
          </a>
        ) : (
          <span key={file.path} className="rounded-lg bg-muted px-2 py-1 text-xs">
            {file.name}
          </span>
        );
      })}
    </div>
  );
}

function MessageTime() {
  const createdAt = useAuiState(({ message }) => {
    // runtime 会把 ThreadMessageLike.createdAt 规范为 Date
    return (message as unknown as { createdAt?: Date | string }).createdAt;
  });
  if (!createdAt) return null;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const text =
    d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  return <span className="font-normal opacity-75"> · {text}</span>;
}

/** 用户消息正文：@/​/$ 引用标记高亮（保守分词，邮箱/金额/路径不误伤） */
function UserText(props: TextMessagePartProps) {
  const tokens = tokenizeMentionMarkers(props.text);
  return (
    <>
      {tokens.map((token, i) => {
        const key = `${token.type}:${i}`;
        return token.type === "mention" ? (
          <span
            key={key}
            className="rounded bg-black/20 px-1 font-medium text-inherit dark:bg-white/20"
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
  return (
    <MessagePrimitive.Root
      aria-label="用户消息"
      className={cn(THREAD_CONTENT_WIDTH, "flex items-start justify-end gap-3 py-4")}
    >
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
        <div className="mb-1 text-xs font-medium opacity-75">
          你
          <MessageTime />
        </div>
        <div className="whitespace-pre-wrap break-words">
          <MessagePrimitive.Parts components={{ Text: UserText }} />
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
              className="w-full border-collapse text-[13px] [&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_th]:border-b-2 [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium"
            >
              {children}
            </table>
          </div>
        ),
      }}
    />
  );
}

function AssistantMessage() {
  const isThinking = useAuiState(
    ({ message }) =>
      message.status?.type === "running" &&
      message.content.every((part) => part.type === "text" && !part.text.trim()),
  );
  return (
    <MessagePrimitive.Root
      aria-label="助手消息"
      className={cn(THREAD_CONTENT_WIDTH, "flex items-start gap-3 py-5")}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Bot aria-hidden="true" size={16} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          donger
          <MessageTime />
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
            <MessagePrimitive.Parts
              components={{
                Text: AssistantText,
                Reasoning: ReasoningBlock,
                tools: { Fallback: ToolCard },
              }}
            />
          )}
        </div>
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
  onResolveApproval: (approved: boolean, reason?: string) => void;
  onDecideCredentialMissing: (decision: string) => void;
  placeholder: string;
  /** 当前会话绑定的智能体 id（引用候选按该 agent 装配集过滤；空 = 闲聊会话，仅附件入口） */
  agentId?: string;
  /** 选中引用候选后回调（发送时对账后随消息上送） */
  onMentionInserted: (mention: Mention) => void;
  /** 输入区上方插槽（assist 草稿横幅等） */
  aboveComposer?: React.ReactNode;
  /** 输入框底部行插槽：附件按钮左侧（会话权限模式切换器等） */
  composerLeading?: React.ReactNode;
}

export function AssistantThread(props: AssistantThreadProps) {
  const hasPendingInteraction = Boolean(props.pendingApproval || props.pendingCredential);
  const hasAgent = Boolean(props.agentId) && props.agentId !== BUILTIN_ASSIST_AGENT_ID;
  const { candidates, loading, error, refresh } = useMentionCandidatesState(
    hasAgent,
    props.agentId,
  );
  const aui = useAui();
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  // 菜单插入触发字符：追加到文本末尾（词首才触发检测，必要时先补空白），并把光标挪到末尾
  const insertTrigger = useCallback(
    (char: string) => {
      const current = aui.composer().getState().text ?? "";
      const next =
        current.length > 0 && !/\s$/.test(current) ? `${current} ${char}` : `${current}${char}`;
      aui.composer().setText(next);
      requestAnimationFrame(() => {
        const textarea = inputWrapRef.current?.querySelector("textarea");
        textarea?.focus();
        const end = textarea?.value.length ?? next.length;
        textarea?.setSelectionRange(end, end);
      });
    },
    [aui],
  );
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-muted/20">
      <ThreadPrimitive.Viewport className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-32 pt-4">
        <ThreadWelcome hidden={hasPendingInteraction} />
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <div className={THREAD_CONTENT_WIDTH}>
          <PendingInteraction
            approval={props.pendingApproval}
            credential={props.pendingCredential}
            approvalError={props.approvalError}
            credentialError={props.credentialError}
            onResolveApproval={props.onResolveApproval}
            onDecideCredentialMissing={props.onDecideCredentialMissing}
          />
        </div>
      </ThreadPrimitive.Viewport>
      <div className="pointer-events-none sticky bottom-0 z-10 -mt-24 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-3 pt-10 sm:px-5">
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
              <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
            </div>
            <div ref={inputWrapRef} className="relative">
              <ComposerPrimitive.Input
                className="max-h-48 min-h-16 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground"
                placeholder={props.placeholder}
              />
              <ComposerMentionTriggers
                candidates={candidates}
                loading={loading}
                error={error}
                onMentionInserted={props.onMentionInserted}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {props.composerLeading}
                <ComposerPlusMenu
                  hasAgent={hasAgent}
                  onInsertTrigger={insertTrigger}
                  onOpen={refresh}
                />
              </div>
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send asChild>
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="发送消息"
                    className="min-h-11 min-w-11 rounded-full"
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
  );
}
