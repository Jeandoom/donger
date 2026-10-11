// donger DB 绝对路径改写（Docker 迁移，D1 bind mount 口径）
// 用法：node rewrite-db-paths.cjs <dbPath> [--apply]
//   缺省 dry-run 只打印；--apply 事务内改写。
// 改写范围（摸底实证的唯一持久化绝对路径类）：users.data(JSON).homeDir
//   三种历史形态统一 → /data/workspace/users/<id>：
//   ① 相对 data\workspace\users\<id>   ② 旧绝对 D:\code\donger\.deploy\donger\...   ③ 新绝对 D:\deploy\donger\...
// 另：断言完整性 + 列出 agents.extensionDirectories 绝对条目（运行时本就降级，仅报告不清除）。
"use strict";

const dbFile = process.argv[2];
const apply = process.argv.includes("--apply");
if (!dbFile) {
  console.error("用法：node rewrite-db-paths.cjs <dbPath> [--apply]");
  process.exit(2);
}

// 容器内运行时 module 解析够不到 /app/node_modules，显式兜底；宿主运行时走常规解析
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = require("/app/node_modules/better-sqlite3");
}

const MAP = [
  [/^data[\\/]workspace[\\/]users[\\/]/i, "/data/workspace/users/"],
  [/^D:[\\/]code[\\/]donger[\\/]\.deploy[\\/]donger[\\/]data[\\/]workspace[\\/]users[\\/]/i, "/data/workspace/users/"],
  [/^D:[\\/]deploy[\\/]donger[\\/]data[\\/]workspace[\\/]users[\\/]/i, "/data/workspace/users/"],
];

function rewriteHomeDir(p) {
  if (typeof p !== "string") return null;
  for (const [re, to] of MAP) {
    if (re.test(p)) return to + p.replace(re, "").replace(/\\/g, "/");
  }
  return null;
}

const db = new Database(dbFile);
if (apply) db.exec("PRAGMA journal_mode=WAL");

const users = db.prepare("SELECT id, data FROM users").all();
let changed = 0;
const pending = [];
for (const row of users) {
  let obj;
  try {
    obj = JSON.parse(row.data);
  } catch {
    console.log(`[WARN] users.id=${row.id} data 非 JSON，跳过`);
    continue;
  }
  const next = rewriteHomeDir(obj.homeDir);
  if (next && next !== obj.homeDir) {
    pending.push({ id: row.id, from: obj.homeDir, to: next });
    obj.homeDir = next;
  }
}

console.log(`users 总数=${users.length}，待改写=${pending.length}`);
for (const p of pending) console.log(`  ${p.id}\n    ${p.from}\n -> ${p.to}`);

if (apply && pending.length) {
  const upd = db.prepare("UPDATE users SET data = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const p of pending) {
      const obj = JSON.parse(users.find((u) => u.id === p.id).data);
      obj.homeDir = p.to;
      upd.run(JSON.stringify(obj), p.id);
    }
  });
  tx();
  console.log("已事务提交。");
} else if (!apply) {
  console.log("dry-run：未写入。加 --apply 执行。");
}

// 断言
const leftovers = db
  .prepare("SELECT id, json_extract(data,'$.homeDir') AS h FROM users")
  .all()
  .filter((r) => typeof r.h === "string" && !r.h.startsWith("/data/workspace/users/"));
console.log(`断言-未规范 homeDir 残留=${leftovers.length}`);
for (const r of leftovers) console.log(`  ${r.id}: ${r.h}`);
const integ = db.prepare("PRAGMA integrity_check").get();
console.log(`integrity_check=${JSON.stringify(integ)}`);

// 报告 agents.extensionDirectories 绝对条目（仅列出）
try {
  const cols = db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
  const col = cols.includes("extensionDirectories")
    ? "extensionDirectories"
    : cols.find((c) => /extension/i.test(c));
  if (col) {
    for (const row of db.prepare(`SELECT id, ${col} AS ext FROM agents`).all()) {
      if (row.ext && /[A-Za-z]:[\\/]/.test(String(row.ext))) {
        console.log(`[报告] agents.id=${row.id} ${col} 含绝对路径（运行时降级，不清除）：${String(row.ext).slice(0, 120)}`);
      }
    }
  }
} catch (e) {
  console.log(`[WARN] agents 扩展目录扫描跳过：${e.message}`);
}

db.close();
console.log("done");
if (leftovers.length) process.exit(1);
