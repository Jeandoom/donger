import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, Bot, Paperclip, Square, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import remarkGfm from "remark-gfm";
import { MAX_MESSAGE_ATTACHMENTS } from "../../lib/chatMessageAdapter";
import type { FileInfo } from "../../lib/chatReducer";
import { cn } from "../../lib/utils";
import type { PendingApproval, PendingCredential } from "../../types";
import { Button } from "../ui/button";
import { PendingInteraction } from "./PendingInteraction";

const THREAD_CONTENT_WIDTH = "mx-auto w-full max-w-3xl px-3 sm:px-5";

function uploadUrl(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const relativePath = normalized.split("/sessions/")[1];
  if (!relativePath) return null;
  const [conversationId, ...parts] = relativePath.split("/");
  const fileName = parts.at(-1);
  if (!conversationId || !fileName) return null;
  return `/uploads/${encodeURIComponent(conversationId)}/${encodeURIComponent(fileName)}`;
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
          <h1 className="mt-5 text-[22px] font-bold tracking-tight">开始新的对话</h1>
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

function UserMessage() {
  return (
    <MessagePrimitive.Root
      aria-label="用户消息"
      className={cn(THREAD_CONTENT_WIDTH, "flex items-start justify-end gap-3 py-4")}
    >
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
        <div className="mb-1 text-xs font-medium opacity-75">你</div>
        <div className="whitespace-pre-wrap break-words">
          <MessagePrimitive.Parts />
        </div>
        <MessageFiles />
      </div>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <UserRound aria-hidden="true" size={16} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantText() {
  // 启用 GFM：支持表格/删除线/任务列表（否则表格以竖线纯文本显示）
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} />;
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
        <div className="mb-2 text-xs font-medium text-muted-foreground">donger</div>
        <div className="min-w-0 break-words text-sm leading-7 [&_a]:underline [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
          {isThinking ? (
            <ThinkingContent />
          ) : (
            <MessagePrimitive.Parts components={{ Text: AssistantText }} />
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

function AddAttachmentButton() {
  const attachmentCount = useAuiState(({ composer }) => composer.attachments.length);
  const disabled = attachmentCount >= MAX_MESSAGE_ATTACHMENTS;
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="添加附件"
        className="min-h-11 min-w-11 rounded-full text-muted-foreground"
        disabled={disabled}
        title={disabled ? `最多上传 ${MAX_MESSAGE_ATTACHMENTS} 个文件` : "添加附件"}
      >
        <Paperclip aria-hidden="true" size={18} />
      </Button>
    </ComposerPrimitive.AddAttachment>
  );
}

export interface AssistantThreadProps {
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  approvalError?: string;
  credentialError?: string;
  onResolveApproval: (approved: boolean, reason?: string) => void;
  onDecideCredentialMissing: (decision: string) => void;
  placeholder: string;
  /** 输入区上方插槽（assist 草稿横幅等） */
  aboveComposer?: React.ReactNode;
}

export function AssistantThread(props: AssistantThreadProps) {
  const hasPendingInteraction = Boolean(props.pendingApproval || props.pendingCredential);
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
        {props.aboveComposer}
        <ComposerPrimitive.Root
          aria-label="消息输入"
          className="pb-safe pointer-events-auto mx-auto w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-sm"
        >
          <div className="mb-2 flex max-w-full flex-wrap gap-2 px-1">
            <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
          </div>
          <ComposerPrimitive.Input
            className="max-h-48 min-h-16 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground"
            placeholder={props.placeholder}
          />
          <div className="flex items-center justify-between gap-2">
            <AddAttachmentButton />
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
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
