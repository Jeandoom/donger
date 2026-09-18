import { describe, expect, it } from "vitest";
import { previewKindForExt } from "../src/lib/file-mime";

describe("previewKindForExt", () => {
  it("图片 → image（含 svg）", () => {
    expect(previewKindForExt("png")).toBe("image");
    expect(previewKindForExt("svg")).toBe("image");
    expect(previewKindForExt("JPG")).toBe("image");
  });

  it("md → markdown", () => {
    expect(previewKindForExt("md")).toBe("markdown");
    expect(previewKindForExt("markdown")).toBe("markdown");
  });

  it("文本类 → text", () => {
    for (const e of ["js", "ts", "json", "yaml", "csv", "log", "xml", "py", "dockerfile"]) {
      expect(previewKindForExt(e)).toBe("text");
    }
  });

  it("未知 → binary", () => {
    expect(previewKindForExt("bin")).toBe("binary");
    expect(previewKindForExt("")).toBe("binary");
  });
});
