// runner 错误文案映射（纯函数）：把 SDK/网络层原始错误翻译为用户可读的中文提示。
// 背景（2026-09-12 复盘 P0-3）：「Claude Code returned an error result: No conversation
// found with session ID: 9b7d512b-…」「API Error: Unable to connect to API (ConnectionRefused)」
// 等内部原文直接透给用户，不可理解也无法行动。
// 原则：仅替换渠道展示文案；task.error / 审计仍存原始错误供诊断。未知错误原样透出。

interface ErrorMapping {
  pattern: RegExp;
  message: string;
}

const MAPPINGS: ErrorMapping[] = [
  {
    // session 过期在 orchestrator 已自动重试一次；走到这里即重试后仍失败
    pattern: /No conversation found with session ID/i,
    message: "会话状态已失效且自动恢复未成功，请重发任务即可继续",
  },
  {
    pattern:
      /Unable to connect to API|ECONNREFUSED|ConnectionRefused|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed/i,
    message: "LLM 服务暂时不可达（网络或端点故障），请稍后重试；持续出现请检查 LLM 端点配置",
  },
  {
    pattern: /invalid[_ ]api[_ ]key|authentication.*failed|unauthorized|401/i,
    message: "LLM 凭证无效或已过期，请检查模型配置后重试",
  },
  {
    pattern: /\b429\b|rate.?limit/i,
    message: "LLM 服务限流，请稍后重试",
  },
];

export function friendlyRunnerError(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "任务执行失败";
  const hit = MAPPINGS.find((m) => m.pattern.test(text));
  return hit ? hit.message : text;
}
