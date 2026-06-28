import { createInterface, type Interface } from "node:readline";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";

export interface CliChannelOptions {
  /** 输入流（默认 stdin），注入便于测试 */
  input?: NodeJS.ReadableStream;
  /** 输出流（默认 stdout） */
  output?: NodeJS.WritableStream;
}

/**
 * 调试用 Channel：stdin 收消息、stdout 发消息、终端 y/N 做审批。
 * 单 readline 路由：有 pending 审批时把行交给审批决议，否则交给 onMessage。
 */
export class CliChannel implements Channel {
  readonly id = "cli";
  private handler?: (msg: IncomingMessage) => void;
  private pendingApproval?: (line: string) => void;
  private readonly out: NodeJS.WritableStream;
  private readonly rl: Interface;

  constructor(opts: CliChannelOptions = {}) {
    this.out = opts.output ?? process.stdout;
    this.rl = createInterface({ input: opts.input ?? process.stdin });
    this.rl.on("line", (line: string) => {
      if (this.pendingApproval) {
        const resolve = this.pendingApproval;
        this.pendingApproval = undefined;
        resolve(line);
      } else {
        this.handler?.({
          channelId: "cli",
          threadId: "console",
          requesterId: "local",
          text: line,
        });
      }
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async send(_threadId: string, msg: OutgoingMessage): Promise<void> {
    this.out.write(`${msg.text}\n`);
  }

  async requestApproval(
    _threadId: string,
    card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    this.out.write(`\n[审批门] ${card.title}\n${card.summary}\n通过？(y/N): `);
    const line = await new Promise<string>((resolve) => {
      this.pendingApproval = resolve;
    });
    const ok = line.trim().toLowerCase().startsWith("y");
    return ok ? { approved: true } : { approved: false, reason: "用户在 CLI 驳回" };
  }
}
