import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { DongerApi } from "../../../cli/src/api.js";
import { runChat } from "../../../cli/src/chat.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * CLI chat REPL 驱动：in-process runChat，输入注入 + 输出累积 + see() 轮询断言。
 * 真实/脚本 runner 两类 E2E 共用。
 */
export class ChatDriver {
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private out = "";
  readonly finished: Promise<void>;

  private constructor(api: DongerApi, baseUrl: string, token: string) {
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      this.out += chunk;
    });
    this.finished = runChat({ api, baseUrl, token, input: this.input, output: this.output });
  }

  /** 等待 boot 完成（就绪横幅输出后主循环才挂起等待输入） */
  static async start(api: DongerApi, baseUrl: string, token: string): Promise<ChatDriver> {
    const d = new ChatDriver(api, baseUrl, token);
    await d.see("/help 查看命令");
    return d;
  }

  type(line: string): void {
    this.input.write(`${line}\n`);
  }

  /** 截取当前输出里的任务短 id（📨 分派反馈「任务 xxxxxxxx」8 位） */
  taskShortId(): string | undefined {
    return this.out.match(/[（(]任务\s*([0-9a-f]{8})[）)]/)?.[1];
  }

  async see(text: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.out.includes(text)) return;
      if (Date.now() > deadline) {
        throw new Error(`等待 "${text}" 超时；最近输出：\n${this.out.slice(-1500)}`);
      }
      await sleep(50);
    }
  }

  /** 等待任一候选信号出现（真机场景：分派/兜底/失败都是合法终态，超时带全量现场） */
  async seeAny(texts: string[], timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const t of texts) {
        if (this.out.includes(t)) return t;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 [${texts.join(" | ")}] 超时；完整输出：\n${this.out.slice(-2500)}`);
      }
      await sleep(100);
    }
  }

  has(text: string): boolean {
    return this.out.includes(text);
  }

  countOf(text: string): number {
    return this.out.split(text).length - 1;
  }

  /** 最近输出（诊断用） */
  tail(max = 1200): string {
    return this.out.slice(-max);
  }

  /** 审批卡逐张批准直到 doneText 出现（真机场景：写操作卡数量不定，逐张跟随） */
  async approveAll(doneText: string, max = 12, timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let approved = 0;
    for (;;) {
      if (this.has(doneText)) return;
      if (this.countOf("🔔") > approved) {
        await sleep(200); // 等 ask() 挂起
        this.type("y");
        approved += 1;
        if (approved > max) {
          throw new Error(`审批卡超过 ${max} 张；输出尾部：\n${this.out.slice(-1200)}`);
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `approveAll 超时（已批准 ${approved} 张）；输出尾部：\n${this.out.slice(-1200)}`,
        );
      }
      await sleep(200);
    }
  }

  async exit(): Promise<void> {
    this.type("/exit");
    const timeout = sleep(10_000).then(() => {
      throw new Error(`CLI 未退出；输出尾部：\n${this.out.slice(-800)}`);
    });
    await Promise.race([this.finished, timeout]);
  }
}

/** 临时目录便捷创建（re-export 让各测试文件少一层 import） */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
