import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useEffect, useState } from "react";
import { MAX_MESSAGE_ATTACHMENTS } from "../../lib/chatMessageAdapter";
import type { FileInfo } from "../../lib/chatReducer";
import type { PendingApproval, PendingCredential } from "../../types";
import { Button } from "../ui/button";
import { PendingInteraction } from "./PendingInteraction";

function uploadUrl(path: string): string | null {
  const relativePath = path.split("/sessions/")[1];
  return relativePath ? `/uploads/${relativePath}` : null;
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
    <MessagePrimitive.Root className="ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-primary-foreground">
      <MessagePrimitive.Parts />
      <MessageFiles />
    </MessagePrimitive.Root>
  );
}

function AssistantText() {
  return <MarkdownTextPrimitive />;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mr-auto max-w-[80%] rounded-lg bg-muted px-3 py-2">
      <MessagePrimitive.Parts components={{ Text: AssistantText }} />
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
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="flex-1 space-y-3 overflow-y-auto p-4">
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
      <ComposerPrimitive.Root className="border-t border-border p-3">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
        <div className="flex gap-2">
          <AddAttachmentButton />
          <ComposerPrimitive.Input
            className="min-h-10 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={props.placeholder}
          />
          <ComposerPrimitive.Send asChild>
            <Button type="submit">发送</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
