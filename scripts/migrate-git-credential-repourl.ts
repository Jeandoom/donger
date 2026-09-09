/**
 * 存量迁移：git 凭证模板补仓库声明 repoUrl（规格 2026-09-10-git-credential-repo-binding §3.1）。
 *
 * 逻辑：扫描所有 agent 的 gitRepositories[].credentialCode 引用关系——
 *   - 模板恰好被一个归一化仓库地址引用 → 自动补 repoUrl（升级为仓库级凭证）；
 *   - 被多个不同地址引用 → 保持平台级（宽松语义）并报告；
 *   - 已声明 repoUrl → 跳过。
 *
 * 默认 dry-run 只读报告；--fix 才改库。幂等。
 * 用法：npx tsx scripts/migrate-git-credential-repourl.ts [--db <path>] [--fix]
 * 注意：避开服务运行时执行（直接开 WAL 写库）。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteCredentialSetStore } from "../src/adapters/sqlite-credential-set-store.js";
import { normalizeRepositoryIdentity } from "../src/domain/git.js";
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

interface AgentDatum {
  gitRepositories?: Array<{ url?: string; credentialCode?: string }>;
}

async function main(): Promise<void> {
  const rows = db.prepare("SELECT id, data FROM agents").all() as Array<{
    id: string;
    data: string;
  }>;
  // code → 引用它的归一化仓库地址集合
  const refs = new Map<string, Map<string, string>>(); // code → (identity → 示例 url)
  for (const row of rows) {
    let agent: AgentDatum;
    try {
      agent = JSON.parse(row.data) as AgentDatum;
    } catch {
      console.warn(`⚠️ agent ${row.id} data 非 JSON，跳过`);
      continue;
    }
    for (const repo of agent.gitRepositories ?? []) {
      if (!repo.credentialCode || !repo.url) continue;
      const identity = normalizeRepositoryIdentity(repo.url);
      if (!identity) continue;
      const byIdentity = refs.get(repo.credentialCode) ?? new Map<string, string>();
      if (!byIdentity.has(identity)) byIdentity.set(identity, repo.url);
      refs.set(repo.credentialCode, byIdentity);
    }
  }

  if (refs.size === 0) {
    console.log("未发现任何 git 凭证引用，无需迁移。");
    return;
  }

  let changed = 0;
  for (const [code, byIdentity] of [...refs.entries()].sort()) {
    const tpl = await store.getTemplate(code);
    if (!tpl) {
      console.log(`✗ 模板 ${code} 不存在，跳过`);
      continue;
    }
    if (tpl.kind !== "git") {
      console.log(`✗ 模板 ${code} 非 git 类（kind=${tpl.kind}），跳过`);
      continue;
    }
    if (tpl.repoUrl) {
      console.log(`= 模板 ${code} 已声明仓库 ${tpl.repoUrl}，跳过`);
      continue;
    }
    if (byIdentity.size === 0) continue;
    if (byIdentity.size > 1) {
      console.log(
        `→ 模板 ${code} 被 ${byIdentity.size} 个不同仓库引用，保持平台级（如需细化请拆分模板）：${[...byIdentity.values()].join("、")}`,
      );
      continue;
    }
    const repoUrl = [...byIdentity.values()][0] ?? "";
    console.log(`${fixMode ? "✔ 已补" : "→ 将补"} 模板 ${code} 的 repoUrl = ${repoUrl}`);
    if (fixMode) {
      await store.updateTemplate(code, { ...tpl, repoUrl });
      changed += 1;
    }
  }

  console.log(fixMode ? `完成：${changed} 个模板已补仓库声明。` : "dry-run 结束；加 --fix 执行。");
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
