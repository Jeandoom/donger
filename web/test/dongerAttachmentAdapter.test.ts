import { afterEach, describe, expect, it, vi } from "vitest";
import { DongerAttachmentAdapter } from "../src/lib/dongerAttachmentAdapter";

describe("DongerAttachmentAdapter", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("rejects files larger than 20 MB", async () => {
    const adapter = new DongerAttachmentAdapter();
    const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    await expect(adapter.add({ file })).rejects.toThrow("文件大小超过 20MB 限制");
  });

  it("accepts arbitrary file types as document", async () => {
    const adapter = new DongerAttachmentAdapter();
    const xlsx = await adapter.add({
      file: new File(["binary"], "报表.xlsx", { type: "application/vnd.ms-excel" }),
    });
    expect(xlsx.type).toBe("document");
    const zip = await adapter.add({
      file: new File(["zip"], "pack.zip", { type: "application/zip" }),
    });
    expect(zip.type).toBe("document");
  });

  it("uploads and returns donger file metadata", async () => {
    localStorage.setItem("donger_jwt", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          path: "/sessions/u/a.png",
          name: "a.png",
          type: "image",
          url: "/uploads/u/a.png",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DongerAttachmentAdapter("conversation-1");
    const pending = await adapter.add({
      file: new File(["image"], "a.png", { type: "image/png" }),
    });
    const complete = await adapter.send(pending);
    expect(complete.content[0]).toEqual({
      type: "data",
      name: "donger-file",
      data: { path: "/sessions/u/a.png", name: "a.png", type: "image" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/upload?threadId=conversation-1",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
      }),
    );
  });

  it("shows the server upload error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "文件目录不可写" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const adapter = new DongerAttachmentAdapter("conversation-1");
    const pending = await adapter.add({
      file: new File(["image"], "a.png", { type: "image/png" }),
    });

    await expect(adapter.send(pending)).rejects.toThrow("上传失败：文件目录不可写");
  });
});
