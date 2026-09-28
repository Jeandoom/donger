import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { redactSecrets } from "../domain/audit.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { MessageStore } from "../ports/message-store.js";

/**
 * zcode 轮末对账器（specs/2026-09-29-zcode-record-fidelity-design.md M1/M4）。
 *
 * zcode 引擎的协议事件层只透出最终 response 与无入参的 tool.updated，中间叙述、
 * 真实工具入参、error 态工具结果都只在 zcode 自有库（.zcode-home/db.sqlite）里。
 * 本模块在回合结束后只读打开该库，把本轮时间窗内 donger 侧缺失的记录补齐：
 *  1. 中间叙述文本 → messages（role=bot，createdAt 回填 part 时间）+ audit text 行；
 *  2. tool_use 行 toolInput = '{}' 的 → 回填 part.state.input；
 *  3. zcode 库 state=error（或轮次被杀时仍 pending）而 audit 无 tool_result 行的 → 合成补记；
 *  4. step-finish parts → 逐轮 llm_output 审计行（tokens 放 llmOutput JSON，
 *     不落 usage 列——审计汇总的 totalTokens 对 usage 列全行求和，落了会同 result 行双重计数）。
 *
 * 幂等：对账完成写一条 audit `zcode_reconcile` 标记，同 taskId 重入即整体跳过；
 * 入参回填 SQL 只命中 '{}' / NULL，天然不覆盖。全程异常由调用方兜底（对账失败
 * 只损失记录厚度，不影响对话）。
 */

/** zcode part.data 宽松形状：zcode 侧 schema 演进只降级（少补/不补）不炸 */
interface ZcodePartData {
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  reason?: string;
}

interface ZcodeRow {
  pdata: string;
  mdata: string | null;
  tc: number;
  mid: string | null;
}

export interface ZcodeRoundReconcileInput {
  /** zcode 自有库路径（<userHomeDir>/.zcode-home/db.sqlite，与 runner 的 ZCODE_SESSION_DB_PATH 同源） */
  zcodeDbPath: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  taskId: string;
  /** 本轮窗口起点（epoch ms）。resume 复用同一 sessionId，早于此的 parts 属上一轮，绝不回看 */
  windowStartMs: number;
  /** 本轮最终回复文本：常规路径已落库，精确相等的 text part 跳过（防重复） */
  finalResponse?: string;
  /** 只统计不写入（存量回填预检） */
  dryRun?: boolean;
}

export interface ZcodeRoundReconcileStats {
  textsAdded: number;
  inputsBackfilled: number;
  resultsSynthesized: number;
  stepOutputsAudited: number;
  skipped?: "missing_db" | "already_reconciled" | "no_parts";
}

export interface ZcodeRoundReconcileDeps {
  messageStore?: MessageStore;
  auditStore?: AuditStore;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** state.error 可能是字符串或 {message}，收敛为人读文本 */
function errorText(state: ZcodePartData["state"]): string {
  const err = state?.error;
  if (typeof err === "string" && err.trim()) return err;
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  const out = state?.output;
  if (typeof out === "string" && out.trim()) return out;
  return "工具执行失败（zcode 对账补记）";
}

export async function reconcileZcodeRound(
  deps: ZcodeRoundReconcileDeps,
  input: ZcodeRoundReconcileInput,
): Promise<ZcodeRoundReconcileStats> {
  const stats: ZcodeRoundReconcileStats = {
    textsAdded: 0,
    inputsBackfilled: 0,
    resultsSynthesized: 0,
    stepOutputsAudited: 0,
  };
  const { auditStore, messageStore } = deps;
  if (!messageStore && !auditStore) return stats;
  if (!existsSync(input.zcodeDbPath)) return { ...stats, skipped: "missing_db" };

  // 幂等闸：同任务已对账过即整体跳过（消息/审计行都不会重复）
  const existing = auditStore ? await auditStore.listByTask(input.taskId) : [];
  if (existing.some((e) => e.type === "zcode_reconcile")) {
    return { ...stats, skipped: "already_reconciled" };
  }
  const hasResultRow = new Set(
    existing.filter((e) => e.type === "tool_result").map((e) => e.toolUseId ?? ""),
  );

  const db = new Database(input.zcodeDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT p.data AS pdata, p.time_created AS tc, p.message_id AS mid, m.data AS mdata
           FROM part p LEFT JOIN message m ON m.id = p.message_id
           WHERE p.session_id = ? AND p.time_created >= ?
           ORDER BY p.time_created ASC, p.rowid ASC`,
      )
      .all(input.sessionId, input.windowStartMs - 1) as ZcodeRow[];
    if (rows.length === 0) return { ...stats, skipped: "no_parts" };

    let seq = auditStore ? (await auditStore.maxSeq(input.conversationId)) + 1 : 0;
    const stepTextByMessage = new Map<string, string>();
    let lastStepStartMs: number | null = null;
    const inputEntries: Array<{ toolUseId: string; toolInput: string }> = [];

    for (const row of rows) {
      let part: ZcodePartData;
      try {
        part = JSON.parse(row.pdata) as ZcodePartData;
      } catch {
        continue;
      }
      let role: string | undefined;
      if (row.mdata != null) {
        try {
          role = (JSON.parse(row.mdata) as { role?: string }).role;
        } catch {
          // message data 损坏按 unknown 处理（text part 仅 assistant 落库，宁缺勿错）
        }
      }
      const at = iso(row.tc);

      if (part.type === "step-start") {
        lastStepStartMs = row.tc;
        continue;
      }

      if (part.type === "text") {
        if (role !== "assistant") continue;
        const text = typeof part.text === "string" ? part.text : "";
        if (!text.trim()) continue;
        if (input.finalResponse !== undefined && text === input.finalResponse) continue;
        if (row.mid) stepTextByMessage.set(row.mid, (stepTextByMessage.get(row.mid) ?? "") + text);
        if (!input.dryRun) {
          const redacted = redactSecrets(text);
          // 与 bridgeEvents 常规路径同构：消息先落库、审计随后；createdAt 回填 part 时间
          await messageStore?.add(input.conversationId, "bot", redacted, "[]", input.taskId, {
            createdAt: at,
          });
          await auditStore?.record({
            conversationId: input.conversationId,
            taskId: input.taskId,
            userId: input.userId,
            seq: seq++,
            type: "text",
            text: redacted,
            recordedAt: at,
          });
        }
        stats.textsAdded += 1;
        continue;
      }

      if (part.type === "tool") {
        const callId = typeof part.callID === "string" ? part.callID : "";
        const status = part.state?.status;
        if (callId && part.state?.input !== undefined && part.state.input !== null) {
          const serialized =
            typeof part.state.input === "string"
              ? part.state.input
              : JSON.stringify(part.state.input);
          if (serialized && serialized !== "{}") {
            inputEntries.push({ toolUseId: callId, toolInput: serialized });
          }
        }
        if (
          callId &&
          !hasResultRow.has(callId) &&
          (status === "error" || status === "pending" || status === "running" || !status)
        ) {
          // error=协议 error 事件未达（生产 7f25716e 实证 4 条）；pending/running=轮次被杀时工具未收尾
          const interrupted = status !== "error";
          if (!input.dryRun) {
            await auditStore?.record({
              conversationId: input.conversationId,
              taskId: input.taskId,
              userId: input.userId,
              seq: seq++,
              type: "tool_result",
              toolName: part.tool,
              toolUseId: callId,
              toolOutput: interrupted
                ? `工具执行随轮次中断（zcode 对账补记）${errorText(part.state)}`.slice(0, 8000)
                : redactSecrets(errorText(part.state)).slice(0, 8000),
              isError: true,
              recordedAt: at,
            });
          }
          stats.resultsSynthesized += 1;
        }
        continue;
      }

      if (part.type === "step-finish") {
        const tokens = part.tokens ?? {};
        const stepText = row.mid ? (stepTextByMessage.get(row.mid) ?? "") : "";
        if (!input.dryRun) {
          await auditStore?.record({
            conversationId: input.conversationId,
            taskId: input.taskId,
            userId: input.userId,
            seq: seq++,
            type: "llm_output",
            text: stepText || undefined,
            llmOutput: JSON.stringify({ reason: part.reason ?? null, tokens }),
            durationMs:
              lastStepStartMs !== null ? Math.max(0, row.tc - lastStepStartMs) : undefined,
            recordedAt: at,
          });
        }
        stats.stepOutputsAudited += 1;
      }
    }

    if (!input.dryRun) {
      if (inputEntries.length > 0) {
        stats.inputsBackfilled =
          (await auditStore?.backfillToolUseInputs(input.conversationId, inputEntries)) ?? 0;
      }
      await auditStore?.record({
        conversationId: input.conversationId,
        taskId: input.taskId,
        userId: input.userId,
        seq: seq++,
        type: "zcode_reconcile",
        text: JSON.stringify({
          textsAdded: stats.textsAdded,
          inputsBackfilled: stats.inputsBackfilled,
          resultsSynthesized: stats.resultsSynthesized,
          stepOutputsAudited: stats.stepOutputsAudited,
          windowStartMs: input.windowStartMs,
        }),
        recordedAt: iso(Date.now()),
      });
    } else {
      stats.inputsBackfilled = inputEntries.length;
    }
    return stats;
  } finally {
    db.close();
  }
}
