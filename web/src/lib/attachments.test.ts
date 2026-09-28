import { beforeEach, describe, expect, it } from "vitest";
import { attachmentKindForName, uploadUrl } from "./attachments";

describe("attachmentKindForName", () => {
  it("图片扩展名 → image", () => {
    expect(attachmentKindForName("截图.PNG")).toBe("image");
    expect(attachmentKindForName("photo.jpg")).toBe("image");
  });

  it("markdown → markdown；普通文本/代码 → text", () => {
    expect(attachmentKindForName("README.md")).toBe("markdown");
    expect(attachmentKindForName("data.csv")).toBe("text");
    expect(attachmentKindForName("main.ts")).toBe("text");
  });

  it("新 Office 格式可预览（docx/xlsx/xlsm），旧二进制格式按 binary 兜底", () => {
    expect(attachmentKindForName("方案.docx")).toBe("docx");
    expect(attachmentKindForName("报表.xlsx")).toBe("xlsx");
    expect(attachmentKindForName("报表.xlsm")).toBe("xlsx");
    expect(attachmentKindForName("老文档.doc")).toBe("binary");
    expect(attachmentKindForName("老表格.xls")).toBe("binary");
    expect(attachmentKindForName("压缩包.zip")).toBe("binary");
  });

  it("无扩展名 → binary", () => {
    expect(attachmentKindForName("Dockerfile")).toBe("binary");
  });
});

describe("uploadUrl", () => {
  beforeEach(() => {
    localStorage.setItem("donger_jwt", "tok-123");
  });

  it("从 /sessions/<会话>/… 布局的附件路径拼出带 token 的回读 URL", () => {
    expect(uploadUrl("C:/users/u1/sessions/conv-1/workspace/attachments/1730000000-a b.png")).toBe(
      "/uploads/conv-1/1730000000-a%20b.png?token=tok-123",
    );
  });

  it("Windows 反斜杠路径先归一再切片", () => {
    expect(uploadUrl("D:\\home\\sessions\\conv2\\workspace\\attachments\\1-报.md")).toBe(
      "/uploads/conv2/1-%E6%8A%A5.md?token=tok-123",
    );
  });

  it("非会话布局路径返回 null", () => {
    expect(uploadUrl("C:/temp/random.txt")).toBeNull();
  });
});
