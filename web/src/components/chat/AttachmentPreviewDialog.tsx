import { attachmentKindForName, uploadUrl } from "../../lib/attachments";
import type { FileInfo } from "../../lib/chatReducer";
import { Button } from "../ui/button";
import { DialogShell } from "../ui/dialog-shell";
import { PREVIEW_KIND_LABEL, PreviewBody, PreviewDownloadLink } from "../ui/preview-views";

/** 消息附件预览弹窗：图片直出；文本/Markdown 取文渲染；docx/xlsx 按需加载解析器做基本预览 */
export function AttachmentPreviewDialog({
  file,
  onClose,
}: {
  file: FileInfo;
  onClose: () => void;
}) {
  const kind = attachmentKindForName(file.name);
  const url = uploadUrl(file.path);
  return (
    <DialogShell
      title={<span className="break-all">{file.name}</span>}
      subtitle={PREVIEW_KIND_LABEL[kind]}
      onClose={onClose}
      ariaLabel="附件预览"
      className="max-w-3xl"
      footer={
        <>
          {url ? <PreviewDownloadLink url={url} name={file.name} /> : null}
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <PreviewBody kind={kind} url={url} name={file.name} />
    </DialogShell>
  );
}
