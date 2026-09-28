import type { AgentInput } from "../../lib/agents";

/** 编辑器表单类型（与后端 AgentInput 同构） */
export type AgentEditorForm = AgentInput;

export const emptyAgent: AgentEditorForm = {
  name: "",
  description: "",
  systemPrompt: "",
  skills: [],
  defaultSkill: undefined,
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  connectorIds: [],
  credentials: [],
  gitRepositories: [],
  extensionDirectories: [],
  scenario: undefined,
  gitAllowShellGit: false,
  defaultPermissionMode: "ask_before_change",
  conversationScope: { enabled: false, agentIds: [] },
  knowledgeBaseIds: [],
  kbAutoLearn: false,
  feedbackScope: { enabled: false },
};

/**
 * 分区定义（锚点导航 + scrollspy 共用）。
 * agent-sec-runtime（运行管理）为即时态面板（回调/分享/管家，点按即生效、不走保存），
 * 仅编辑态挂载；新建态导航需跳过它（与表单分区区分，spec §4）。
 */
export const AGENT_EDITOR_SECTIONS = [
  { id: "agent-sec-basic", no: "1", label: "基本" },
  { id: "agent-sec-prompt", no: "2", label: "提示词与技能" },
  { id: "agent-sec-tools", no: "3", label: "工具与权限" },
  { id: "agent-sec-resources", no: "4", label: "资源" },
  { id: "agent-sec-kb", no: "5", label: "知识库与上下文" },
  { id: "agent-sec-runtime", no: "6", label: "运行管理" },
] as const;

export type SectionId = (typeof AGENT_EDITOR_SECTIONS)[number]["id"];

export interface ScenarioIssue {
  section: Extract<SectionId, "agent-sec-basic" | "agent-sec-tools" | "agent-sec-resources">;
  message: string;
}

/**
 * 场景装配校验前置（与后端装配规则同源：code-dev 需 git 仓库；kb-qa 要求只读白名单；
 * research 需含 kb_write）。返回分区定位的警示列表——保存前在本区 inline 提示 +
 * 锚点导航徽标计数；不阻断保存（与后端 warnings 不阻断语义一致）。
 */
export function scenarioIssues(form: AgentEditorForm): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  if (form.scenario === "code-dev" && form.gitRepositories.length === 0) {
    issues.push({
      section: "agent-sec-basic",
      message: "code-dev 需绑定至少 1 个 Git 仓库（当前 0 个）",
    });
  }
  if (form.scenario === "kb-qa" && form.tools.mode === "all") {
    issues.push({
      section: "agent-sec-tools",
      message: "kb-qa 要求只读工具白名单（当前为全部工具）",
    });
  }
  if (
    form.scenario === "research" &&
    form.tools.mode === "whitelist" &&
    !form.tools.whitelist.includes("kb_write")
  ) {
    issues.push({
      section: "agent-sec-tools",
      message: "research 需在白名单中包含 kb_write 工具",
    });
  }
  return issues;
}

/** 仓库目录名约束（与后端 src/domain/git.ts AgentGitRepositorySchema 同源） */
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * 保存阻断项 live 校验（spec §5 要点3）：内联 MCP JSON 解析错 + 仓库目录名非法。
 * 与 scenarioIssues 同构（分区定位），但语义是「不修就存不了」——导航徽标红色计数，
 * 编辑中即时更新；保存时的阻断校验仍以 AgentEditorPage.save 为准。
 * 全空的新增仓库卡（未填 name/url）不算错，避免刚点「添加仓库」就见红。
 */
export function blockingIssues(
  form: AgentEditorForm,
  mcpJsonError: string | null,
): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  if (mcpJsonError) {
    issues.push({
      section: "agent-sec-tools",
      message: `内联 MCP JSON 解析失败：${mcpJsonError}`,
    });
  }
  for (const r of form.gitRepositories) {
    if (r.name || r.url) {
      if (!REPO_NAME_PATTERN.test(r.name)) {
        issues.push({
          section: "agent-sec-resources",
          message: `仓库目录名「${r.name || "（空）"}」不合法：需以字母/数字开头，仅含字母数字 . _ -，长度 1-64`,
        });
      }
    }
  }
  return issues;
}

/** 从 URL 推断平台（host 精确匹配三平台；非 HTTPS/未知域名返回 undefined） */
export function inferProviderFromUrl(url: string): "github" | "gitee" | "jihulab" | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.toLowerCase();
    if (host === "github.com") return "github";
    if (host === "gitee.com") return "gitee";
    if (host === "jihulab.com") return "jihulab";
    return undefined;
  } catch {
    return undefined;
  }
}

/** 从 URL 路径尾段推断默认目录名（非法字符转 -、掐掉头部符号；解析失败返回空串） */
export function inferRepoNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean)
      .pop();
    return last?.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[._-]+/, "") ?? "";
  } catch {
    return "";
  }
}

/** 平台中文短标签（Git 卡收起态徽标用） */
export const PROVIDER_LABELS: Record<
  AgentEditorForm["gitRepositories"][number]["provider"],
  string
> = {
  github: "GitHub（含 GHE）",
  gitee: "Gitee（含私有化）",
  jihulab: "GitLab 兼容（极狐/自建）",
};
