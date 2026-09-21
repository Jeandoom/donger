// 方案一 · 知识库的创建、查询与维护（真机 E2E，主题：A 股交易数据与交易行为分析）
//
// 全程真实：真实 GLM 驱动 dispatcher / Agent Builder / 执行智能体；平台工具（write_skill /
// create_agent / finish_builder）真实落库；agent 入库即自动进入分发登记表（DB 动态渲染）。
// 断言只看事实：agent/技能入库、任务终态、分派反馈——不 mock 任何数据。
//
// 运行条件：E2E_LIVE=1 且 .env 提供 LLM 密钥；单场景耗时以分钟计。
//   set E2E_LIVE=1 && npx vitest run test/e2e/kb-lifecycle.live.e2e.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../../cli/src/api.js";
import { ChatDriver } from "./helpers/driver.js";
import {
  CLI_TOKEN,
  type LiveBackend,
  liveEnabled,
  startLiveBackend,
} from "./helpers/live-backend.js";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 120_000 });

const KB_RULES = `# A 股价格与交易规则

## 涨跌停幅度
- 主板（沪市 60/深市 00 开头）：±10%
- ST/*ST 股票：±5%
- 创业板（30 开头）与科创板（68 开头）：±20%
- 北交所（8/4 开头）：±30%

## 交易制度
- A 股实行 T+1 交收：当日买入的股票当日不能卖出，次日方可卖出
- 当日卖出股票所得资金，当日可用于买入
`;

const KB_BEHAVIOUR = `# 交易行为分析口径

## 北向资金
- 沪股通/深股通当日净买入额 = 买入成交额 - 卖出成交额
- 历史数据自 2014-11-17（沪港通开通）起可用

## 龙虎榜
- 上榜条件：日价格涨幅偏离值 ±7%、换手率 20%、振幅 15% 等
- 席位类型：机构专用、沪股通/深股通专用、券商营业部
- 机构专用席位净买入占比是常用情绪指标
`;

describe("方案一 · 知识库创建/查询/维护（真机 GLM）", () => {
  let backend: LiveBackend;
  let jwt: string;

  beforeAll(async () => {
    if (!liveEnabled()) return;
    backend = await startLiveBackend("kb");

    // 既有知识库 agent：kb-keeper（挂只读 A 股知识库目录，真实 KB 文件）。
    // 扩展目录已改版为相对路径：知识库落属主工作区内（锚点 = user.homeDir）
    const kbRoot = join(backend.userHome, "kb");
    const _keeper = await backend.agentStore.create({
      ownerId: backend.user.id,
      name: "kb-keeper",
      description: "A 股交易知识库查询",
      systemPrompt:
        "你是 A 股交易知识库管理员。仅依据知识库目录中的文件回答问题，回答需注明依据的条目。",
      skills: ["kb-query-execute"],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      extensionDirectories: [
        {
          id: "kb-a-share",
          name: "A股知识库",
          path: "kb/a-share",
          access: "readOnly",
        },
      ],
      llm: {},
    });
    mkdirSync(join(kbRoot, "a-share"), { recursive: true });
    writeFileSync(join(kbRoot, "a-share", "价格与交易规则.md"), KB_RULES, "utf8");
    writeFileSync(join(kbRoot, "a-share", "交易行为分析口径.md"), KB_BEHAVIOUR, "utf8");

    const boot = createApi(backend.baseUrl, "");
    jwt = (await boot.exchange(CLI_TOKEN)).token;
  });

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  it("缺口发现 → Agent Builder 对话式补建 → 重发任务路由闭环", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt);

    // ① 明显超出登记表能力的分析任务 → dispatcher 判 none → 转入 Agent Builder
    const task =
      "基于全市场逐笔成交数据做游资席位关联网络分析，输出席位协同图谱（这是知识库查询做不了的分析类任务）";
    cli.type(task);
    await cli.see("已转入 Agent Builder", 120_000);

    // ② 给出创建规格，驱动真实平台工具（authoring 门逐张确认）
    cli.type(
      "不用再确认，按以下规格直接创建，创建完成后立即收尾：" +
        "技能名 behaviour-analysis-execute（职责：北向资金与龙虎榜的交易行为分析执行）；" +
        "智能体名 behaviour-analyst（描述：交易行为分析）；" +
        "登记职责：北向资金与龙虎榜交易行为分析，适用任务类型：行为分析。",
    );
    await cli.see("🔔", 300_000);
    await cli.approveAll("已解除绑定");

    // ③ 事实断言：智能体是真实变更（入库即自动进入分发登记表）
    const agents = (await backend.api.call("GET", "/api/agents")) as Array<{
      name: string;
      description?: string;
    }>;
    const created = agents.find((a) => a.name === "behaviour-analyst");
    expect(created).toBeDefined();
    expect(created?.description).toContain("北向资金");

    // ④ 同会话重发原任务 → dispatcher 路由到新智能体 → 真实执行 → done
    cli.type(task);
    await cli.seeAny(["📨 已分派给", "🧩", "❌"], 300_000);
    await cli.see("✅ 完成", 600_000);
    await cli.exit();
  }, 900_000);

  it("知识库查询：路由到 kb-keeper 并依据知识库回答", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt);

    cli.type("查询：ST 股票的涨跌停幅度是多少？和主板有什么区别？");
    await cli.seeAny(["📨 已分派给", "🧩", "❌"], 300_000);
    await cli.see("✅ 完成", 600_000);
    // 事实断言：回答必须落在知识库文件既有内容上（ST ±5% / 主板 ±10%）
    expect(cli.out).toMatch(/5%/);
    expect(cli.out).toMatch(/10%/);
    await cli.exit();
  }, 900_000);

  it("知识库维护：单轮完成且 kb-keeper 仍在册可路由", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt);

    // 维护类任务：整理知识库变更摘要（kb-keeper 职责内）。
    cli.type("把交易行为分析口径整理成一页摘要，补充机构席位净买入的用法说明");
    await cli.seeAny(["📨 已分派给", "🧩", "❌"], 300_000);
    await cli.see("✅", 600_000);
    await cli.exit();

    // 任务层面的事实断言：至少一个 done 任务，且 kb-keeper 仍在册（可继续被路由）
    const tasks = (await backend.api.call("GET", "/api/tasks?status=done")) as Array<{
      prompt: string;
    }>;
    expect(tasks.length).toBeGreaterThan(0);
    const agents = (await backend.api.call("GET", "/api/agents")) as Array<{ name: string }>;
    expect(agents.some((a) => a.name === "kb-keeper")).toBe(true);
  }, 900_000);
});
