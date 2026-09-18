/**
 * donger-git v2 真机冒烟：验证 CLI 通道（clone/pull）、API 通道（元数据/读文件）、
 * 写链路（建仓 + push，需 --write）在真实平台网络上的端到端行为。
 *
 * 凭证：从运行库凭证桥按当前已配置值现取（与线上执行同链路）；任何步骤都不打印 token。
 * 平台范围：jihulab 用运行库已配置的 git 类 PAT + 已绑定仓库；github/gitee 走公共仓库
 *（无 PAT 时仅验匿名只读链路）。
 *
 * 用法：npx tsx scripts/smoke-git-tools.ts [--write]
 *   缺省只读（clone/ls-remote/API 读）；--write 追加建仓 + push（在 jihulab 当前用户
 *   命名空间下创建 donger-smoke-<ts> 仓库，可验证后在平台网页删除）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteCredentialSetStore } from "../src/adapters/sqlite-credential-set-store.js";
import type { Agent } from "../src/domain/agent.js";
import type { User } from "../src/domain/user.js";
import {
  type GitPlatformToolsDeps,
  gitPlatformToolDefinitions,
} from "../src/orchestrator/git-platform-tools.js";
import { gitWorkspaceToolDefinitions } from "../src/orchestrator/git-workspace-tools.js";
import type { CredentialSetStore } from "../src/ports/credential-set-store.js";
import { loadOrGenerateAppSecret } from "../src/util/app-secret.js";
import { runGit } from "../src/util/git-process.js";

const writeMode = process.argv.includes("--write");
const DB_PATH = join(homedir(), ".donger", "donger.db");
const results: Array<{ step: string; ok: boolean; note: string }> = [];

function report(step: string, ok: boolean, note = ""): void {
  results.push({ step, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${step}${note ? ` — ${note}` : ""}`);
}

const db = new Database(DB_PATH, { readonly: true });
db.pragma("journal_mode = WAL");
const credentialSets = new SqliteCredentialSetStore(
  db,
  loadOrGenerateAppSecret(db, "skill_secret_key"),
) as unknown as CredentialSetStore;

const reposRoot = mkdtempSync(join(tmpdir(), "donger-smoke-repos-"));

/** 运行库已配置的凭证（code → 属主 userId；工具按访问者解析，须用真实 userId 现取值） */
const credRows = db
  .prepare("SELECT DISTINCT code, userId FROM user_credential_values")
  .all() as Array<{ code: string; userId: string }>;
const configuredCodes = credRows.map((r) => r.code);
const ownerByCode = new Map(credRows.map((r) => [r.code, r.userId]));

const user: User = {
  id: ownerByCode.get("jihulab-pat") ?? credRows[0]?.userId ?? "smoke",
  name: "smoke",
  role: "user",
  homeDir: reposRoot,
  createdAt: "t",
  updatedAt: "t",
};

// ---------- 步骤 1：CLI 通道 · 公共仓库 clone（github，匿名） ----------
{
  const agent = {
    id: "smoke-a",
    ownerId: "smoke",
    name: "smoke",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [
      {
        id: "r-gh",
        name: "hello-world",
        provider: "github",
        url: "https://github.com/octocat/Hello-World.git",
        required: true,
        shallow: true,
        syncMode: "fastForward",
      },
    ],
    extensionDirectories: [],
    llm: {},
    version: 1,
    createdAt: "t",
    updatedAt: "t",
  } as unknown as Agent;
  const tools = gitWorkspaceToolDefinitions({ user, agent, reposRoot } as GitPlatformToolsDeps);
  const clone = tools.find((t) => t.name === "git_clone");
  const status = tools.find((t) => t.name === "git_status");
  const r = (await clone?.handler({ repoName: "hello-world" })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  report(
    "CLI · github 公共仓库 git_clone",
    !r.isError,
    r.isError ? r.content[0]?.text.slice(0, 120) : r.content[0]?.text.slice(0, 80),
  );
  const s = (await status?.handler({ repoName: "hello-world" })) as typeof r;
  report(
    "CLI · git_status 读取工作区",
    !s.isError,
    s.isError ? s.content[0]?.text.slice(0, 120) : s.content[0]?.text.slice(0, 80),
  );
}

// ---------- jihulab 链路（用运行库 jihulab-pat，若有） ----------
const JH_REPO = { name: "aix-py", url: "https://jihulab.com/your-org/your-project.git" };
const hasJihulabPat = configuredCodes.includes("jihulab-pat");
if (hasJihulabPat) {
  const agent = {
    id: "smoke-a",
    ownerId: "smoke",
    name: "smoke",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: ["jihulab-pat"],
    gitRepositories: [
      {
        id: "r-jh",
        name: JH_REPO.name,
        provider: "jihulab",
        url: JH_REPO.url,
        required: true,
        shallow: true,
        syncMode: "fastForward",
        credentialCode: "jihulab-pat",
      },
    ],
    extensionDirectories: [],
    llm: {},
    version: 1,
    createdAt: "t",
    updatedAt: "t",
  } as unknown as Agent;
  const deps: GitPlatformToolsDeps = { user, agent, credentialSets, reposRoot };
  const ws = gitWorkspaceToolDefinitions(deps);
  const api = undefined as unknown as object;

  // CLI · 私有仓库 clone（AskPass 真实认证）
  const clone = ws.find((t) => t.name === "git_clone");
  const r = (await clone?.handler({ repoName: JH_REPO.name })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  report(
    "CLI · jihulab 私有仓库 git_clone（AskPass）",
    !r.isError,
    r.isError ? r.content[0]?.text.slice(0, 120) : r.content[0]?.text.slice(0, 80),
  );

  // API · 元数据（真实 PRIVATE-TOKEN 调用）
  const server = gitPlatformToolDefinitions(deps);
  void api;
  const listBranches = server.find((t) => t.name === "git_platform_list_branches");
  const lb = listBranches ? await listBranches.handler({ repoName: JH_REPO.name }) : undefined;
  report(
    "API · jihulab git_platform_list_branches",
    lb ? !lb.isError : false,
    lb?.isError ? lb.content[0]?.text.slice(0, 120) : "分支列表取得",
  );

  const raw = server.find((t) => t.name === "git_platform_get_file_raw");
  const rf = raw ? await raw.handler({ repoName: JH_REPO.name, filePath: "README.md" }) : undefined;
  report(
    "API · jihulab git_platform_get_file_raw",
    rf ? !rf.isError : false,
    rf?.isError ? rf.content[0]?.text.slice(0, 120) : "文件读取成功（未强求 README 存在）",
  );

  // 写链路（--write）：建仓 → 本地 commit → push
  if (writeMode) {
    const repoName = `donger-smoke-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    const create = server.find((t) => t.name === "git_create_repo");
    const cr = create
      ? await create.handler({ provider: "jihulab", name: repoName, private: true })
      : undefined;
    const createOk = cr ? !cr.isError : false;
    report(
      "写 · jihulab git_create_repo",
      createOk,
      createOk ? `已创建 ${repoName}（可验证后在平台删除）` : cr?.content[0]?.text.slice(0, 140),
    );
    if (createOk) {
      // 本地造库：init + commit（donger-agent 身份与工具一致）
      const dir = join(reposRoot, repoName);
      await runGit(["init", "-b", "main", dir]);
      writeFileSync(join(dir, "SMOKE.md"), `donger git 工具冒烟 ${new Date().toISOString()}\n`);
      await runGit(["-C", dir, "add", "-A"]);
      await runGit([
        "-C",
        dir,
        "-c",
        "user.name=donger-agent",
        "-c",
        "user.email=agent@donger.local",
        "commit",
        "-m",
        "chore: donger-git smoke",
      ]);
      // 绑定新建仓库后再用 git_push 工具推（完整 handler 链路）
      const pushAgent = {
        ...agent,
        gitRepositories: [
          ...agent.gitRepositories,
          {
            id: "r-jh-new",
            name: repoName,
            provider: "jihulab",
            url: `https://jihulab.com/your-org/${repoName}.git`,
            required: true,
            shallow: true,
            syncMode: "fastForward",
            credentialCode: "jihulab-pat",
          },
        ],
      } as Agent;
      const pushTools = gitWorkspaceToolDefinitions({
        user,
        agent: pushAgent,
        credentialSets,
        reposRoot,
      } as GitPlatformToolsDeps);
      const push = pushTools.find((t) => t.name === "git_push");
      const pr = (await push?.handler({ repoName, branch: "main" })) as typeof r;
      report(
        "写 · jihulab git_push（AskPass）",
        !pr.isError,
        pr.isError ? pr.content[0]?.text.slice(0, 140) : "已推送 main",
      );
    }
  } else {
    console.log("（跳过写链路：加 --write 执行建仓 + push 冒烟）");
  }
} else {
  report("jihulab 链路", false, "运行库未配置 jihulab-pat 凭证值，跳过");
}

console.log(
  `\n冒烟完成：${results.filter((r) => r.ok).length}/${results.length} 通过。仓库工作区：${reposRoot}`,
);
if (!writeMode) console.log("提示：写链路（建仓+push）未执行，需要时加 --write。");

if (existsSync(reposRoot) && process.argv.includes("--clean")) {
  rmSync(reposRoot, { recursive: true, force: true });
}
