import type { RunnerEvent } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import type { MessageStore } from "../ports/message-store.js";

/** 把 RunnerEvent 流翻译成 Channel 消息。
 *  text → 发送 agent 文本（就是回复），先持久化到 MessageStore 再推送。
 *  result success → 不发（agent 文本已经是完整回复）。
 *  result error → 发失败通知。 */
export async function bridgeEvents(
  channel: Channel,
  threadId: string,
  events: AsyncIterable<RunnerEvent>,
  messageStore?: MessageStore,
  conversationId?: string,
): Promise<RunnerEvent | undefined> {
  let last: RunnerEvent | undefined;
  for await (const e of events) {
    last = e;
    if (e.type === "text") {
      // 先持久化 bot 消息到数据库，再推送到前端
      // 保证切换会话时消息已存在，不会丢失
      if (messageStore && conversationId) {
        await messageStore.add(conversationId, "bot", e.text).catch((err) =>
          console.error("[bridgeEvents] 保存 bot 消息失败", err),
        );
      }
      await channel.send(threadId, { text: e.text });
    } else if (e.type === "result" && e.subtype === "error") {
      await channel.send(threadId, { text: `❌ 失败：${e.error ?? "未知错误"}` });
    }
  }
  return last;
}
