/** 登录方式标识（与后端 GET /api/auth/methods 返回值对应） */
export type LoginMethodKey = "email" | "dingtalk" | "github";

/** 展示优先级：邮箱 > 钉钉 > GitHub */
const LOGIN_METHOD_PRIORITY: readonly LoginMethodKey[] = ["email", "dingtalk", "github"];

/**
 * 解析 /api/auth/methods 返回值：过滤非法项、去重并按 邮箱>钉钉>GitHub 优先级排序。
 * 非数组（探测失败等）回退 fallback——默认保底邮箱表单，避免探测故障把用户锁在门外；
 * 空数组是服务端明确答案（未配置任何方式），原样返回。
 */
export function parseLoginMethods(
  raw: unknown,
  fallback: readonly LoginMethodKey[] = ["email"],
): LoginMethodKey[] {
  if (!Array.isArray(raw)) return [...fallback];
  const known = new Set<string>(LOGIN_METHOD_PRIORITY);
  const enabled = new Set(
    raw.filter((m): m is LoginMethodKey => typeof m === "string" && known.has(m)),
  );
  return LOGIN_METHOD_PRIORITY.filter((m) => enabled.has(m));
}
