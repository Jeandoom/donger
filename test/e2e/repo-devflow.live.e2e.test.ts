// 方案二 · 代码仓库的需求开发、测试、部署与 bug 解决（真机 E2E，主题：A 股交易数据与交易行为分析）
//
// 全程真实：真实 GLM 驱动三段式生命周期与工具调用；fixture 仓库真实 git init（可经
// E2E_GIT_REMOTE 挂远程）；Python 指标源码 + Node 测试真实执行（node --test 真跑 python 产物）；
// 部署走真实 deploy 门。断言只看事实：git 提交数、文件内容、测试通过、任务终态。
//
// 运行条件：E2E_LIVE=1 且 .env 提供 LLM 密钥；单场景耗时以分钟计。
//   set E2E_LIVE=1 && npx vitest run test/e2e/repo-devflow.live.e2e.test.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../../cli/src/api.js";
import { ChatDriver } from "./helpers/driver.js";
import {
  CLI_TOKEN,
  type GitFixture,
  gitCommitCount,
  initAgentRepo,
  type LiveBackend,
  liveEnabled,
  runIn,
  startLiveBackend,
} from "./helpers/live-backend.js";

vi.setConfig({ testTimeout: 1_200_000, hookTimeout: 120_000 });

// —— fixture 仓库源码（真实文件，写入 agent 共享工作区）——
const SAMPLE_CSV = `date,code,name,pct_chg,is_st
2024-01-02,600001,龙头A,10.01,0
2024-01-02,000001,ST中,5.02,1
2024-01-02,600002,炸板B,3.10,0
2024-01-03,600001,龙头A,10.00,0
2024-01-03,000001,ST中,5.01,1
2024-01-03,600002,炸板B,-1.20,0
2024-01-04,600001,龙头A,9.98,0
2024-01-04,000001,ST中,5.03,1
2024-01-04,600002,炸板B,0.50,0
`;

// v1 已知缺陷：LIMIT_PCT 固定 10%，ST（±5%）连板被漏统计——供 2.3 bugfix 场景修复
const LIMIT_UP_PY = `#!/usr/bin/env python3
"""涨停连板天梯统计（A 股日线数据）。

输入 CSV 列：date,code,name,pct_chg,is_st
输出 JSON：{"ladder": {"<date>": [{"code","name","streak"}...]}}（按 streak 降序）
"""
import argparse
import csv
import json
import sys

LIMIT_PCT = 10.0  # v1 缺陷：未区分 ST（±5%）

def is_limit_up(row):
    return float(row["pct_chg"]) >= LIMIT_PCT - 1e-9

def build_ladder(rows):
    streak = {}
    ladder = {}
    for row in sorted(rows, key=lambda r: (r["date"], r["code"])):
        code, d = row["code"], row["date"]
        streak[code] = streak.get(code, 0) + 1 if is_limit_up(row) else 0
        if streak[code] > 0:
            ladder.setdefault(d, []).append(
                {"code": code, "name": row["name"], "streak": streak[code]}
            )
    for entries in ladder.values():
        entries.sort(key=lambda x: -x["streak"])
    return {"ladder": ladder}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default="-")
    args = ap.parse_args()
    with open(args.input, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    text = json.dumps(build_ladder(rows), ensure_ascii=False, indent=2)
    if args.out == "-":
        sys.stdout.write(text)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)

if __name__ == "__main__":
    main()
`;

const TURNOVER_PY = `#!/usr/bin/env python3
"""换手率口径：换手率 = 成交量 / 流通股本 × 100%（行为分析基础指标）。"""

def turnover_rate(volume: float, float_shares: float) -> float:
    if float_shares <= 0:
        raise ValueError("流通股本必须为正")
    return volume / float_shares * 100
`;

const LADDER_TEST_MJS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function ladder() {
  const r = spawnSync("python", ["src/limit_up.py", "--input", "data/sample.csv"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("非 ST 连板：600001 第三日 3 连板", () => {
  const day3 = ladder().ladder["2024-01-04"] ?? [];
  assert.equal(day3.find((x) => x.code === "600001")?.streak, 3);
});

test("非 ST 炸板：600002 涨幅不足不入天梯", () => {
  const day1 = ladder().ladder["2024-01-02"] ?? [];
  assert.equal(day1.find((x) => x.code === "600002"), undefined);
});
`;

const DEPLOY_SH = `#!/usr/bin/env bash
set -e
echo "[deploy] 发布 A 股量化指标包"
git rev-parse HEAD > DEPLOYED.txt
echo "[deploy] done"
`;

const README = `# a-share-quant

A 股交易数据与交易行为分析工具集（E2E fixture 仓库）。
- src/limit_up.py 涨停连板天梯
- src/turnover.py 换手率口径
- tests/ Node 测试（node --test tests/，真跑 Python 产物）
`;

function skillMd(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

A 股量化仓库（a-share-quant）规范：
- 指标实现放 src/，Node 测试放 tests/（node --test tests/，测试真跑 Python 产物）
- 遵循既有代码风格；数据口径变更必须同步测试
`;
}

describe("方案二 · 代码仓库开发/测试/部署/bugfix（真机 GLM）", () => {
  let backend: LiveBackend;
  let jwt: string;
  let repo: GitFixture;
  let _quantDevId = "";

  beforeAll(async () => {
    if (!liveEnabled()) return;
    backend = await startLiveBackend("repo");

    // 三段式技能（真实安装为技能 pack）
    for (const [name, desc] of [
      ["indicator-dev-design", "连板/炸板等指标开发方案阶段"],
      ["indicator-dev-execute", "指标实现与测试执行阶段"],
      ["indicator-dev-accept", "指标验收自验阶段"],
    ] as const) {
      await backend.installer.installFromPaste(backend.user.id, {
        content: skillMd(name, desc),
        slug: name,
        name,
        description: desc,
      });
    }

    const dev = await backend.agentStore.create({
      ownerId: backend.user.id,
      name: "quant-dev",
      description: "A 股量化指标开发",
      systemPrompt:
        "你是 A 股量化仓库 a-share-quant 的开发者，仓库就在当前工作目录。" +
        "改动后必须运行 node --test tests/ 验证；部署执行 bash deploy.sh（会触发审批门）。数据口径：ST 股涨跌停 ±5%，主板 ±10%。",
      skills: ["indicator-dev-design", "indicator-dev-execute", "indicator-dev-accept"],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    _quantDevId = dev.id;

    // 真实 git init 到 agent 共享工作区（V16：跨任务/跨会话延续）；E2E_GIT_REMOTE 可挂远程
    repo = initAgentRepo(
      backend.userHome,
      dev.id,
      {
        "src/limit_up.py": LIMIT_UP_PY,
        "src/turnover.py": TURNOVER_PY,
        "data/sample.csv": SAMPLE_CSV,
        "tests/ladder.test.mjs": LADDER_TEST_MJS,
        "deploy.sh": DEPLOY_SH,
        "README.md": README,
      },
      "init: a-share-quant 基线（含 ST 连板统计缺陷）",
    );
    execFileSync("git", ["-C", repo.repoDir, "add", "-A"], { stdio: "pipe" });

    const boot = createApi(backend.baseUrl, "");
    jwt = (await boot.exchange(CLI_TOKEN)).token;
  });

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  it("需求开发 → 测试 → 部署（方案门/deploy 门/验收门全生命周期）", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    const before = gitCommitCount(repo.repoDir);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt);

    cli.type(
      "开发涨停连板天梯指标：实现放 src/limit_up.py（当前已有基础版），补齐 tests/ladder.test.mjs 并用 node --test tests/ 跑通，" +
        "全部通过后执行 bash deploy.sh 发布。",
    );
    await cli.seeAny(["📨 已分派给", "🧩", "❌"], 300_000);
    await cli.see("🔔 审批门：方案设计确认", 300_000); // requiresDesign 真实判定
    await cli.approveAll("✅ 完成", 12, 900_000); // deploy 门 / 验收门逐张批准

    // 事实断言：仓库真实演进 + 测试真实通过 + 部署产物真实存在
    expect(gitCommitCount(repo.repoDir)).toBeGreaterThan(before);
    const t = runIn(repo.repoDir, "node", ["--test", "tests/"]);
    expect(t.stdout).toContain("pass");
    expect(existsSync(join(repo.repoDir, "DEPLOYED.txt"))).toBe(true);
    await cli.exit();
  }, 1_200_000);

  it("跨任务产物延续：新会话同 agent 看得到上次的代码与部署产物（V16）", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    expect(existsSync(join(repo.repoDir, "DEPLOYED.txt"))).toBe(true); // 上一任务产物仍在共享工作区
    const before = gitCommitCount(repo.repoDir);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt); // 全新会话

    cli.type(
      "在现有连板天梯实现上增加炸板率统计（盘中触及涨停但收盘未封住的比例），补测试并 node --test tests/ 跑通。",
    );
    await cli.seeAny(["📨 已分派给", "🧩", "❌"], 300_000);
    await cli.approveAll("✅ 完成", 12, 900_000);

    const src = readFileSync(join(repo.repoDir, "src", "limit_up.py"), "utf8");
    expect(src).toMatch(/炸板/);
    expect(gitCommitCount(repo.repoDir)).toBeGreaterThan(before);
    await cli.exit();
  }, 1_200_000);

  it("bug 解决：ST ±5% 连板漏统计（修复 + 补测试，测试由缺陷到通过）", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    // 缺陷事实：v1 实现下 ST 连板不入天梯
    const buggy = runIn(repo.repoDir, "python", ["src/limit_up.py", "--input", "data/sample.csv"]);
    expect(buggy.stdout).not.toContain("000001");

    const before = gitCommitCount(repo.repoDir);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt);
    cli.type(
      "修复 bug：ST 股涨跌停是 ±5%，src/limit_up.py 目前按 ±10% 处理导致 ST 连板漏统计" +
        "（样例 000001 应为 2 连板）。修复实现并在 tests/ 补 ST 用例，node --test tests/ 全部通过。",
    );
    await cli.seeAny(["📨 已分派给", "🧩", "❌"], 300_000);
    await cli.approveAll("✅ 完成", 12, 900_000);

    // 事实断言：ST 连板进入天梯、全量测试通过、仓库真实演进
    const fixed = runIn(repo.repoDir, "python", ["src/limit_up.py", "--input", "data/sample.csv"]);
    const day2 = JSON.parse(fixed.stdout).ladder["2024-01-03"] as Array<{
      code: string;
      streak: number;
    }>;
    expect(day2.find((x) => x.code === "000001")?.streak).toBe(2);
    const t = runIn(repo.repoDir, "node", ["--test", "tests/"]);
    expect(t.stdout).toContain("pass");
    expect(gitCommitCount(repo.repoDir)).toBeGreaterThan(before);
    await cli.exit();
  }, 1_200_000);

  it("部署驳回：deploy 门拒绝后任务不得产出发布产物", async () => {
    if (!liveEnabled()) return expect(true).toBe(true);
    const deployed = join(repo.repoDir, "DEPLOYED.txt");
    if (existsSync(deployed)) unlinkSync(deployed);
    const cli = await ChatDriver.start(backend.api, backend.baseUrl, jwt);

    cli.type("执行 bash deploy.sh 发布最新指标包");
    await cli.see("🔔 审批门：部署/发布/推送操作审批", 300_000);
    cli.type("n");
    await cli.see("驳回原因", 60_000);
    cli.type("当前处于交易窗口期，禁止部署");

    // 真实 LLM 的收尾形态可能是失败或解释后完成——只断言"不再有新部署产物"这一事实
    const deadline = Date.now() + 600_000;
    for (;;) {
      if (cli.has("❌") || cli.has("✅ 完成")) break;
      if (Date.now() > deadline) {
        throw new Error(`部署驳回场景未收尾；输出尾部：\n${cli.tail()}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await cli.exit();
    expect(existsSync(deployed)).toBe(false);
  }, 1_200_000);
});
