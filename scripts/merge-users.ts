/**
 * 用户合并脚本：将 CLI 身份用户（internal:cli-admin）合并入 web/dingtalk 用户。
 *
 * 背景：/api/auth/exchange 硬编码 "cli-admin" 身份，导致同一自然人在 users 表产生两条记录。
 * 合并后：一个 user + 两条 identity（dingtalk + internal:cli-admin），CLI 下次 exchange 直接换到 survivor 的 JWT。
 *
 * 迁移范围（归属列改写 + transcript slug 替换 + homeDir 子树搬移）：
 *   user_identities / conversations / tasks(requesterId) / audit_events / usage_records /
 *   agents / skill_packs / pack_skills / task_comments / transcript_entries(project_key)
 *
 * 幂等：UPDATE 仅命中归属=SRC 的行，重跑为 no-op；DELETE 仅在事务内残留校验全为 0 后执行。
 * 用法：npx tsx scripts/merge-users.ts [--dry-run]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const SRC_ID = "1819a87a-fd1b-4175-be32-c7887d4c1394";
const DST_ID = "91f2f6c4-2c61-4f57-9e59-3a0e00562fc8";
const DB_PATH = join(homedir(), ".donger", "donger.db");

const dryRun = process.argv.includes("--dry-run");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ── 前置状态检查 ──
const src = db.prepare("SELECT id, data FROM users WHERE id = ?").get(SRC_ID) as
  | { id: string; data: string }
  | undefined;
const dst = db.prepare("SELECT id, data, updatedAt FROM users WHERE id = ?").get(DST_ID) as
  | { id: string; data: string; updatedAt: string }
  | undefined;
if (!dst) throw new Error(`目标用户不存在: ${DST_ID}`);
const dstHome = (JSON.parse(dst.data) as { homeDir: string }).homeDir;
const usersRoot = dirname(dstHome);
const srcHome = join(usersRoot, SRC_ID);
const srcHomeExists = existsSync(srcHome);

const residual = (): Record<string, number> => ({
  identities: db.prepare("SELECT COUNT(*) n FROM user_identities WHERE userId=?").get(SRC_ID).n,
  conversations: db.prepare("SELECT COUNT(*) n FROM conversations WHERE userId=?").get(SRC_ID).n,
  tasks: db
    .prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(data,'$.requesterId')=?")
    .get(SRC_ID).n,
  audit: db.prepare("SELECT COUNT(*) n FROM audit_events WHERE userId=?").get(SRC_ID).n,
  usage: db.prepare("SELECT COUNT(*) n FROM usage_records WHERE user_id=?").get(SRC_ID).n,
  agents: db.prepare("SELECT COUNT(*) n FROM agents WHERE ownerId=?").get(SRC_ID).n,
  packs: db.prepare("SELECT COUNT(*) n FROM skill_packs WHERE userId=?").get(SRC_ID).n,
  packSkills: db.prepare("SELECT COUNT(*) n FROM pack_skills WHERE userId=?").get(SRC_ID).n,
  comments: db.prepare("SELECT COUNT(*) n FROM task_comments WHERE userId=?").get(SRC_ID).n,
  transcripts: db
    .prepare("SELECT COUNT(*) n FROM transcript_entries WHERE project_key LIKE ?")
    .get(`%users-${SRC_ID}-%`).n,
});

if (!src) {
  const r = residual();
  const done = Object.values(r).every((n) => n === 0) && !existsSync(srcHome);
  console.log(
    done
      ? "✅ 已合并过（无残留），无需操作"
      : `⚠️ SRC user 行已不存在但有残留: ${JSON.stringify(r)}`,
  );
  process.exit(0);
}

console.log("── 合并前残留归属（应等于待迁移量）──");
console.log(JSON.stringify(residual(), null, 1));
const dstHomeExists = srcHomeExists;
console.log(`srcHome 目录存在: ${srcHomeExists} → ${srcHome}`);

if (dryRun) {
  console.log("── dry-run：不写入。将执行的 UPDATE 见脚本内 migrate() ──");
  process.exit(0);
}

// ── 备份（事务外）──
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(homedir(), ".donger", "backups", `merge-${stamp}`);
mkdirSync(backupDir, { recursive: true });
db.prepare("VACUUM INTO ?").run(join(backupDir, "donger.db"));
if (dstHomeExists) cpSync(srcHome, join(backupDir, `users-${SRC_ID}`), { recursive: true });
console.log(`✅ 备份完成 → ${backupDir}`);

// ── 数据库迁移（单事务，事务内残留校验不过则整体回滚）──
const migrate = db.transaction(() => {
  const steps: Array<[string, string, unknown[]]> = [
    ["user_identities", "UPDATE user_identities SET userId=? WHERE userId=?", [DST_ID, SRC_ID]],
    ["conversations", "UPDATE conversations SET userId=? WHERE userId=?", [DST_ID, SRC_ID]],
    ["audit_events", "UPDATE audit_events SET userId=? WHERE userId=?", [DST_ID, SRC_ID]],
    ["usage_records", "UPDATE usage_records SET user_id=? WHERE user_id=?", [DST_ID, SRC_ID]],
    ["agents", "UPDATE agents SET ownerId=? WHERE ownerId=?", [DST_ID, SRC_ID]],
    ["skill_packs", "UPDATE skill_packs SET userId=? WHERE userId=?", [DST_ID, SRC_ID]],
    ["pack_skills", "UPDATE pack_skills SET userId=? WHERE userId=?", [DST_ID, SRC_ID]],
    ["task_comments", "UPDATE task_comments SET userId=? WHERE userId=?", [DST_ID, SRC_ID]],
    [
      "transcript_entries",
      "UPDATE transcript_entries SET project_key=REPLACE(project_key, ?, ?) WHERE project_key LIKE ?",
      [`users-${SRC_ID}-`, `users-${DST_ID}-`, `%users-${SRC_ID}-%`],
    ],
    [
      "tasks(requesterId)",
      "UPDATE tasks SET data=json_set(data,'$.requesterId',?) WHERE json_extract(data,'$.requesterId')=?",
      [DST_ID, SRC_ID],
    ],
  ];
  for (const [name, sql, params] of steps) {
    const changes = db.prepare(sql).run(...params).changes;
    console.log(`  ${name}: ${changes} 行`);
  }

  // survivor 的 mergedFrom：清掉历史自引用，只保留本次合并来源
  const dstData = JSON.parse(dst.data) as { mergedFrom?: string[] };
  dstData.mergedFrom = [SRC_ID];
  db.prepare("UPDATE users SET data=?, updatedAt=? WHERE id=?").run(
    JSON.stringify(dstData),
    new Date().toISOString(),
    DST_ID,
  );

  const after = residual();
  const leftover = Object.entries(after).filter(([, n]) => n !== 0);
  if (leftover.length > 0) throw new Error(`事务内残留校验失败: ${JSON.stringify(leftover)}`);
  const del = db.prepare("DELETE FROM users WHERE id=?").run(SRC_ID).changes;
  if (del !== 1) throw new Error(`DELETE users 变更数异常: ${del}`);
  console.log("  users: DELETE 1 行（mergedFrom 已记录来源并清理 11 个历史自引用）");
});
migrate();
console.log("✅ 数据库迁移完成");

// ── homeDir 子树搬移（.skills / sessions / agents）──
if (dstHomeExists) {
  for (const sub of [".skills", "sessions", "agents"]) {
    const from = join(srcHome, sub);
    if (!existsSync(from)) continue;
    const to = join(dstHome, sub);
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (existsSync(join(to, entry))) throw new Error(`目标已存在，拒绝覆盖: ${join(to, entry)}`);
      cpSync(join(from, entry), join(to, entry), { recursive: true });
    }
    rmSync(from, { recursive: true });
    console.log(`  ${sub}/ → dstHome（子项已逐一搬移，无覆盖）`);
  }
  const rest = readdirSync(srcHome);
  if (rest.length === 0) rmSync(srcHome, { recursive: true });
  else console.log(`⚠️ srcHome 还有未处理条目，保留原目录: ${rest.join(", ")}`);
  console.log("✅ 目录搬移完成");
}

// ── 终验 ──
const finalIdentities = db
  .prepare("SELECT provider, externalId FROM user_identities WHERE userId=? ORDER BY provider")
  .all(DST_ID);
console.log("── 终验：survivor 的身份绑定 ──");
console.log(JSON.stringify(finalIdentities, null, 1));
console.log(`survivor 剩余残留（应全 0）: ${JSON.stringify(residual())}`);
db.close();
console.log("🎉 合并完成。CLI 端重跑 `donger login <CLI_TOKEN>` 即换到合并后账号的 JWT。");
