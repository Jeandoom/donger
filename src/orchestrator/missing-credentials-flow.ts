import type { Conversation } from "../domain/conversation.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { Task } from "../domain/types.js";
import type { User } from "../domain/user.js";
import type {
  Channel,
  MissingCredentialItem,
  MissingCredentialsDecision,
} from "../ports/channel.js";
import type { NotificationService } from "./notification-service.js";

/**
 * 凭证缺失问询：missing 非空时挂起任务（awaiting_credentials）并经渠道推三选。
 * 返回 true=继续执行（含带病跑，prepare 注入 <CODE>_MISSING=1）；false=本轮终止
 * （pause=任务留在挂起态；cancel=任务取消）。
 */
export async function promptMissingCredentials(p: {
  task: Task;
  user: User;
  conversation: Conversation;
  channel: Channel;
  threadId: string;
  codes: string[];
  inspect: (userId: string, codes: string[]) => Promise<MissingCredentialItem[]>;
  updateTask: (status: string, patch?: Record<string, unknown>) => Promise<void>;
  recordAudit: (missing: MissingCredentialItem[]) => Promise<void>;
  /** 通知内核（缺省=不发站内信） */
  notifications?: NotificationService;
}): Promise<boolean> {
  const { channel, task } = p;
  let missing = await p.inspect(p.user.id, p.codes);
  while (missing.length > 0) {
    // 挂起 + 审计（记录缺失清单元数据，不含任何值）
    await p.updateTask(nextStatus("planning", "request_credentials"), {
      pendingCredentials: {
        requestedAt: new Date().toISOString(),
        missingCodes: missing.map((m) => m.code),
      },
    });
    try {
      await p.recordAudit(missing);
    } catch (e) {
      console.error("[orchestrator] 凭证问询审计失败", e);
    }

    const decision: MissingCredentialsDecision = channel.requestMissingCredentials
      ? await channel.requestMissingCredentials(p.threadId, {
          taskId: task.id,
          conversationId: p.conversation.id,
          items: missing,
        })
      : "pause";

    if (decision === "continue") {
      await p.updateTask(nextStatus("awaiting_credentials", "credentials_provided"));
      return true;
    }
    if (decision === "retry") {
      await p.updateTask(nextStatus("awaiting_credentials", "credentials_provided"));
      missing = await p.inspect(p.user.id, p.codes);
      continue;
    }

    const names = missing.map((m) => `${m.name}(${m.code})`).join("、");
    if (decision === "cancel") {
      await p.updateTask(nextStatus("awaiting_credentials", "cancel"), {
        pendingCredentials: undefined,
      });
      await channel.send(p.threadId, { text: `🚫 任务已取消（缺少凭证：${names}）。` });
      channel.pushResult?.(p.conversation.id, "error", "任务已取消：缺少凭证");
    } else {
      // pause：留在 awaiting_credentials 挂起；用户配置凭证后重新发起任务，或取消
      await channel.send(p.threadId, {
        text: `⏸️ 任务已暂停（缺少凭证：${names}）。配置凭证后重新发起任务即可；不需要时可取消。`,
      });
      channel.pushResult?.(p.conversation.id, "error", "任务已暂停：缺少凭证");
      // 通知收编：dedupeKey 按 task，同任务多轮重复暂停只发首条
      void p.notifications
        ?.notify({
          event: "credential.missing",
          recipients: [{ kind: "user", userId: p.user.id }],
          title: "任务已暂停：缺少凭证",
          body: `缺少：${names}。配置凭证后重新发起任务即可；不需要时可取消。`,
          // 详情直达该任务所在会话
          link: `/?conv=${p.conversation.id}`,
          dedupeKey: `cred:${task.id}`,
        })
        .catch((e) => console.error("[notification] 凭证缺失通知失败", e));
    }
    return false;
  }
  return true;
}
