import type { RunnerEvent } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import type { MessageStore } from "../ports/message-store.js";

/** 把 RunnerEvent 流翻译成 Channel 消息。
 *  text → 通过 SSE pushText 推送，同时持久化到 MessageStore。
 *  result success → 推送完成通知。
 *  result error → 推送失败通知。 */
export async function bridgeEvents(
  channel: Channel,
  conversationId: string,
  events: AsyncIterable<RunnerEvent>,
  messageStore?: MessageStore,
): Promise<RunnerEvent | undefined> {
  let last: RunnerEvent | undefined;
  let streamedMessageId: string | null = null;
  for await (const e of events) {
    last = e;
    if (e.type === "text_delta") {
      streamedMessageId = e.messageId;
      channel.pushTextDelta?.(conversationId, e.messageId, e.text);
    } else if (e.type === "text") {
      // 先持久化 bot 消息到数据库，再推送到前端
      if (messageStore && conversationId) {
        await messageStore.add(conversationId, "bot", e.text).catch((err) =>
          console.error("[bridgeEvents] 保存 bot 消息失败", err),
        );
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
