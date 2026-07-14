import { afterEach, describe, expect, it, vi } from "vitest";
import { DongerAttachmentAdapter } from "../src/lib/dongerAttachmentAdapter";

describe("DongerAttachmentAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects files larger than 2 MB", async () => {
    const adapter = new DongerAttachmentAdapter();
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    await expect(adapter.add({ file })).rejects.toThrow("文件大小超过 2MB 限制");
  });

  it("uploads and returns donger file metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            path: "/sessions/u/a.png",
            name: "a.png",
            type: "image",
            url: "/uploads/u/a.png",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const adapter = new DongerAttachmentAdapter();
    const pending = await adapter.add({
      file: new File(["image"], "a.png", { type: "image/png" }),
    });
    const complete = await adapter.send(pending);
    expect(complete.content[0]).toEqual({
      type: "data",
      name: "donger-file",
      data: { path: "/sessions/u/a.png", name: "a.png", type: "image" },
    });
  });
});
