/**
 * 工具结果图片提取（chat UE 优化轮 E2-E 尾巴）：从工具输出文本中识别可直接渲染的图片引用。
 * 三种形态（按优先级取首个命中）：
 *  ① markdown 图片 ![alt](path) —— 引擎截图工具的常见回传形态
 *  ② 完整 data URI（base64 全量在 2000 字符预览内的才可用，超限截断则渲染必然损坏）
 *  ③ 裸路径（工作区内带图片扩展名的文件，走 files/content 端点由调用方换 URL）
 */

export type ToolImageRef =
  | { kind: "markdown"; path: string }
  | { kind: "dataUri"; mediaType: string; data: string }
  | { kind: "workspacePath"; path: string };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(?=[?#]|$)/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/;
const DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/;

export function extractImageRef(resultText: string | undefined): ToolImageRef | null {
  if (!resultText) return null;
  const md = MARKDOWN_IMAGE.exec(resultText);
  if (md?.[1] && IMAGE_EXT.test(md[1])) {
    return { kind: "markdown", path: md[1] };
  }
  const data = DATA_URI.exec(resultText);
  if (data?.[1] && data[2]) {
    return { kind: "dataUri", mediaType: data[1], data: data[2] };
  }
  // 裸路径：非空白且以图片扩展名结尾的 token（跳过 markdown 残留与 URL 协议头）
  const bare =
    /(?:^|[\s"'`(])((?:[\w.@-]+[/\\])*[\w.@-]+\.(?:png|jpe?g|gif|webp|bmp))(?=[\s"'`),]|$)/i.exec(
      resultText,
    );
  if (bare?.[1] && !/^https?:\/\//i.test(bare[1])) {
    return { kind: "workspacePath", path: bare[1] };
  }
  return null;
}
