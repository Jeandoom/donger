import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download } from "lucide-react";
import { getToken } from "../../lib/auth";
import { contentUrl, type FileScope } from "../../lib/files";

const IMG_EXT = ["jpg", "jpeg", "png", "gif", "webp"];

function extOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function FilePreview(props: {
  scope: FileScope;
  path: string;
  conversationId?: string;
}) {
  const { scope, path, conversationId } = props;
  const token = getToken() ?? "";
  const ext = extOf(path);
  const isImage = IMG_EXT.includes(ext);
  const isMd = ext === "md";

  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!isMd) return;
    setLoading(true);
    setError("");
    fetch(contentUrl({ scope, path, conversationId, token }))
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        setText(await r.text());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [scope, path, conversationId, token, isMd]);

  const dl = contentUrl({ scope, path, conversationId, token, download: true });

  if (isImage) {
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
  if (isMd) {
    if (loading) return <div className="p-3 text-sm text-muted-foreground">加载中…</div>;
    if (error) return <div className="p-3 text-sm text-red-600">加载失败：{error}</div>;
    return (
      <div className="markdown p-3 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
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
