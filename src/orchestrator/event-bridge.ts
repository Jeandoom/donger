import type { RunnerEvent } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";

/** 把 RunnerEvent 流翻译成 Channel 消息。
 *  text → 发送 agent 文本（就是回复）。
 *  result success → 不发（agent 文本已经是完整回复）。
 *  result error → 发失败通知。 */
export async function bridgeEvents(
  channel: Channel,
  threadId: string,
  events: AsyncIterable<RunnerEvent>,
): Promise<RunnerEvent | undefined> {
  let last: RunnerEvent | undefined;
  for await (const e of events) {
    last = e;
    if (e.type === "text") {
      await channel.send(threadId, { text: e.text });
    } else if (e.type === "result" && e.subtype === "error") {
      await channel.send(threadId, { text: `❌ 失败：${e.error ?? "未知错误"}` });
    }
  }
  return last;
}
