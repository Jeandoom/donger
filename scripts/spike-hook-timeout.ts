// hook 超时语义实测（spec §4.3 契约③）：PreToolUse hook 挂起超过 timeout 时，
// SDK/CLI 对该工具调用是放行（fail-open，守卫静默失效）还是拒绝（fail-closed）。
// 用法：npx tsx scripts/spike-hook-timeout.ts
import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main(): Promise<void> {
  const cfg = (await import("../src/config.js")).loadConfig(process.env);
  const workspace = mkdtempSync(join(tmpdir(), "donger-hooktimeout-"));
  const sawCall: string[] = [];
  const q = query({
    prompt: "运行命令 echo hook-timeout-probe-12345 并告诉我输出",
    options: {
      cwd: workspace,
      permissionMode: "default",
      maxTurns: 6,
      env: {
        PATH: process.env.PATH ?? "",
        ANTHROPIC_BASE_URL: cfg.llm.baseUrl ?? "",
        ANTHROPIC_AUTH_TOKEN: cfg.llm.authToken ?? "",
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "",
      },
      hooks: {
        PreToolUse: [
          {
            timeout: 2, // 秒
            hooks: [
              async (input) => {
                sawCall.push(`${input.hook_event_name}:${JSON.stringify((input as { tool_input?: unknown }).tool_input ?? {}).slice(0, 80)}`);
                await new Promise((r) => setTimeout(r, 30_000)); // 挂起 30s > timeout 2s
                return { continue: true };
              },
            ],
          },
        ],
      },
      canUseTool: async (toolName, input) => {
        console.log(`  [canUseTool] ${toolName}: ${JSON.stringify(input).slice(0, 100)}`);
        return { behavior: "allow", updatedInput: input };
      },
    },
  });
  const texts: string[] = [];
  for await (const m of q) {
    if (m.type === "assistant") {
      for (const c of m.message.content) {
        if (c.type === "text") texts.push(c.text);
        if (c.type === "tool_use") console.log(`  [tool_use] ${c.name}`);
      }
    }
    if (m.type === "user") {
      const content = (m as { message?: { content?: Array<{ type: string; content?: unknown; is_error?: boolean }> } }).message?.content ?? [];
      for (const b of content) {
        if (b.type === "tool_result") {
          const s = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          console.log(`  [tool_result] is_error=${b.is_error} : ${s.slice(0, 150).replace(/\n/g, " ")}`);
        }
      }
    }
  }
  console.log(`\nhook 收到调用: ${sawCall.length ? sawCall.join(" | ") : "(无)"}`);
  const executed = texts.join("\n").includes("hook-timeout-probe-12345");
  console.log(executed
    ? ">>> 判定：命令成功执行 → hook 超时=FAIL-OPEN（守卫可被挂起绕过，须在 hook 外层竞速 deny）"
    : ">>> 判定：命令未执行 → hook 超时=FAIL-CLOSED（超时即拒，契约成立）");
  process.exit(0);
}

void main().catch((e) => {
  console.error("spike 失败:", e);
  process.exit(1);
});
