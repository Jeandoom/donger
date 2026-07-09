import { describe, expect, it } from "vitest";
import { mimeForExt, previewKindForExt } from "../../src/domain/file-mime.js";

describe("mimeForExt", () => {
  it("图片扩展名 → image/*", () => {
    expect(mimeForExt("jpg")).toBe("image/jpeg");
    expect(mimeForExt("jpeg")).toBe("image/jpeg");
    expect(mimeForExt("png")).toBe("image/png");
    expect(mimeForExt("gif")).toBe("image/gif");
    expect(mimeForExt("webp")).toBe("image/webp");
  });

  it("svg → image/svg+xml", () => {
    expect(mimeForExt("svg")).toBe("image/svg+xml");
  });

  it("markdown → text/markdown; charset=utf-8", () => {
    expect(mimeForExt("md")).toBe("text/markdown; charset=utf-8");
    expect(mimeForExt("markdown")).toBe("text/markdown; charset=utf-8");
  });

  it("文本类扩展名 → text/plain; charset=utf-8", () => {
    for (const e of [
      "js",
      "ts",
      "json",
      "yaml",
      "yml",
      "csv",
      "txt",
      "log",
      "xml",
      "html",
      "css",
      "py",
      "go",
      "toml",
      "ini",
      "env",
      "ipynb",
      "proto",
      "tf",
      "gradle",
    ]) {
      expect(mimeForExt(e)).toBe("text/plain; charset=utf-8");
    }
  });

  it("无扩展名常见文件名（Dockerfile/Makefile/gitignore）→ text/plain", () => {
    expect(mimeForExt("dockerfile")).toBe("text/plain; charset=utf-8");
    expect(mimeForExt("makefile")).toBe("text/plain; charset=utf-8");
    expect(mimeForExt("gitignore")).toBe("text/plain; charset=utf-8");
  });

  it("未知扩展名 → application/octet-stream", () => {
    expect(mimeForExt("bin")).toBe("application/octet-stream");
    expect(mimeForExt("xyz_unknown")).toBe("application/octet-stream");
    expect(mimeForExt("")).toBe("application/octet-stream");
  });

  it("大小写无关", () => {
    expect(mimeForExt("JS")).toBe("text/plain; charset=utf-8");
    expect(mimeForExt("PNG")).toBe("image/png");
    expect(mimeForExt("Md")).toBe("text/markdown; charset=utf-8");
  });
});

describe("previewKindForExt", () => {
  it("图片/svg → image", () => {
    expect(previewKindForExt("png")).toBe("image");
    expect(previewKindForExt("svg")).toBe("image");
  });

  it("md → markdown", () => {
    expect(previewKindForExt("md")).toBe("markdown");
  });

  it("文本类 → text", () => {
    expect(previewKindForExt("js")).toBe("text");
    expect(previewKindForExt("json")).toBe("text");
  });

  it("未知 → binary", () => {
    expect(previewKindForExt("bin")).toBe("binary");
    expect(previewKindForExt("")).toBe("binary");
  });
});
