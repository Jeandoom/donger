import { getToken } from "./auth";
import { previewKindForExt } from "./file-mime";

/** 消息附件的预览类别（扩展名判定；doc/xls 等旧二进制格式解析不了，按 binary 走下载兜底） */
export type AttachmentKind = "image" | "markdown" | "text" | "docx" | "xlsx" | "binary";

const DOCX_EXTS = new Set(["docx"]);
const XLSX_EXTS = new Set(["xlsx", "xlsm"]);

export function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function attachmentKindForName(name: string): AttachmentKind {
  const ext = extOf(name);
  switch (previewKindForExt(ext)) {
    case "image":
      return "image";
    case "markdown":
      return "markdown";
    case "text":
      return "text";
    default:
      return DOCX_EXTS.has(ext) ? "docx" : XLSX_EXTS.has(ext) ? "xlsx" : "binary";
  }
}

/** 附件回读 URL：/uploads 静态托管按 /sessions/<会话>/… 布局切片 + 属主 token 查询参数 */
export function uploadUrl(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const relativePath = normalized.split("/sessions/")[1];
  if (!relativePath) return null;
  const [conversationId, ...parts] = relativePath.split("/");
  const fileName = parts.at(-1);
  if (!conversationId || !fileName) return null;
  // 附件已不无鉴权直出（规格 M4）：img/fetch 请求带属主 token
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/uploads/${encodeURIComponent(conversationId)}/${encodeURIComponent(fileName)}${qs}`;
}
