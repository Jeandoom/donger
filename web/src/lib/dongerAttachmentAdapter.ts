import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import type { FileInfo } from "./chatReducer";

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,.md,text/markdown";

function fileType(file: File): FileInfo["type"] {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "md" || file.type === "text/markdown") return "markdown";
  if (
    file.type.startsWith("image/") &&
    ["jpg", "jpeg", "png", "gif", "webp"].includes(extension ?? "")
  ) {
    return "image";
  }
  throw new Error("仅支持图片(.jpg/.png/.gif/.webp)和Markdown(.md)");
}

export class DongerAttachmentAdapter implements AttachmentAdapter {
  readonly accept = ACCEPT;

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const type = fileType(file);
    if (file.size > MAX_FILE_SIZE) throw new Error("文件大小超过 2MB 限制");
    return {
      id: `${file.name}-${file.lastModified}`,
      type: type === "image" ? "image" : "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const formData = new FormData();
    formData.append("file", attachment.file);
    const response = await fetch(`/api/upload?threadId=web-${Date.now()}`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) throw new Error(`上传失败：HTTP ${response.status}`);
    const result = (await response.json()) as FileInfo & { url: string };
    const file: FileInfo = { path: result.path, name: result.name, type: result.type };
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "data", name: "donger-file", data: file }],
    };
  }

  async remove(_attachment: Attachment): Promise<void> {
    return Promise.resolve();
  }
}
