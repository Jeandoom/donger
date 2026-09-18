import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliChannel } from "../../src/adapters/cli-channel.js";

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("CliChannel", () => {
  it("send 写入 output（带换行）", async () => {
    const out = new PassThrough();
    let buf = "";
    out.on("data", (c) => {
      buf += c.toString();
    });
    const ch = new CliChannel({ input: new PassThrough(), output: out });
    await ch.send("th", { text: "hello" });
    expect(buf).toBe("hello\n");
  });

  it("onMessage：每行触发 handler", async () => {
    const input = new PassThrough();
    const ch = new CliChannel({ input, output: new PassThrough() });
    const received: string[] = [];
    ch.onMessage((m) => received.push(m.text));
    input.write("line1\n");
    input.write("line2\n");
    await tick();
    expect(received).toEqual(["line1", "line2"]);
  });

  it("requestApproval：输入 y → approved", async () => {
    const input = new PassThrough();
    const ch = new CliChannel({ input, output: new PassThrough() });
    const p = ch.requestApproval("th", { gateId: "g", title: "T", summary: "S" });
    await tick();
    input.write("y\n");
    const result = await p;
    expect(result.approved).toBe(true);
  });

  it("requestApproval：输入 n → denied + reason", async () => {
    const input = new PassThrough();
    const ch = new CliChannel({ input, output: new PassThrough() });
    const p = ch.requestApproval("th", { gateId: "g", title: "T", summary: "S" });
    await tick();
    input.write("n\n");
    const result = await p;
    expect(result.approved).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("审批期间输入被路由给审批，不给 onMessage", async () => {
    const input = new PassThrough();
    const ch = new CliChannel({ input, output: new PassThrough() });
    const received: string[] = [];
    ch.onMessage((m) => received.push(m.text));
    const p = ch.requestApproval("th", { gateId: "g", title: "T", summary: "S" });
    await tick();
    input.write("y\n"); // 审批期间，应由审批消费
    await p;
    await tick();
    expect(received).toEqual([]); // 不进 onMessage
  });
});
