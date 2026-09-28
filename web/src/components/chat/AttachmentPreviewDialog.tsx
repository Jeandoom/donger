import { Download, FileQuestion } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type AttachmentKind, attachmentKindForName, uploadUrl } from "../../lib/attachments";
import type { FileInfo } from "../../lib/chatReducer";
import { parseXlsxFirstSheet } from "../../lib/xlsxPreview";
import { Button } from "../ui/button";
import { DialogShell } from "../ui/dialog-shell";

/** 文本预览上限：超过则截断提示（大文件走下载） */
const TEXT_PREVIEW_LIMIT = 512 * 1024;

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  markdown: "Markdown",
  text: "文本",
  docx: "Word 文档",
  xlsx: "Excel 表格",
  binary: "文件",
};

/** 带状态的取文加载器 */
function useFetchedText(url: string | null) {
  const [state, setState] = useState<{ loading: boolean; error: string; text: string }>({
    loading: true,
    error: "",
    text: "",
  });
  useEffect(() => {
    if (!url) {
      setState({ loading: false, error: "无法定位文件", text: "" });
      return;
    }
    let cancelled = false;
    setState({ loading: true, error: "", text: "" });
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setState({ loading: false, error: "", text });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setState({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            text: "",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}

function TextView({ url }: { url: string }) {
  const { loading, error, text } = useFetchedText(url);
  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError message={error} />;
  const truncated = text.length > TEXT_PREVIEW_LIMIT;
  const shown = truncated ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}\n…` : text;
  return (
    <div className="min-w-0">
      {truncated ? (
        <p className="mb-2 text-xs text-warning">
          文件较大，仅预览前 512KB（共 {(text.length / 1024).toFixed(0)}KB）
        </p>
      ) : null}
      <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
        {shown}
      </pre>
    </div>
  );
}

function MarkdownView({ url }: { url: string }) {
  const { loading, error, text } = useFetchedText(url);
  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError message={error} />;
  return (
    <div className="max-h-[60vh] overflow-auto rounded-lg border border-border p-4 text-sm leading-7 [&_a]:underline [&_pre]:overflow-x-auto">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

function DocxView({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string }>({
    loading: true,
    error: "",
  });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "" });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        // 按需加载渲染器（代码分割，非 docx 预览不进主包）
        const { renderAsync } = await import("docx-preview");
        const container = containerRef.current;
        if (cancelled || !container) return;
        container.innerHTML = "";
        await renderAsync(buffer, container, undefined, {
          inWrapper: true,
          breakPages: false,
          ignoreLastRenderedPageBreak: true,
          useBase64URL: true,
        });
        if (!cancelled) setState({ loading: false, error: "" });
      } catch (reason: unknown) {
        if (!cancelled)
          setState({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className="min-w-0">
      {state.loading ? <PreviewLoading /> : null}
      {state.error ? <PreviewError message={state.error} /> : null}
      <div
        ref={containerRef}
        // docx-preview 的 .docx-wrapper 自带灰底大内边距（模拟纸边），弹窗内改透明贴合卡片
        className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-white p-4 text-sm [&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-0 [&_section.docx]:!shadow-none [&_img]:max-w-full"
        hidden={state.loading || Boolean(state.error)}
      />
    </div>
  );
}

function XlsxView({ url }: { url: string }) {
  const [state, setState] = useState<{
    loading: boolean;
    error: string;
    preview: Awaited<ReturnType<typeof parseXlsxFirstSheet>> | null;
  }>({ loading: true, error: "", preview: null });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", preview: null });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const preview = await parseXlsxFirstSheet(await res.arrayBuffer());
        if (!cancelled) setState({ loading: false, error: "", preview });
      } catch (reason: unknown) {
        if (!cancelled)
          setState({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            preview: null,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (state.loading) return <PreviewLoading />;
  if (state.error) return <PreviewError message={state.error} />;
  const preview = state.preview;
  if (!preview) return null;
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs text-muted-foreground">
        工作表「{preview.sheetName}」
        {preview.truncated
          ? ` · 共 ${preview.totalRows} 行，仅预览前 ${preview.rows.length} 行`
          : ` · ${preview.rows.length} 行`}
      </p>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {preview.rows.map((cells, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态文本矩阵，行序即键
              <tr key={r} className={r === 0 ? "bg-muted/50 font-medium" : undefined}>
                {cells.map((cell, c) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: 静态文本矩阵，列序即键
                    key={c}
                    className="max-w-48 truncate border-b border-border/60 px-2 py-1 align-top"
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewLoading() {
  return <p className="py-6 text-center text-sm text-muted-foreground">加载预览…</p>;
}

function PreviewError({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-xs text-destructive">
      预览失败：{message}（可尝试下载后本地打开）
    </p>
  );
}

function BinaryFallback({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
      <FileQuestion aria-hidden="true" size={28} />
      <span>「{name}」暂不支持在线预览，可点击下方下载后打开</span>
    </div>
  );
}

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
  let body: ReactNode;
  if (!url) {
    body = <PreviewError message="无法定位文件路径" />;
  } else {
    switch (kind) {
      case "image":
        body = (
          <img
            src={url}
            alt={file.name}
            className="mx-auto max-h-[60vh] rounded-lg object-contain"
          />
        );
        break;
      case "text":
        body = <TextView url={url} />;
        break;
      case "markdown":
        body = <MarkdownView url={url} />;
        break;
      case "docx":
        body = <DocxView url={url} />;
        break;
      case "xlsx":
        body = <XlsxView url={url} />;
        break;
      default:
        body = <BinaryFallback name={file.name} />;
    }
  }
  return (
    <DialogShell
      title={<span className="break-all">{file.name}</span>}
      subtitle={KIND_LABEL[kind]}
      onClose={onClose}
      ariaLabel="附件预览"
      className="max-w-3xl"
      footer={
        <>
          {url ? (
            <a
              href={url}
              download={file.name}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <Download size={14} aria-hidden="true" />
              下载
            </a>
          ) : null}
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {body}
    </DialogShell>
  );
}
