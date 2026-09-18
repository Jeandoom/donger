/**
 * 存量迁移：git 仓库绑定的凭证模板标记 kind="git"（规格 2026-09-09-git-platform-tools-design.md §3.1）。
 *
 * 背景：git 类凭证（kind="git"）不再注入 SDK env——token 仅经凭证桥在 donger-git
 * 工具/仓库物化内现取，防止 agent 拿到 token 绕过工具直连平台。本脚本扫描所有
 * agent 定义里 gitRepositories[].credentialCode 引用的模板，把仍是 generic 的
 * 批量置为 git，使注入排除对存量数据生效。
 *
 * 默认 dry-run 只读报告；--fix 才改库。
 * 用法：npx tsx scripts/migrate-git-credential-kind.ts [--db <path>] [--fix]
 * 注意：避开服务运行时执行（直接开 WAL 写库）。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteCredentialSetStore } from "../src/adapters/sqlite-credential-set-store.js";
import { loadOrGenerateAppSecret } from "../src/util/app-secret.js";

const fixMode = process.argv.includes("--fix");
const DB_PATH = process.argv.includes("--db")
  ? (process.argv[process.argv.indexOf("--db") + 1] ?? "")
  : join(homedir(), ".donger", "donger.db");

if (!statSync(DB_PATH, { throwIfNoEntry: false })) {
  console.error(`数据库不存在: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
const store = new SqliteCredentialSetStore(db, loadOrGenerateAppSecret(db, "skill_secret_key"));
store.migrate();

/** agent data JSON 的最小读取视图：只需要 gitRepositories[].credentialCode */
interface AgentDatum {
  gitRepositories?: Array<{ credentialCode?: string }>;
}

const rows = db.prepare("SELECT id, data FROM agents").all() as Array<{
  id: string;
  data: string;
}>;

async function main(): Promise<void> {
  const referenced = new Map<string, Set<string>>(); // code → agentIds
  for (const row of rows) {
    let agent: AgentDatum;
    try {
      agent = JSON.parse(row.data) as AgentDatum;
    } catch {
      console.warn(`⚠️ agent ${row.id} data 非 JSON，跳过`);
      continue;
    }
    for (const repo of agent.gitRepositories ?? []) {
      if (!repo.credentialCode) continue;
      const ids = referenced.get(repo.credentialCode) ?? new Set<string>();
      ids.add(row.id);
      referenced.set(repo.credentialCode, ids);
    }
  }

  if (referenced.size === 0) {
    console.log("未发现任何 agent 绑定 git 凭证模板，无需迁移。");
    return;
  }

  let changed = 0;
  for (const [code, agentIds] of [...referenced.entries()].sort()) {
    const tpl = await store.getTemplate(code);
    if (!tpl) {
      console.log(`✗ 模板 ${code} 不存在（被 ${agentIds.size} 个 agent 引用），跳过`);
      continue;
    }
    if (tpl.kind === "git") {
      console.log(`= 模板 ${code} 已是 git，跳过`);
      continue;
    }
    console.log(
      `${fixMode ? "✔ 已标记" : "→ 将标记"} 模板 ${code}（${tpl.name}）generic→git，引用 agent: ${[...agentIds].join("、")}`,
    );
    if (fixMode) {
      await store.updateTemplate(code, { ...tpl, kind: "git" });
      changed += 1;
    }
  }

  console.log(
    fixMode
      ? `完成：${changed} 个模板已标记为 git。`
      : `dry-run 结束：${referenced.size} 个引用模板待处理；加 --fix 执行。`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
