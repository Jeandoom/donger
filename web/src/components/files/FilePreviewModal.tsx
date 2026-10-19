import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { getToken } from "../../lib/auth";
import { previewKindForExt } from "../../lib/file-mime";
import { contentUrl, type FileScope } from "../../lib/files";
import { Button } from "../ui/button";
import { DialogShell } from "../ui/dialog-shell";
import { PREVIEW_KIND_LABEL, PreviewBody, PreviewDownloadLink } from "../ui/preview-views";

/** 取参与判定的扩展名：有点取最后段；无点（Dockerfile/.gitignore）取整个文件名小写 */
function extOfPath(path: string): string {
  const seg = path.split("/").pop() ?? path;
  // .gitignore 这种隐藏文件：split(".") 得 ["", "gitignore"]，pop() → "gitignore"，OK
  return seg.includes(".") ? (seg.split(".").pop() ?? "").toLowerCase() : seg.toLowerCase();
}

/** 文件预览弹窗：抽屉树中点文件后中央大窗预览；←/→ 键与按钮在文件列表间连续切换 */
export function FilePreviewModal(props: {
  scope: FileScope;
  path: string;
  /** 弹窗内 上一个/下一个 导航用的文件清单（树展示序的扁平文件列表） */
  files: string[];
  conversationId?: string;
  /** 切换/关闭时同步回抽屉（树高亮跟随当前预览文件） */
  onNavigate: (path: string) => void;
  onClose: () => void;
}) {
  const { scope, path, files, conversationId, onNavigate, onClose } = props;
  const token = getToken() ?? "";
  const kind = previewKindForExt(extOfPath(path));
  const url = contentUrl({ scope, path, conversationId, token });
  const dl = contentUrl({ scope, path, conversationId, token, download: true });

  const idx = files.indexOf(path);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < files.length - 1;

  function navigate(delta: -1 | 1): void {
    if (idx < 0) return;
    const next = files[idx + delta];
    if (next) onNavigate(next);
  }

  // ←/→ 在文件间切换：lightbox 惯例键位；焦点在输入框等可编辑元素时让位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft") navigate(-1);
      if (e.key === "ArrowRight") navigate(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const name = path.split("/").pop() ?? path;

  return (
    <DialogShell
      title={<span className="break-all">{name}</span>}
      subtitle={
        <span className="flex items-center gap-2">
          <span className="shrink-0">{PREVIEW_KIND_LABEL[kind]}</span>
          <span className="truncate" title={path}>
            {path}
          </span>
        </span>
      }
      onClose={onClose}
      ariaLabel="文件预览"
      className="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={!hasPrev} onClick={() => navigate(-1)}>
            <ChevronLeft size={14} aria-hidden="true" />
            上一个
          </Button>
          <Button variant="ghost" size="sm" disabled={!hasNext} onClick={() => navigate(1)}>
            下一个
            <ChevronRight size={14} aria-hidden="true" />
          </Button>
          <div className="flex-1" />
          <PreviewDownloadLink url={dl} name={name} />
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {/* 弹窗宽（56rem）比附件预览大一档，正文滚动区相应抬高 */}
      <PreviewBody kind={kind} url={url} name={name} scrollClass="max-h-[68vh]" />
    </DialogShell>
  );
}
