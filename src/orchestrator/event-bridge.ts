import type { RunnerEvent } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";

/** 把 RunnerEvent 流翻译成 Channel 消息（进度/结果）。session_init/tool_use 不单独推，避免刷屏。
 *  streaming 渠道：agent 文本直接展示，成功不额外发"✅完成"（避免重复）。
 *  非 streaming 渠道：发完整汇总。
 *  返回最后一条事件（通常为 result），供调用方判定终态。 */
export async function bridgeEvents(
  channel: Channel,
  threadId: string,
  events: AsyncIterable<RunnerEvent>,
): Promise<RunnerEvent | undefined> {
  const streaming = channel.streaming ?? false;
  let last: RunnerEvent | undefined;
  for await (const e of events) {
    last = e;
    if (e.type === "text") {
      await channel.send(threadId, { text: e.text });
    } else if (e.type === "result") {
      if (streaming && e.subtype === "success") {
        // streaming：agent 文本已展示，成功时只发简短状态
        await channel.send(threadId, { text: "✅" });
      } else if (e.subtype === "success") {
        await channel.send(threadId, { text: `✅ 完成：${e.result ?? ""}` });
      } else {
        await channel.send(threadId, { text: `❌ 失败：${e.error ?? "未知错误"}` });
      }
    }
  }
  return last;
}
