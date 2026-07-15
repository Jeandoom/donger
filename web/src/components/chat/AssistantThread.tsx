import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { Bot, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { MAX_MESSAGE_ATTACHMENTS } from "../../lib/chatMessageAdapter";
import type { FileInfo } from "../../lib/chatReducer";
import { cn } from "../../lib/utils";
import type { PendingApproval, PendingCredential } from "../../types";
import { Button } from "../ui/button";
import { PendingInteraction } from "./PendingInteraction";

const THREAD_CONTENT_WIDTH = "mx-auto w-full max-w-3xl px-3 sm:px-5";

function uploadUrl(path: string): string | null {
  const relativePath = path.split("/sessions/")[1];
  return relativePath ? `/uploads/${relativePath}` : null;
}

function ThreadWelcome() {
  return (
    <ThreadPrimitive.Empty>
      <div
        className={cn(
          THREAD_CONTENT_WIDTH,
          "flex min-h-[50vh] flex-col items-center justify-center text-center",
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border bg-background shadow-sm">
          <Bot aria-hidden="true" size={24} />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">开始新的对话</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          发送消息或添加附件，开始一个新的任务。
        </p>
      </div>
    </ThreadPrimitive.Empty>
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
            className="rounded bg-muted px-2 py-1 text-xs underline"
          >
            📄 {file.name}
          </a>
        ) : (
          <span key={file.path} className="rounded bg-muted px-2 py-1 text-xs">
            📄 {file.name}
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
  return <MarkdownTextPrimitive />;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      aria-label="助手消息"
      className={cn(THREAD_CONTENT_WIDTH, "flex items-start gap-3 py-5")}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm">
        <Bot aria-hidden="true" size={16} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="mb-2 text-xs font-medium text-muted-foreground">donger</div>
        <div className="min-w-0 break-words text-sm leading-7 [&_a]:underline [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
          <MessagePrimitive.Parts components={{ Text: AssistantText }} />
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
    <img src={previewUrl} alt="" className="h-10 w-10 rounded object-cover" />
  ) : (
    <AttachmentPrimitive.unstable_Thumb className="flex h-10 w-10 items-center justify-center rounded bg-background" />
  );
}

function ComposerAttachment() {
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs">
      <ComposerAttachmentPreview />
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove aria-label="移除附件">×</AttachmentPrimitive.Remove>
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
        variant="outline"
        size="icon"
        aria-label="添加附件"
        className="min-h-11 min-w-11"
        disabled={disabled}
        title={disabled ? `最多上传 ${MAX_MESSAGE_ATTACHMENTS} 个文件` : "添加附件"}
      >
        📎
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
  onSubmitCredential: (values: Record<string, string>) => void;
  placeholder: string;
}

export function AssistantThread(props: AssistantThreadProps) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
        <ThreadWelcome />
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <PendingInteraction
          approval={props.pendingApproval}
          credential={props.pendingCredential}
          approvalError={props.approvalError}
          credentialError={props.credentialError}
          onResolveApproval={props.onResolveApproval}
          onSubmitCredential={props.onSubmitCredential}
        />
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="pb-safe shrink-0 border-t border-border p-3">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
        <div className="flex gap-2">
          <AddAttachmentButton />
          <ComposerPrimitive.Input
            className="min-h-10 min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm lg:resize-y"
            placeholder={props.placeholder}
          />
          <ComposerPrimitive.Send asChild>
            <Button type="submit" className="min-h-11">
              发送
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
