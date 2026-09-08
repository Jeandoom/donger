// GLM 端点连通性探针：加载 .env，经 ClaudeAgentRunner 同款配置发起一次最小真实调用。
// 用途：真机 E2E 失败时先跑它，区分「LLM 端点问题」与「测试链路问题」。
// 用法：npx tsx scripts/probe-llm.ts
import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  console.log("[probe] model =", cfg.llm.model);
  console.log("[probe] baseUrl =", cfg.llm.baseUrl);
  console.log(
    "[probe] token =",
    cfg.llm.authToken ? `已配置（长度 ${cfg.llm.authToken.length}）` : "缺失",
  );
  const t0 = Date.now();
  try {
    const stream = query({
      prompt: "只回答两个字：可用",
      options: {
        model: cfg.llm.model,
        maxTurns: 1,
        permissionMode: "default",
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: cfg.llm.baseUrl,
          ANTHROPIC_AUTH_TOKEN: cfg.llm.authToken,
        },
      },
    });
    for await (const m of stream) {
      if (m.type === "system" && "subtype" in m && m.subtype === "init") {
        console.log(`[probe] session 已建立（${Date.now() - t0}ms）`);
      } else if (m.type === "result") {
        const text = m.subtype === "success" && typeof m.result === "string" ? m.result : "";
        console.log(`[probe] result: ${m.subtype}（${Date.now() - t0}ms）${text.slice(0, 50)}`);
      }
    }
    console.log(`[probe] ✅ 端点可用（总耗时 ${Date.now() - t0}ms）`);
  } catch (e) {
    console.error(`[probe] ❌ 调用失败（${Date.now() - t0}ms）：`, (e as Error).message);
    process.exitCode = 1;
  }
}

void main();
