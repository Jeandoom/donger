/**
 * zcode 存量会话记录回填（幂等，可重复执行）。
 *
 * 背景：specs/2026-09-29-zcode-record-fidelity-design.md —— zcode 引擎轮在 donger 侧
 * 只落「提问 + 最终结论」，中间叙述/工具入参/丢失的 error result 全在 zcode 自有库
 * （<userHomeDir>/.zcode-home/db.sqlite）。本脚本遍历 llmSdkType='zcode' 的会话，
 * 逐任务调 reconcileZcodeRound 补齐；轮末对账上线的会话已有 zcode_reconcile 标记，
 * 重跑自动跳过。
 *
 * 用法：
 *   npx tsx scripts/backfill-zcode-records.ts --db <donger.db路径> [--dry-run]
 *   --dry-run 只统计不写入（预检各会话能补多少）。
 *
 * 安全：只 INSERT 补缺消息/审计行 + UPDATE 空壳 toolInput，不改不删既有行；
 * 生产执行前请先备份 donger.db。
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { SqliteAuditStore } from "../src/adapters/sqlite-audit-store.js";
import { SqliteMessageStore } from "../src/adapters/sqlite-message-store.js";
import { reconcileZcodeRound } from "../src/orchestrator/zcode-record-reconciler.js";

interface ConvRow {
  id: string;
  userId: string;
  sdkSessionId: string | null;
  createdAt: string;
}
interface TaskRow {
  id: string;
  data: string;
}
interface UserRow {
  id: string;
  data: string;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dbPath = argValue("--db");
  const dryRun = process.argv.includes("--dry-run");
  if (!dbPath) {
    console.error(
      "用法：npx tsx scripts/backfill-zcode-records.ts --db <donger.db路径> [--dry-run]",
    );
    process.exit(1);
  }
  const db = new Database(dbPath);
  const messageStore = new SqliteMessageStore(db);
  const auditStore = new SqliteAuditStore(db);

  const convs = db
    .prepare(
      `SELECT id, userId, sdkSessionId, createdAt FROM conversations
       WHERE llmSdkType = 'zcode' AND sdkSessionId IS NOT NULL AND sdkSessionId != ''
       ORDER BY createdAt ASC`,
    )
    .all() as unknown as ConvRow[];
  console.log(`[backfill] zcode 会话 ${convs.length} 个（dryRun=${dryRun}）`);

  const homeDirByUser = new Map<string, string>();
  for (const u of db.prepare("SELECT id, data FROM users").all() as unknown as UserRow[]) {
    try {
      const home = (JSON.parse(u.data) as { homeDir?: string }).homeDir;
      if (home) homeDirByUser.set(u.id, home);
    } catch {
      // 用户 data 损坏不阻断
    }
  }

  const taskStmt = db.prepare(
    "SELECT id, data FROM tasks WHERE json_extract(data, '$.threadId') = ? ORDER BY rowid ASC",
  );

  let touched = 0;
  for (const conv of convs) {
    const homeDir = homeDirByUser.get(conv.userId);
    if (!homeDir) {
      console.log(
        `[backfill] ${conv.id.slice(0, 8)} 跳过：用户 ${conv.userId.slice(0, 8)} 无 homeDir`,
      );
      continue;
    }
    const tasks = taskStmt.all(conv.id) as unknown as TaskRow[];
    let convTexts = 0;
    let convInputs = 0;
    let convResults = 0;
    let convSteps = 0;
    for (const t of tasks) {
      let createdAt = "";
      try {
        createdAt = (JSON.parse(t.data) as { createdAt?: string }).createdAt ?? "";
      } catch {
        // 无 createdAt 无法定窗口，跳过该任务
        continue;
      }
      const windowStartMs = Date.parse(createdAt);
      if (!Number.isFinite(windowStartMs)) continue;
      // 该任务已落库的末条 bot 消息 = 常规路径的最终回复，用于 text part 去重
      const msgs = (await messageStore.listByConversation(conv.id)).filter(
        (m) => m.taskId === t.id && m.role === "bot",
      );
      const finalResponse = msgs.at(-1)?.text;
      const stats = await reconcileZcodeRound(
        { messageStore, auditStore },
        {
          zcodeDbPath: `${homeDir.replace(/[\\/]+$/, "")}/.zcode-home/db.sqlite`,
          sessionId: conv.sdkSessionId ?? "",
          conversationId: conv.id,
          userId: conv.userId,
          taskId: t.id,
          windowStartMs,
          finalResponse,
          dryRun,
        },
      );
      convTexts += stats.textsAdded;
      convInputs += stats.inputsBackfilled;
      convResults += stats.resultsSynthesized;
      convSteps += stats.stepOutputsAudited;
    }
    if (convTexts || convInputs || convResults || convSteps) {
      touched += 1;
      console.log(
        `[backfill] ${conv.id.slice(0, 8)}「任务 ${tasks.length} 个」` +
          ` 叙述+${convTexts} 入参+${convInputs} result+${convResults} 逐步llm+${convSteps}`,
      );
    }
  }
  console.log(
    `[backfill] 完成：${touched}/${convs.length} 个会话有补录${dryRun ? "（dry-run 未写入）" : ""}`,
  );
  db.close();
}

void main();
