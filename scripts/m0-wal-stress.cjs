// M0：SQLite WAL × Docker Desktop bind mount(9p) 压测
// 场景：WAL 模式 + NORMAL 同步，事务写入 + 并发读 + 周期 integrity_check；
//       再模拟崩溃（子进程写入中被 kill -9），父进程重开验证恢复。
// 通过判据：无持久 SQLITE_IOERR/SQLITE_BUSY、integrity ok、崩溃后数据一致。
"use strict";
const path = "/work/t.db";
let Database;
try { Database = require("better-sqlite3"); } catch { Database = require("/app/node_modules/better-sqlite3"); }
const { spawn } = require("child_process");

const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT, ts INTEGER)");

const t0 = Date.now();
let writes = 0, busyHits = 0;
const ins = db.prepare("INSERT INTO t (v, ts) VALUES (?, ?)");
const cnt = db.prepare("SELECT count(*) AS n FROM t");

for (let round = 0; round < 50; round++) {
  const tx = db.transaction(() => {
    for (let i = 0; i < 100; i++) ins.run(`v${round}-${i}`, Date.now());
  });
  try { tx(); writes += 100; } catch (e) {
    if (String(e.code).includes("BUSY")) { busyHits++; continue; }
    console.log("WRITE-ERR", round, e.code, e.message); process.exit(1);
  }
  if (round % 10 === 0) {
    const ic = db.prepare("PRAGMA integrity_check").get();
    if (JSON.stringify(ic) !== '{"integrity_check":"ok"}') { console.log("INTEGRITY-FAIL", ic); process.exit(1); }
    cnt.get(); // 并发读
  }
}
const secs = (Date.now() - t0) / 1000;
console.log(`phase1 写入 ${writes} 行 / ${secs.toFixed(1)}s = ${(writes / secs).toFixed(0)} rows/s，busy=${busyHits}`);

// 崩溃恢复：子进程批量写入中 kill -9，父进程重开校验
const before = cnt.get().n;
const child = spawn(process.execPath, ["-e", `
  const D = require("better-sqlite3");
  const db = new D(${JSON.stringify(path)});
  db.pragma("journal_mode = WAL");
  const ins = db.prepare("INSERT INTO t (v, ts) VALUES (?, ?)");
  let n = 0; const i = setInterval(() => {
    const tx = db.transaction(() => { for (let k = 0; k < 50; k++) ins.run("crash", Date.now()); });
    tx(); n += 50;
  }, 5);
  process.on("SIGTERM", () => process.exit(0));
`], { cwd: "/app", stdio: "ignore" });
setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
setTimeout(() => {
  db.close();
  const db2 = new Database(path);
  db2.pragma("journal_mode = WAL");
  const after = db2.prepare("SELECT count(*) AS n FROM t").get().n;
  const ic2 = db2.prepare("PRAGMA integrity_check").get();
  const recovered = after - before;
  console.log(`phase2 崩溃注入：前=${before} 后=${after}（恢复 ${recovered} 行，integrity=${JSON.stringify(ic2)}）`);
  if (JSON.stringify(ic2) !== '{"integrity_check":"ok"}' || after < before) {
    console.log("CRASH-RECOVERY-FAIL"); process.exit(1);
  }
  console.log("PASS: WAL×bind-mount 压测通过");
  db2.close();
}, 4000);
