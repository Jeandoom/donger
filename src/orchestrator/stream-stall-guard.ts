import type { RunnerEvent } from "../domain/types.js";

/**
 * LLM 流停摆看门狗：轮内超过 stallMs 没有任何事件（含 thinking/text/tool 增量）视为挂死，
 * 调用 onStall（尽力留审计痕迹）后抛错——错误沿 runTurn → processMessage 既有 catch 收尾
 * （任务标 failed + 会话补错误消息），不再依赖重启清扫兜底。
 *
 * 背景（2026-09-14 会话 cfd4703d 分析）：某轮在 tool_result 后流静默挂死，任务挂 running
 * 2 小时直到服务重启才被标失败，用户无任何收尾提示。
 */
export function guardStreamStall(
  events: AsyncIterable<RunnerEvent>,
  stallMs: number,
  onStall: () => Promise<void> | void,
): AsyncIterable<RunnerEvent> {
  async function* guarded(): AsyncGenerator<RunnerEvent> {
    const iterator = events[Symbol.asyncIterator]();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          iterator.next(),
          new Promise<"stall">((resolve) => {
            timer = setTimeout(() => resolve("stall"), stallMs);
            // 不因看门狗计时器阻止进程退出
            timer.unref?.();
          }),
        ]);
        if (next === "stall") {
          await onStall();
          throw new Error(
            `模型响应长时间无进展（超过 ${Math.round(stallMs / 60_000)} 分钟无事件），本轮已中断；请重发任务重试`,
          );
        }
        if (next.done) return;
        yield next.value;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  return guarded();
}
