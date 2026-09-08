import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createApi, type DongerApi } from "../../../cli/src/api.js";
import { ClaudeAgentRunner } from "../../../src/adapters/claude-agent-runner.js";
import { JwtSessionStore } from "../../../src/adapters/jwt-session-store.js";
import { LocalSkillInstaller } from "../../../src/adapters/local-skill-installer.js";
import { SqliteAgentShareStore } from "../../../src/adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "../../../src/adapters/sqlite-agent-store.js";
import { SqliteAuditStore } from "../../../src/adapters/sqlite-audit-store.js";
import { SqliteCommentStore } from "../../../src/adapters/sqlite-comment-store.js";
import { SqliteConversationStore } from "../../../src/adapters/sqlite-conversation-store.js";
import { SqliteCredentialStore } from "../../../src/adapters/sqlite-credential-store.js";
import { SqliteMessageStore } from "../../../src/adapters/sqlite-message-store.js";
import { SqliteSkillPackStore } from "../../../src/adapters/sqlite-skill-pack-store.js";
import { SqliteTaskStore } from "../../../src/adapters/sqlite-task-store.js";
import { SqliteTranscriptStore } from "../../../src/adapters/sqlite-transcript-store.js";
import { SqliteUsageStore } from "../../../src/adapters/sqlite-usage-store.js";
import { SqliteUserStore } from "../../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../../src/adapters/web-channel.js";
import { loadConfig } from "../../../src/config.js";
import type { Agent } from "../../../src/domain/agent.js";
import { appendDispatcherAgentRow } from "../../../src/domain/dispatcher-registry.js";
import type { User } from "../../../src/domain/user.js";
import { createDefaultGates } from "../../../src/orchestrator/default-gates.js";
import { ensureDispatcherKb } from "../../../src/orchestrator/dispatch-kb.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../../src/orchestrator/runtime-manager.js";
import { loadOrGenerateAppSecret } from "../../../src/util/app-secret.js";
import { createSecretCipher } from "../../../src/util/secret-cipher.js";
import { ensureRuntimeDir } from "../../../src/util/workspace.js";

export const CLI_TOKEN = "e2e-live-cli-token";

/** 真机门控：显式 E2E_LIVE=1 且 LLM 配置完整（.env 提供密钥）才运行；配置缺失优雅跳过 */
export function liveEnabled(): boolean {
  if (process.env.E2E_LIVE !== "1") return false;
  try {
    return !!loadConfig(process.env).llm.authToken;
  } catch {
    return false; // LLM 配置不完整（如缺 ANTHROPIC_AUTH_TOKEN）→ 非真机环境，跳过
  }
}

export interface GitFixture {
  /** 仓库工作区绝对路径（= agent cwd，V16 共享工作区） */
  repoDir: string;
  /** 初始化提交数 */
  commits: number;
}

export interface LiveBackend {
  baseUrl: string;
  api: DongerApi;
  user: User;
  dir: string;
  kbDir: string;
  channel: WebChannel;
  agentStore: SqliteAgentStore;
  installer: LocalSkillInstaller;
  userHome: string;
  stop: () => Promise<void>;
}

export interface StartLiveOptions {
  /** 方案名（临时目录前缀与 kb 子目录隔离用） */
  scheme: string;
}

/**
 * 真机后端装配：真实 ClaudeAgentRunner（GLM）+ 真实 SQLite/HTTP/SSE + 真实 kb 知识库。
 * 不含任何脚本 runner——所有任务由真实 LLM 驱动，测试只断言事实（状态/产物/登记表/提交）。
 */
export async function startLiveBackend(scheme: string): Promise<LiveBackend> {
  const dir = mkdtempSync(join(tmpdir(), `donger-live-${scheme}-`));
  const db = new Database(":memory:");
  const store = new SqliteTaskStore(db);
  store.migrate();
  const usersDir = join(dir, "users");
  mkdirSync(usersDir, { recursive: true });
  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  const usageStore = new SqliteUsageStore(db);
  usageStore.migrate();
  const auditStore = new SqliteAuditStore(db);
  auditStore.migrate();
  const commentStore = new SqliteCommentStore(db);
  commentStore.migrate();
  const transcriptStore = new SqliteTranscriptStore(db);
  transcriptStore.migrate();
  const sessionStore = new JwtSessionStore(db, `live-jwt-${scheme}`, 24 * 60 * 60 * 1000);
  sessionStore.migrate();
  const skillPackStore = new SqliteSkillPackStore(db);
  skillPackStore.migrate();
  const credentialStore = new SqliteCredentialStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialStore.migrate();
  const agentStore = new SqliteAgentStore(db, createSecretCipher(`live-seed-${scheme}`));
  agentStore.migrate();
  const agentShareStore = new SqliteAgentShareStore(db);
  agentShareStore.migrate();

  const user = await userStore.getOrCreateByIdentity("internal", "cli-admin", "cli-admin");

  const kbDir = join(dir, "kb");
  ensureDispatcherKb(kbDir);

  const installer = new LocalSkillInstaller({
    packStore: skillPackStore,
    getHomeDir: (uid) => join(usersDir, uid),
  });
  const cfg = loadConfig(process.env);
  const runtimeMgr = new RuntimeManager({
    transcriptStore,
    conversationStore,
    config: {
      workspaceDir: dir,
      llm: cfg.llm,
      defaultSystemPromptAppend: "",
      agentLlmPresets: [],
    },
    skillPackStore,
    credentialStore,
    installer,
    builtinSkillsDir: "",
  });

  const channel = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: dir,
    taskStore: store,
    userStore,
    conversationStore,
    messageStore,
    usageStore,
    auditStore,
    commentStore,
    sessionStore,
    cliToken: CLI_TOKEN,
    agentStore,
    agentShareStore,
  });
  const orch = new Orchestrator({
    store,
    userStore,
    conversationStore,
    messageStore,
    usageStore,
    auditStore,
    commentStore,
    gates: createDefaultGates(),
    runner: new ClaudeAgentRunner(createDefaultGates()),
    channel,
    runtimeMgr,
    credentialStore,
    agentStore,
    agentShareStore,
    kbDir,
    installer,
    skillPackStore,
  });
  channel.onMessage((m) => void orch.handleMessage(m));
  channel.onCancel((conversationId) => orch.cancelConversation(conversationId));
  await channel.ready();

  const baseUrl = `http://127.0.0.1:${channel.boundPort}`;
  const boot = createApi(baseUrl, "");
  const { token } = await boot.exchange(CLI_TOKEN);
  const api = createApi(baseUrl, token);

  return {
    baseUrl,
    api,
    user,
    dir,
    kbDir,
    channel,
    agentStore,
    installer,
    userHome: user.homeDir,
    stop: async () => {
      await Promise.race([channel.stop(), new Promise((r) => setTimeout(r, 3000))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 向分发登记表追加一行（真实写 kb/dispatcher/agents.md） */
export function registerAgent(
  kbDir: string,
  row: { agentId: string; name: string; duty: string; skills: string[]; taskTypes: string },
): void {
  const file = join(kbDir, "dispatcher", "agents.md");
  writeFileSync(file, appendDispatcherAgentRow(readFileSync(file, "utf8"), row), "utf8");
}

/** 在 agent 共享工作区（V16）初始化一个真实 git 仓库；E2E_GIT_REMOTE 存在时挂为 origin */
export function initAgentRepo(
  userHome: string,
  agentId: string,
  files: Record<string, string>,
  commitMsg: string,
): GitFixture {
  const repoDir = ensureRuntimeDir(userHome, "agents", agentId, "workspace");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
  };
  git("init");
  git("checkout", "-b", "main");
  git("config", "user.email", "e2e@donger.local");
  git("config", "user.name", "donger-e2e");
  for (const [rel, content] of Object.entries(files)) {
    const p = join(repoDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  git("add", ".");
  git("commit", "-m", commitMsg);
  const remote = process.env.E2E_GIT_REMOTE;
  if (remote) git("remote", "add", "origin", remote);
  return { repoDir, commits: 1 };
}

/** 在仓库工作区执行命令（真实执行，参数数组不经 shell；非零退出不抛，返回完整结果） */
export function runIn(
  cwd: string,
  cmd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout: String(stdout ?? ""), stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message: string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
    };
  }
}

/** git 提交数（产物延续/演进的断言依据） */
export function gitCommitCount(repoDir: string): number {
  const out = execFileSync("git", ["-C", repoDir, "rev-list", "--count", "HEAD"], {
    encoding: "utf8",
  });
  return Number.parseInt(out.trim(), 10);
}
