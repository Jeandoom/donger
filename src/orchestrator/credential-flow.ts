import { nextStatus } from "../domain/task-state-machine.js";
import type { Channel, CredentialRequest } from "../ports/channel.js";
import type { TaskStore } from "../ports/task-store.js";
import { CredentialRequiredError } from "../util/errors.js";

/**
 * 构造 credentialResolver：planning→awaiting_credentials → 推凭证卡 → 等渠道提交值
 * → 恢复 awaiting_credentials→planning，把提交的 key→value 返回给调用方（由 Orchestrator 落保险柜）。
 *
 * 渠道未实现 requestCredentials（如钉钉）→ 标记 failed 并抛 CredentialRequiredError，
 * 由 Orchestrator 捕获后向用户提示去 Web 配置。
 */
export function makeCredentialResolver(
  store: TaskStore,
  channel: Channel,
  threadId: string,
): (req: CredentialRequest) => Promise<Record<string, string>> {
  return async (req) => {
    // pendingCredentials 落库：重启清扫（failStaleAwaiting）与观测据此识别卡在凭证门的任务
    await store.updateStatus(req.taskId, nextStatus("planning", "request_credentials"), {
      pendingCredentials: { requestedAt: new Date().toISOString() },
    });
    if (!channel.requestCredentials) {
      await store.updateStatus(req.taskId, nextStatus("awaiting_credentials", "fail"), {
        pendingCredentials: undefined,
      });
      throw new CredentialRequiredError(
        "CREDENTIAL_REQUIRED",
        "请到 Web 控制台凭证页配置所需凭证后重试",
      );
    }
    const values = await channel.requestCredentials(threadId, req);
    await store.updateStatus(
      req.taskId,
      nextStatus("awaiting_credentials", "credentials_provided"),
      { pendingCredentials: undefined },
    );
    return values;
  };
}
