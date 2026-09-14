import type { ChatMessage, TurnPart } from "../types";

/** GET /api/conversations/:id/messages 的历史消息形状 */
export interface HistoryMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  createdAt: string;
  taskId?: string | null;
  files?: ChatMessage["files"];
}

/** GET /api/conversations/:id/events 的审计事件形状（light 模式；仅消费工具事件） */
export interface HistoryEvent {
  type: string;
  taskId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
  recordedAt: string;
}

interface OpenToolPart extends Extract<TurnPart, { kind: "tool" }> {}

/** 工具调用工具事件游标：按 taskId 顺序消费 tool_use/tool_result */
interface TurnCursor {
  msg: ChatMessage;
  taskIds: Set<string>;
  openTools: Map<string, OpenToolPart>;
}

function isToolEvent(event: HistoryEvent): boolean {
  return event.type === "tool_use" || event.type === "tool_result";
}

function groupEventsByTask(events: HistoryEvent[]): Map<string, HistoryEvent[]> {
  const byTask = new Map<string, HistoryEvent[]>();
  for (const event of events) {
    if (!isToolEvent(event) || !event.taskId) continue;
    const list = byTask.get(event.taskId) ?? [];
    list.push(event);
    byTask.set(event.taskId, list);
  }
  return byTask;
}

/** 把 tool_use 事件落到 turn 时间线；tool_result 回填到对应 tool 分片 */
function applyToolEvent(cursor: TurnCursor, event: HistoryEvent): void {
  if (event.type === "tool_use") {
    const part: OpenToolPart = {
      kind: "tool",
      toolUseId: event.toolUseId ?? "",
      tool: event.toolName ?? "tool",
      inputPreview: event.toolInput ?? "",
      state: "running",
    };
    cursor.openTools.set(part.toolUseId, part);
    cursor.msg.parts?.push(part);
    return;
  }
  const part = event.toolUseId ? cursor.openTools.get(event.toolUseId) : undefined;
  if (!part) return;
  part.outputPreview = event.toolOutput ?? "";
  part.isError = event.isError === true;
  part.state = part.isError ? "error" : "done";
}

/** 收口：仍处 running 的工具分片标记为中断（无返回记录） */
export function finalizeTurnParts(parts: TurnPart[]): TurnPart[] {
  return parts.map((part) =>
    part.kind === "tool" && part.state === "running"
      ? {
          ...part,
          state: "error",
          outputPreview: part.outputPreview ?? "（未记录到工具返回，任务可能被中断）",
        }
      : part,
  );
}

/**
 * 历史装配：messages + 审计工具事件 → 回合合并消息数组。
 * - 回合 = 相邻 bot 消息的连续段（以用户消息为界）；旧数据（无 taskId）仅合并不装饰。
 * - 工具事件按 taskId + recordedAt 插入时间线；文本事件忽略（消息已携带）。
 */
export function assembleTurnMessages(
  messages: HistoryMessage[],
  events: HistoryEvent[],
): ChatMessage[] {
  const eventsByTask = groupEventsByTask(events);
  const cursors = new Map<string, number>();
  const out: ChatMessage[] = [];
  let turn: TurnCursor | null = null;

  const drainUntil = (taskId: string, untilIso: string | null): void => {
    if (!turn) return;
    const list = eventsByTask.get(taskId) ?? [];
    let i = cursors.get(taskId) ?? 0;
    for (;;) {
      const event = list[i];
      if (!event || (untilIso !== null && event.recordedAt > untilIso)) break;
      applyToolEvent(turn, event);
      i += 1;
    }
    cursors.set(taskId, i);
  };

  const closeTurn = (): void => {
    if (!turn) return;
    // 排空剩余事件（最后一条消息之后发生的工具调用也属于本回合）
    for (const taskId of turn.taskIds) drainUntil(taskId, null);
    turn.msg.parts = finalizeTurnParts(turn.msg.parts ?? []);
    out.push(turn.msg);
    turn = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      closeTurn();
      out.push({
        id: message.id,
        role: "user",
        text: message.text,
        createdAt: message.createdAt,
        files: message.files,
      });
      continue;
    }
    if (!turn) {
      turn = {
        msg: {
          id: `turn-${message.id}`,
          role: "bot",
          text: "",
          kind: "turn",
          parts: [],
          state: "done",
          createdAt: message.createdAt,
          ...(message.taskId ? { taskId: message.taskId } : {}),
        },
        taskIds: new Set<string>(),
        openTools: new Map<string, OpenToolPart>(),
      };
    }
    const taskId = message.taskId ?? undefined;
    if (taskId) turn.taskIds.add(taskId);
    // 排空回合内各任务在本条消息落库前发生的工具事件（保持与文本的时间线顺序）
    for (const id of turn.taskIds) drainUntil(id, message.createdAt);
    turn.msg.parts?.push({ kind: "text", messageId: message.id, text: message.text });
  }
  closeTurn();
  return out;
}
