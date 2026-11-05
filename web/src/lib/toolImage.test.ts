import { describe, expect, it } from "vitest";
import { extractImageRef } from "./toolImage";

describe("extractImageRef（工具结果图片直出，chat UE 轮 E2-E）", () => {
  it("markdown 图片命中路径", () => {
    expect(extractImageRef("截图完成\n![截图](screenshots/shot.png)")).toEqual({
      kind: "markdown",
      path: "screenshots/shot.png",
    });
  });

  it("完整 data URI 命中", () => {
    const tiny =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    expect(extractImageRef(`预览：data:image/png;base64,${tiny}`)).toEqual({
      kind: "dataUri",
      mediaType: "image/png",
      data: tiny,
    });
  });

  it("裸工作区路径命中（排除 http URL）", () => {
    expect(extractImageRef("已保存到 out/result.jpg")).toEqual({
      kind: "workspacePath",
      path: "out/result.jpg",
    });
    // markdown 括号里的 http 图片走 markdown 分支；裸 http 不进 workspacePath
    expect(extractImageRef("见 ![图](https://example.com/a.png) 与文本")).toEqual({
      kind: "markdown",
      path: "https://example.com/a.png",
    });
    const bareHttp = extractImageRef("https://example.com/a.png 已下载");
    expect(bareHttp === null || bareHttp.kind !== "workspacePath").toBe(true);
  });

  it("普通文本/无图片返回 null", () => {
    expect(extractImageRef("命令执行成功，共 3 行输出")).toBeNull();
    expect(extractImageRef(undefined)).toBeNull();
    expect(extractImageRef("data:image/png;base64,截断到一半")).toBeNull();
  });
});
