import { query } from "@anthropic-ai/claude-agent-sdk";
import type { LLMConfig } from "../domain/llm-config.js";
import type { LlmDebugRunner } from "../ports/llm-debug-runner.js";

/** 使用与 Agent runner 相同的 Anthropic-compatible SDK 做无工具调试调用。 */
export class ClaudeLlmDebugRunner implements LlmDebugRunner {
  async run(input: string, llm: LLMConfig): Promise<{ output: string }> {
    const stream = query({
      prompt: extractPrompt(input),
      options: {
        cwd: process.cwd(),
        model: llm.model,
        includePartialMessages: true,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: llm.baseUrl,
          ANTHROPIC_AUTH_TOKEN: llm.authToken,
        },
      },
    });
    const messages: unknown[] = [];
    for await (const message of stream) messages.push(message);
    return { output: serializeJson(messages) };
  }
}

function extractPrompt(input: string): string {
  try {
    const parsed = JSON.parse(input) as { prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : input;
  } catch {
    return input;
  }
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
