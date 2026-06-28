import type { RunnerEvent } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";

/** 把 RunnerEvent 流翻译成 Channel 消息（进度/结果）。session_init/tool_use 不单独推，避免刷屏。 */
export async function bridgeEvents(
  channel: Channel,
  threadId: string,
  events: AsyncIterable<RunnerEvent>,
): Promise<void> {
  for await (const e of events) {
    if (e.type === "text") {
      await channel.send(threadId, { text: e.text });
    } else if (e.type === "result") {
      if (e.subtype === "success") {
        await channel.send(threadId, { text: `✅ 完成：${e.result ?? ""}` });
      } else {
        await channel.send(threadId, { text: `❌ 失败：${e.error ?? "未知错误"}` });
      }
    }
  }
}
