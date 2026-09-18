// 场景词表与预设（代码常量；规格 docs/superpowers/specs/2026-09-08-scenario-presets-design.md §2.1）。
// 场景标签（dispatcher taskTypes 受控词表）与预设一一映射：路由（dispatcher）、装配（builder）、
// 校验（gates）三处共用同一词表；新增场景 = 加一条 preset + 补校验分支。

import type { Agent } from "./agent.js";

export const SCENARIO_KEYS = ["code-dev", "kb-qa", "research", "ops"] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export function isScenarioKey(value: string): value is ScenarioKey {
  return (SCENARIO_KEYS as readonly string[]).includes(value);
}

export interface PresetWarning {
  presetKey: ScenarioKey;
  rule: string;
  message: string;
}

export interface ScenarioPreset {
  key: ScenarioKey;
  name: string;
  /** 何时选这个场景（builder 识别与 dispatcher 登记共用） */
  duty: string;
  /** 推荐白名单（builder 起草 tools.mode=whitelist 时的推荐勾选） */
  recommendedTools: { whitelist: string[] };
  /** systemPrompt 骨架要点（builder 起草时拼入） */
  promptSkeleton: string;
}

/** donger-kb 只读三件（kb-qa 场景的最低检索装备） */
export const KB_READ_TOOLS = [
  "mcp__donger-kb__kb_list",
  "mcp__donger-kb__kb_read",
  "mcp__donger-kb__kb_search",
] as const;

export const SCENARIO_PRESETS: Record<ScenarioKey, ScenarioPreset> = {
  "code-dev": {
    key: "code-dev",
    name: "代码项目开发运维",
    duty: "代码分析、问题定位、分支/提交审查、构建部署建议；需绑定 git 仓库，私有仓库配凭证模板",
    recommendedTools: {
      whitelist: ["mcp__donger-git", "mcp__donger-kb__kb_read", "mcp__donger-kb__kb_search"],
    },
    promptSkeleton:
      "只读优先：分析任务不修改代码；确需修改先说明计划征得同意；高危操作（deploy/push）须经用户确认，不主动执行。",
  },
  "kb-qa": {
    key: "kb-qa",
    name: "知识库问答",
    duty: "基于业务知识库的检索问答；只读，回答须带 文件:行号 引用",
    recommendedTools: { whitelist: [...KB_READ_TOOLS] },
    promptSkeleton:
      "只读场景：不修改任何文件；回答引用知识库文件路径与行号，检索不到就明说，不编造。",
  },
  research: {
    key: "research",
    name: "调研分析",
    duty: "多源检索与调研分析，结论沉淀回业务知识库（写入内容须标注来源与日期）",
    recommendedTools: {
      whitelist: [...KB_READ_TOOLS, "mcp__donger-kb__kb_write", "WebSearch", "WebFetch"],
    },
    promptSkeleton:
      "调研结论必须交叉验证并标注来源；沉淀到知识库的内容写明主题、来源与日期，便于后续问答场景引用。",
  },
  ops: {
    key: "ops",
    name: "运维操作",
    duty: "面向运行中系统的日志/监控/部署操作；高危操作须经审批，凭证走凭证集注入",
    recommendedTools: { whitelist: [] },
    promptSkeleton:
      "高危操作（deploy/restart/删除）须经用户确认并通过审批门，不主动执行；凭证从环境变量读取，不写死。",
  },
};

/** taskTypes 登记值解析：逗号/顿号/空白分隔，逐段校验是否合法场景 key */
export function parseTaskTypes(
  text: string,
): { ok: true; keys: ScenarioKey[] } | { ok: false; invalid: string[] } {
  const parts = text
    .split(/[、,，;；|/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keys: ScenarioKey[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (isScenarioKey(part)) {
      if (!keys.includes(part)) keys.push(part);
    } else {
      invalid.push(part);
    }
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, keys };
}

/** 存量自由文本 taskTypes 的 best-effort 映射（不自动改写，供重登记时提示） */
const MIGRATE_KEYWORDS: Array<[RegExp, ScenarioKey]> = [
  [/(代码|git|仓库|repo|编译|构建|提交|分支)/i, "code-dev"],
  [/(知识|文档|问答|faq|wiki|手册)/i, "kb-qa"],
  [/(调研|分析|研究|洞察|报告)/i, "research"],
  [/(运维|部署|日志|监控|发布|sls)/i, "ops"],
];

export function migrateTaskTypes(text: string): ScenarioKey[] {
  const keys: ScenarioKey[] = [];
  for (const [pattern, key] of MIGRATE_KEYWORDS) {
    if (pattern.test(text) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

const WRITE_TOOLS = ["Bash", "Write", "Edit"];

/** 场景完整性校验（warning 级，不阻断）。agent 未标 scenario 时不校验。 */
export function validateAgentAgainstPreset(agent: Agent): PresetWarning[] {
  const scenario = agent.scenario;
  if (!scenario) return [];
  const warnings: PresetWarning[] = [];
  const warn = (rule: string, message: string) =>
    warnings.push({ presetKey: scenario, rule, message });
  const whitelist = new Set(agent.tools.whitelist);

  switch (scenario) {
    case "code-dev": {
      if (agent.gitRepositories.length < 1) {
        warn("git-repos", "code-dev 场景要求至少绑定一个 git 仓库");
      }
      for (const repo of agent.gitRepositories) {
        if (!repo.credentialCode) {
          warn(
            "credential-code",
            `仓库 ${repo.name} 未指定 credentialCode，私有仓库将回退 OAuth 连接或触发问询`,
          );
        }
      }
      if (agent.tools.mode !== "whitelist") {
        warn("tools-whitelist", "建议 tools 用 whitelist 收敛（只读类任务不要全开）");
      }
      break;
    }
    case "kb-qa": {
      if (agent.tools.mode !== "whitelist") {
        warn(
          "tools-whitelist",
          "只读场景必须用 whitelist（mode=all 会放开 Bash，绕过知识库只读边界）",
        );
      }
      for (const tool of WRITE_TOOLS) {
        if (whitelist.has(tool)) warn("read-only", `只读场景白名单不应含 ${tool}`);
      }
      for (const tool of KB_READ_TOOLS) {
        if (!whitelist.has(tool)) warn("kb-tools", `缺少知识库检索工具 ${tool}`);
      }
      break;
    }
    case "research": {
      if (agent.tools.mode !== "whitelist") {
        warn("tools-whitelist", "建议 tools 用 whitelist 收敛");
      }
      if (agent.tools.mode === "whitelist" && !whitelist.has("mcp__donger-kb__kb_write")) {
        warn("kb-write", "调研场景需要 kb_write 才能把结论沉淀回知识库");
      }
      break;
    }
    case "ops": {
      if (agent.tools.mode !== "whitelist") {
        warn("tools-whitelist", "运维场景建议 whitelist 收敛，高危操作走审批门");
      }
      break;
    }
  }
  return warnings;
}
