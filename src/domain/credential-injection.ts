// 凭证注入纯逻辑：agent 勾选的模板 code ∩ 当前用户已配置的值 → 环境变量展开 + 缺失清单。
// 纯函数零依赖，环境变量命名契约是唯一事实源：
//   <CODE>_<KEY>  平铺单键（大写、非法字符转 _）
//   <CODE>        整体负载 JSON 字符串
//   <CODE>_MISSING=1  勾选但用户未配置（带病执行时 agent 可自检）

export interface InjectionInput {
  code: string;
  values: Record<string, string>;
}

export interface InjectionResult {
  /** 注入 SDK env 的平铺变量（含 <CODE> 整体负载与 _MISSING 标记） */
  env: Record<string, string>;
  /** 勾选但用户未配置的 code 清单（问询/日志用，不含值） */
  missing: string[];
}

/** code/key → 环境变量安全名：大写，字母数字以外转 _，压缩连续 _ 并去首尾 _ */
export function toEnvName(...parts: string[]): string {
  return parts
    .map((p) =>
      p
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter(Boolean)
    .join("_");
}

export function resolveInjectionEnv(
  filled: InjectionInput[],
  pickedCodes: string[],
): InjectionResult {
  const byCode = new Map(filled.map((f) => [f.code, f.values]));
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const code of pickedCodes) {
    const values = byCode.get(code);
    if (!values || Object.keys(values).length === 0) {
      missing.push(code);
      env[`${toEnvName(code)}_MISSING`] = "1";
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      env[toEnvName(code, key)] = value;
    }
    env[toEnvName(code)] = JSON.stringify(values);
  }
  return { env, missing };
}
