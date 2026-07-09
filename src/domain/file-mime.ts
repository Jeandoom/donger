// 文件 MIME 与预览类别的统一判定（纯函数，零依赖）。
// 后端 LocalFileBrowser.readFile 与 WebChannel /uploads/ 共用 mimeForExt；
// 前端在 web/src/lib/file-mime.ts 镜像一份 previewKindForExt。

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg"]);

const TEXT_EXT = new Set([
  // 文档
  "md",
  "markdown",
  "rst",
  "txt",
  "log",
  "changelog",
  // 代码
  "js",
  "mjs",
  "cjs",
  "ts",
  "jsx",
  "tsx",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "cs",
  "php",
  "swift",
  "scala",
  "groovy",
  "gradle",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "lua",
  "pl",
  "r",
  "dart",
  "vim",
  "el",
  "clj",
  "cljs",
  "edn",
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "mli",
  "proto",
  "tf",
  "tfvars",
  "hcl",
  // 配置 / 数据
  "json",
  "json5",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "properties",
  "env",
  "editorconfig",
  "gitignore",
  "gitattributes",
  "xml",
  "csv",
  "tsv",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "ipynb",
  // 构建 / 其他
  "dockerfile",
  "makefile",
  "mk",
  "cmake",
  "lock",
  "map",
  "diff",
  "patch",
]);

/** 按扩展名（不含点，小写化处理）返回 MIME。无匹配 → octet-stream。 */
export function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e)) {
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "svg") return "image/svg+xml";
    return `image/${e}`;
  }
  if (e === "md" || e === "markdown") return "text/markdown; charset=utf-8";
  if (TEXT_EXT.has(e)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** 前端渲染分类。 */
export type PreviewKind = "image" | "markdown" | "text" | "binary";
export function previewKindForExt(ext: string): PreviewKind {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e)) return "image";
  if (e === "md" || e === "markdown") return "markdown";
  if (TEXT_EXT.has(e)) return "text";
  return "binary";
}
