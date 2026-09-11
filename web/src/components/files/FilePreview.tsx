import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getToken } from "../../lib/auth";
import { previewKindForExt } from "../../lib/file-mime";
import { contentUrl, type FileScope } from "../../lib/files";

/** 取参与判定的扩展名：有点取最后段；无点（Dockerfile/.gitignore）取整个文件名小写 */
function extOfPath(path: string): string {
  const seg = path.split("/").pop() ?? path;
  // .gitignore 这种隐藏文件：split(".") 得 ["", "gitignore"]，pop() → "gitignore"，OK
  return seg.includes(".") ? (seg.split(".").pop() ?? "").toLowerCase() : seg.toLowerCase();
}

export function FilePreview(props: { scope: FileScope; path: string; conversationId?: string }) {
  const { scope, path, conversationId } = props;
  const token = getToken() ?? "";
  const kind = previewKindForExt(extOfPath(path));

  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    // markdown 与 text 都需拉取文本内容
    if (kind !== "markdown" && kind !== "text") return;
    setLoading(true);
    setError("");
    fetch(contentUrl({ scope, path, conversationId, token }))
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        setText(await r.text());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [scope, path, conversationId, token, kind]);

  const dl = contentUrl({ scope, path, conversationId, token, download: true });

  if (kind === "image") {
    return (
      <div className="flex items-center justify-center p-3">
        <img
          src={contentUrl({ scope, path, conversationId, token })}
          alt={path}
          className="max-h-[60vh] rounded"
        />
      </div>
    );
  }
  if (kind === "markdown") {
    if (loading) return <div className="p-3 text-sm text-muted-foreground">加载中…</div>;
    if (error) return <div className="p-3 text-sm text-destructive">加载失败：{error}</div>;
    return (
      <div className="markdown p-3 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (kind === "text") {
    if (loading) return <div className="p-3 text-sm text-muted-foreground">加载中…</div>;
    if (error) return <div className="p-3 text-sm text-destructive">加载失败：{error}</div>;
    return (
      <pre className="max-h-[60vh] overflow-auto bg-muted/30 p-3 text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
    );
  }
  return (
    <div className="p-3 text-sm text-muted-foreground">
      该类型不支持预览，
      <a className="text-primary underline" href={dl}>
        <Download size={14} className="inline" /> 下载
      </a>
    </div>
  );
}
