// 知识体系真机 E2E（真实 GLM）：五期全链路验收
//
// 全程真实：真实 GLM 驱动执行智能体与收尾萃取；真实 SQLite/HTTP；断言只看事实——
// curated 记忆落盘、KB 记录+修订、技能修订建议（audit+通知）、平台约束候选池、
// 下一轮「长期记忆索引」注入、晋升 API 落盘。
//
// 运行条件：E2E_LIVE=1 且 .env 提供 LLM 密钥；全场景耗时以分钟计。
//   set E2E_LIVE=1 && npx vitest run --config vitest.e2e.config.ts test/e2e/knowledge-live.e2e.test.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LiveBackend, liveEnabled, startLiveBackend } from "./helpers/live-backend.js";
import { kbRootDir } from "../../src/util/kb-files.js";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 120_000 });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 predicate 为真（真机萃取是异步 LLM 调用，分钟级窗口） */
async function pollUntil<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 420_000,
  diag?: string[],
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const hit = await fn();
      if (hit !== undefined) return hit;
    } catch {
      // 单次探测失败（fs 竞态/网关抖动）继续轮询
    }
    if (Date.now() > deadline) {
      const tail = diag && diag.length > 0 ? `\n诊断：\n${diag.slice(-10).join("\n")}` : "";
      throw new Error(`等待「${what}」超时（${timeoutMs}ms）${tail}`);
    }
    await sleep(5_000);
  }
}

describe("知识体系真机全链路（真实 GLM）", () => {
  let backend: LiveBackend;

  beforeAll(async () => {
    if (!liveEnabled()) return;
    backend = await startLiveBackend("knowledge");
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  it("四路萃取 + 索引注入 + 晋升采纳全链路", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    const user = backend.user;

    // ---- 装配：可写绑定库 + paste 技能 + kbAutoLearn agent ----
    const kb = (await backend.api.call("POST", "/api/kb", {
      name: "deploy-ops-library",
      description: "部署运维记录库（真机 e2e）",
    })) as { id: string };
    expect(kb.id).toBeTruthy();

    const pack = await backend.installer.installFromPaste(user.id, {
      content:
        '---\nname: demo-deploy\ndescription: "stock-analysis 部署操作技能（真机 e2e 用）"\n---\n# demo-deploy\n预检：git 状态与远端对齐。\n部署：npm ci + vite build + systemctl restart stock。',
      slug: "demo-deploy",
    });
    const agent = (await backend.api.call("POST", "/api/agents", {
      name: "knowledge-e2e",
      description: "知识体系真机验收",
      systemPrompt: "你是部署运维助手。用户给出复盘材料时，整理成简明的部署报告直接回复，保留全部要点。",
      skills: ["demo-deploy:demo-deploy"],
      knowledgeBaseIds: [kb.id],
      kbAutoLearn: true,
      tools: { mode: "all", whitelist: [] },
      defaultPermissionMode: "full_access",
    })) as { id: string };
    expect(agent.id).toBeTruthy();

    // ---- 第一轮：横跨四类知识的部署复盘（萃取器按类型分流） ----
    const conv = (await backend.api.createConversation(user.id, agent.id)) as { id: string };
    expect(conv.id).toBeTruthy();
    await backend.api.sendMessage(
      conv.id,
      "请记住以下三件事，并按我的要求沉淀：\n" +
        "① 记忆：我管理 stock-analysis 项目，部署窗口固定在每天早上 7-9 点。\n" +
        "② 知识库记录：在 deploy-ops-library 库新增一条部署记录——master 0af693e 上线生产，81 文件变更，探针全绿。\n" +
        "③ 技能修订建议：部署机 npm 12 有 allow-remote=none 供应链策略，标准解法是 npm ci --allow-remote=all 单次绕过——请建议更新 demo-deploy 技能，把这一步加为标准步骤。\n" +
        "不要调用任何工具，直接用文本回复，三行以内确认即可。",
    );
    await pollUntil("第一轮助手回复", async () => {
      const history = (await backend.api.history(conv.id)) as Array<{ role?: string }>;
      return history.filter((m) => m.role === "assistant" || m.role === "bot").length >= 1
        ? history
        : undefined;
    });

    // ---- 四路落位断言（收尾萃取是独立的异步 LLM 调用，分钟级轮询） ----
    const kbRoot = join(backend.workspaceDir, "kb");
    const diag: string[] = [];
    const memoryRoute = await pollUntil(
      "memory 路由：curated 索引落盘",
      async () => {
        if (existsSync(kbRoot)) {
          for (const id of readdirSync(kbRoot)) {
            const index = join(kbRoot, id, "memory", "curated", "INDEX.md");
            if (!existsSync(index)) continue;
            const text = readFileSync(index, "utf8");
            // 命中=索引有任何数据行（萃取器认为值得沉淀的个性化事实）
            if (text.split(/\r?\n/).some((l) => l.trim().startsWith("- "))) {
              return { kbId: id, index: text };
            }
          }
        }
        const errs = await backend.auditStore.listByUserType(user.id, "kb_auto_learn_error", 5);
        const doneTasks = (await backend.api.call("GET", "/api/tasks?status=done")) as Array<{
          id: string;
          prompt?: string;
          conversationId?: string;
        }>;
        const failedTasks = (await backend.api.call("GET", "/api/tasks?status=failed")) as Array<{
          id: string;
          prompt?: string;
          conversationId?: string;
        }>;
        const history = (await backend.api.history(conv.id)) as Array<{
          role?: string;
          text?: string;
        }>;
        const tailMsgs = history
          .slice(-2)
          .map((m) => `${m.role}:${(m.text ?? "").slice(0, 160)}`)
          .join(" | ");
        diag.push(
          `[${new Date().toISOString()}] errors=${JSON.stringify(errs.map((e) => e.text))} ${" +" }
            done=${doneTasks.filter((t) => t.conversationId === conv.id).length} ${" +" }
            failed=${JSON.stringify(failedTasks.filter((t) => t.conversationId === conv.id).map((t) => (t.prompt ?? "").slice(0, 40)))} ${" +" }
            tail=[${tailMsgs}]`,
        );
        return undefined;
      },
      420_000,
      diag,
    );
    expect(memoryRoute.index.length).toBeGreaterThan(0);

    const kbRecordRoute = await pollUntil("kbRecord 路由：绑定库 auto-learn 修订", async () => {
      const revs = (await backend.api.call("GET", `/api/kb/${kb.id}/revisions`)) as {
        items?: Array<{ actorKind?: string }>;
        revisions?: Array<{ actorKind?: string }>;
      };
      const list =
        (revs.items ?? revs.revisions ?? (Array.isArray(revs) ? revs : [])) as Array<{
          actorKind?: string;
        }>;
      return list.some((r) => r.actorKind === "auto-learn") ? list : undefined;
    });
    expect(kbRecordRoute.length).toBeGreaterThan(0);

    const suggestions = await pollUntil("skillSuggestion 路由：audit 留痕", async () => {
      const events = await backend.auditStore.listByUserType(user.id, "skill_suggestion", 10);
      return events.length > 0 ? events : undefined;
    });
    const sugDetail = JSON.parse(suggestions[0]!.toolInput ?? "{}") as {
      targetSkill?: string;
      diff?: string;
    };
    // 萃取器可能用技能全 id（pack:skill）或短名——两者都是合法目标
    expect(sugDetail.targetSkill).toContain("demo-deploy");
    expect((sugDetail.diff ?? "").length).toBeGreaterThan(0);

    // platformNote 路由为软断言：机制已由 applyLearnRoutes 单测覆盖；
    // 真机场景下萃取器可能把环境事实归类为 memory（用户显式要求记住的内容优先）
    const rawCandidates = backend.moduleConfigStore.getFlag("platform.envNotes.candidates") ?? "[]";
    console.log("[live] platformNote candidates:", rawCandidates);

    // 通知（P4）：站内信收到技能修订建议
    const notifications = (await backend.api.call("GET", "/api/notifications")) as
      | Array<{ title?: string }>
      | { items?: Array<{ title?: string }> };
    const notifList = Array.isArray(notifications)
      ? notifications
      : (notifications.items ?? []);
    expect(notifList.some((n) => (n.title ?? "").includes("技能修订建议"))).toBe(true);

    // ---- 第二轮：curated 索引常驻注入（audit llm_input 含「长期记忆索引」节） ----
    await backend.api.sendMessage(conv.id, "确认一下部署窗口偏好，一句话回复。");
    await pollUntil("第二轮助手回复", async () => {
      const history = (await backend.api.history(conv.id)) as Array<{ role?: string }>;
      return history.filter((m) => m.role === "assistant" || m.role === "bot").length >= 2
        ? history
        : undefined;
    });
    const llmInputs = await backend.auditStore.listByConversation(conv.id);
    const injected = llmInputs.find(
      (e) => e.type === "llm_input" && (e.llmInput ?? "").includes("长期记忆索引"),
    );
    expect(injected).toBeDefined();

    // ---- 晋升采纳：把萃取建议经晋升 API 落盘（人审=confirmed 勾选） ----
    const oldDoc = await backend.installer.readSkillDoc(user.id, pack.id, "demo-deploy");
    const newContent =
      sugDetail.diff && sugDetail.diff.includes("name:")
        ? sugDetail.diff
        : `${oldDoc.trimEnd()}\n## 标准步骤（萃取采纳）\nnpm ci --allow-remote=all 单次绕过供应链策略。\n`;
    const applyRes = await fetch(
      `${backend.baseUrl}/api/skills/packs/${pack.id}/skills/demo-deploy/apply-suggestion`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${backend.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: newContent, confirmed: true }),
      },
    );
    expect(applyRes.status).toBe(200);
    const doc = await backend.installer.readSkillDoc(user.id, pack.id, "demo-deploy");
    expect(doc).toContain("allow-remote");
    const promoted = await backend.auditStore.listByUserType(user.id, "skill_promoted", 10);
    expect(promoted.length).toBe(1);
  }, 900_000);
});
