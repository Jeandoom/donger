/**
 * 闲聊短路径（运行时性能轮 §效率杠杆）：每条未绑定会话的消息固定过一跳 dispatcher LLM
 * 调用（本地 CLI 没有的成本）；对「明显非任务」的输入用保守规则直连 chat 兜底，省掉这一跳。
 *
 * 判定口径刻意保守——误路由的代价是真实任务进了无工具的 chat agent，远比省一跳贵：
 * ① 非空且 ≤24 字（长句交给 dispatcher 语义判断）；
 * ② 不含任何引用/任务面标记（@ 提及、// 技能、$ 连接器、% 会话、# 反馈、URL、代码反引号、换行）；
 * ③ 整句命中问候/致谢/确认/告别/敷衍类锚点词表——锚定 ^$ 全句匹配而非「包含」，
 *    防「你好，帮我写个报告」这类带任务动词的漏网。
 */
const CHITCHAT_PATTERNS: RegExp[] = [
  /^(你好|您好|哈喽|哈罗|嗨|hi|hello|hey|yo)[!！。~～\s]*$/i,
  /^(在吗|在么|在不在|有人吗|有人在吗)[?？!！。~～\s]*$/,
  /^(谢谢|多谢|感谢)(啦|了|呀|哈)?[!！。~～\s]*$|^(辛苦了|麻烦了|thx|thanks|thank ?you)[!！。~～\s]*$/i,
  /^(早安|早上好|下午好|晚上好|晚安|午安)[!！。~～\s]*$/,
  /^(好的|好嘞|好哒|嗯+|哦+|噢+|哦了|了解|明白|收到|ok|okay|fine|got ?it)[!！。~～\s]*$/i,
  /^(哈哈+|嘿嘿+|嘻嘻+|呵呵+|笑死|233+|666+)[!！。~～\s]*$/,
  /^(再见|拜拜|回见|bye ?bye|bye|good ?night|see ?you)[!！。~～\s]*$/i,
  /^(测试|test|ping)[!！。~～\s]*$/i,
];

/** 引用/任务面标记：任一出现即放弃短路径判定（可能是任务上下文，交给 dispatcher） */
const TASK_MARKER = /[@#$%`]|\bhttps?:\/\/|\n|\r|\/\//;

export function isLikelyChitchat(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 24) return false;
  if (TASK_MARKER.test(trimmed)) return false;
  return CHITCHAT_PATTERNS.some((re) => re.test(trimmed));
}
