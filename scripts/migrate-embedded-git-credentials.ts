/**
 * 存量迁移：git remote URL 明文嵌 token 清理（规格 2026-09-08-scenario-presets-design.md §2.8）。
 *
 * 背景：动态登记表之前，执行 agent 常自行 git clone，把 access token 明文嵌进
 * .git/config 的 remote URL（aix-py 实测）。本脚本扫描 <workspace>/users/* 下所有
 * .git/config，识别 `https://<user>:<token>@host/...` 形态，并：
 *   1. 确保对应凭证模板存在（缺则建 <provider>-pat，keySpecs [username, token]）
 *   2. 把 token 写入仓库属主用户的凭证值（整体加密，与平台注入一致）
 *   3. remote URL 改写为无凭证 HTTPS
 *   4. 输出 agent 绑定 patch JSON（由用户经 builder/web 应用到 agent 定义，脚本不直接改 agent）
 *
 * 默认 dry-run 只读报告；--fix 才执行 1-3。
 * 用法：npx tsx scripts/migrate-embedded-git-credentials.ts [--workspace <dir>] [--fix]
 * 注意：避开服务运行时执行（直接开 WAL 写库）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteCredentialSetStore } from "../src/adapters/sqlite-credential-set-store.js";
import { loadOrGenerateAppSecret } from "../src/util/app-secret.js";

const fixMode = process.argv.includes("--fix");
const wsIdx = process.argv.indexOf("--workspace");
const usersRoot =
  wsIdx > -1 ? (process.argv[wsIdx + 1] ?? "") : join(homedir(), ".donger", "workspace", "users");
const DB_PATH = process.argv.includes("--db")
  ? (process.argv[process.argv.indexOf("--db") + 1] ?? "")
  : join(homedir(), ".donger", "donger.db");

if (!statSync(usersRoot, { throwIfNoEntry: false })) {
  console.error(`工作区不存在: ${usersRoot}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
const store = new SqliteCredentialSetStore(db, loadOrGenerateAppSecret(db, "skill_secret_key"));
store.migrate();

const PROVIDER_BY_HOST: Record<string, "github" | "gitee" | "jihulab"> = {
  "github.com": "github",
  "gitee.com": "gitee",
  "jihulab.com": "jihulab",
};
const EMBED_RE = /url\s*=\s*https:\/\/([^:@/\s]+):([^@/\s]+)@([^\s/]+)/;
const mask = (token: string) =>
  token.length <= 6 ? "***" : `${token.slice(0, 4)}…${token.slice(-2)}`;

interface Finding {
  configPath: string;
  ownerUser: string;
  provider: "github" | "gitee" | "jihulab" | undefined;
  username: string;
  token: string;
  cleanUrl: string;
}

/** 深度受限地找 .git/config（跳过隐藏目录；单目录读失败跳过，Windows 长路径/权限不致命） */
function findGitConfigs(dir: string, depth: number): string[] {
  if (depth <= 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.includes("config")) {
    const candidate = join(dir, "config");
    try {
      if (statSync(candidate).isFile() && dir.endsWith(".git")) found.push(candidate);
    } catch {
      /* skip */
    }
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) found.push(...findGitConfigs(full, depth - 1));
  }
  // .git 目录本身是隐藏目录，上面 for 会跳过——单独补一层
  const gitDir = join(dir, ".git");
  try {
    if (statSync(gitDir).isDirectory()) found.push(...findGitConfigs(gitDir, 1));
  } catch {
    /* no .git here */
  }
  return found;
}

const findings: Finding[] = [];
let userDirs: string[] = [];
try {
  userDirs = readdirSync(usersRoot);
} catch (e) {
  console.error(`读取工作区失败: ${(e as Error).message}`);
  process.exit(1);
}

for (const user of userDirs) {
  for (const configPath of findGitConfigs(join(usersRoot, user), 7)) {
    let text: string;
    try {
      text = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    const match = text.match(EMBED_RE);
    if (!match) continue;
    const [, username, token, host] = match;
    findings.push({
      configPath,
      ownerUser: user,
      provider: PROVIDER_BY_HOST[host.toLowerCase()],
      username: username ?? "",
      token: token ?? "",
      cleanUrl: `https://${host}${text.split(EMBED_RE)[4] ?? ""}`.replace(/\s+$/, ""),
    });
  }
}

console.log(`扫描完成：${findings.length} 处明文凭证（工作区 ${usersRoot}）`);
for (const f of findings) {
  console.log(
    `- [${f.provider ?? "未知平台"}] ${f.configPath}\n    用户 ${f.ownerUser}  账号 ${f.username}  token ${mask(f.token)}`,
  );
}
if (findings.length === 0) process.exit(0);

if (!fixMode) {
  console.log("\ndry-run 结束（未做任何修改）。加 --fix 执行迁移。");
  process.exit(0);
}

const patches: unknown[] = [];
for (const f of findings) {
  if (!f.provider) {
    console.log(`跳过（未知平台，需人工处理）：${f.configPath}`);
    continue;
  }
  const code = `${f.provider}-pat`;
  let tpl = await store.getTemplate(code);
  if (!tpl) {
    await store.createTemplate(
      code,
      {
        name: `${f.provider} 个人访问令牌`,
        description: "由 migrate-embedded-git-credentials 脚本创建（存量 token 迁移）",
        keySpecs: [
          { key: "username", label: "HTTP 认证用户名（可留空走平台默认）" },
          { key: "token", label: "访问令牌" },
        ],
      },
      "migration-script",
    );
    console.log(`已建模板 ${code}`);
    tpl = await store.getTemplate(code);
  }
  if (!tpl) {
    console.log(`模板创建失败，跳过：${f.configPath}`);
    continue;
  }
  const values: Record<string, string> = { token: f.token };
  if (f.username) values.username = f.username;
  await store.upsertValue(f.ownerUser, code, values);
  // remote URL 改写：去凭证段（重读文件保留其余配置）
  const text = readFileSync(f.configPath, "utf8");
  const rewritten = text.replace(EMBED_RE, (_m, _u, _t, host) => `url = https://${host}`);
  writeFileSync(f.configPath, rewritten, "utf8");
  const rel = f.configPath.split(/users[\\/]/)[1] ?? f.configPath;
  patches.push({
    ownerUser: f.ownerUser,
    configPath: f.configPath,
    credentialCode: code,
    cleanRemoteHost: rewritten.match(/url\s*=\s*https:\/\/([^\s/]+)/)?.[1] ?? "",
    note: "把 agent 的 gitRepositories 绑定到该仓库（name/provider/url/credentialCode）",
    sourcePath: `users/${rel.replace(/[\\/]\.git[\\/]config$/, "")}`,
  });
  console.log(
    `✅ 已迁移：${f.configPath}（模板 ${code}，值写入用户 ${f.ownerUser}，remote 已去凭证）`,
  );
}
console.log(
  `\n共迁移 ${patches.length} 处。以下为 agent 绑定 patch（经 builder/update_agent 应用）：`,
);
console.log(JSON.stringify(patches, null, 2));
db.close();
