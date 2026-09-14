import type { RunnerEvent } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import type { MessageStore } from "../ports/message-store.js";

/** 把 RunnerEvent 流翻译成 Channel 消息。
 *  text → 通过 SSE pushText 推送，同时持久化到 MessageStore。
 *  tool_use / tool_result 失败 → pushActivity 中间过程行（观测可视）。
 *  result success → 推送完成通知。
 *  result error → 推送失败通知。
 *  quietResult=true（多阶段任务的非末轮）→ 成功 result 不推送（回合不提前结束）；
 *  失败照常推送（回合必须能以错误结束）。
 *  silent=true（内部轮，如 dispatcher 路由）→ 全部只走审计不推送不持久化，仅返回末事件。 */
export async function bridgeEvents(
  channel: Channel,
  conversationId: string,
  events: AsyncIterable<RunnerEvent>,
  messageStore?: MessageStore,
  quietResult = false,
  silent = false,
): Promise<RunnerEvent | undefined> {
  let last: RunnerEvent | undefined;
  let streamedMessageId: string | null = null;
  const toolByUseId = new Map<string, string>();
  for await (const e of events) {
    last = e;
    if (silent) continue;
    if (e.type === "thinking_delta") {
      // 思考流：仅实时透出（不持久化为聊天消息；完整内容已随 llm_output 落审计）
      channel.pushThinkingDelta?.(conversationId, e.messageId, e.text);
      continue;
    }
    if (e.type === "text_delta") {
      streamedMessageId = e.messageId;
      channel.pushTextDelta?.(conversationId, e.messageId, e.text);
    } else if (e.type === "tool_use") {
      toolByUseId.set(e.toolUseId, e.tool);
      // 写入类工具附行数标注（CC/Codex 式规模感知）
      let scale = "";
      const input = (e.input ?? {}) as Record<string, unknown>;
      const content = input.content ?? input.new_string ?? input.patch;
      if (typeof content === "string") scale = `（+${content.split("\n").length} 行）`;
      channel.pushActivity?.(
        conversationId,
        `🔧 ${e.tool} ${clipInput(JSON.stringify(e.input ?? {}))}${scale}`,
      );
      // 结构化工具事件（turn UI）：输入推截断摘要，完整内容落审计
      channel.pushToolUse?.(conversationId, {
        toolUseId: e.toolUseId,
        tool: e.tool,
        inputPreview: clipInput(JSON.stringify(e.input ?? {}), 500),
      });
    } else if (e.type === "tool_result") {
      // 结构化工具结果（turn UI）：成败都推，前端工具卡片据此收敛状态
      channel.pushToolResult?.(conversationId, {
        toolUseId: e.toolUseId,
        outputPreview: clipInput(e.content, 2000),
        isError: e.isError,
      });
      if (e.isError) {
        const name = toolByUseId.get(e.toolUseId) ?? "工具";
        channel.pushActivity?.(conversationId, `⚠️ ${name} 失败：${clipInput(e.content, 80)}`);
      }
    } else if (e.type === "text") {
      // 先持久化 bot 消息到数据库，再推送到前端（taskId 供前端回合合并/工具装饰）
      if (messageStore && conversationId) {
        await messageStore
          .add(conversationId, "bot", e.text, "[]", e.taskId)
          .catch((err) => console.error("[bridgeEvents] 保存 bot 消息失败", err));
      }
      // 通过 SSE 推送（优先 pushText，降级到 send）
      if (channel.pushTextDelta && streamedMessageId) {
        streamedMessageId = null;
      } else if (channel.pushText && conversationId) {
        channel.pushText(conversationId, e.text);
      } else {
        await channel.send(conversationId, { text: e.text });
      }
    } else if (e.type === "result") {
      if (e.subtype === "error") {
        const errorText = `❌ 失败：${e.error ?? "未知错误"}`;
        if (channel.pushText && conversationId) {
          channel.pushText(conversationId, errorText);
        } else {
          await channel.send(conversationId, { text: errorText });
        }
        channel.pushResult?.(conversationId, "error", errorText);
      } else if (quietResult) {
        // 非末轮成功：静默（后续阶段还有门/轮次）
      } else {
        // success: 推送完成通知
        if (channel.pushResult && conversationId) {
          channel.pushResult(conversationId, "success", e.result ?? "完成");
        }
      }
    }
  }
  return last;
}

function clipInput(text: string | undefined, max = 100): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === "{}" || t === '""') return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
