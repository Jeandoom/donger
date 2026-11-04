// 凭证注入纯逻辑：agent 勾选的模板 code ∩ 当前用户已配置的值 → 环境变量展开 + 缺失清单。
// 纯函数零依赖，环境变量命名契约是唯一事实源：
//   <CODE>_<KEY>  平铺单键（大写、非法字符转 _）
//   <CODE>        整体负载 JSON 字符串
//   <CODE>_MISSING=1  勾选但用户未配置（带病执行时 agent 可自检）
//   keySpecs[].envAlias  生态标准名别名（如 ALIBABA_CLOUD_ACCESS_KEY_ID），按模板配置
//   追加展开——消费方只认生态标准名时无需 agent 会话内桥接（2026-11-04 生产事故：
//   智能体只认 ALIBABA_CLOUD_*，平台注入名不被识别，误判「未配置凭证」）。

import type { CredentialKind, CredentialKeySpec } from "./credential.js";

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

/**
 * 按 kind 收口注入面：仅 generic 注入 env。git 类走凭证桥（donger-git 工具），
 * host 类走 donger-host 工具——两类文档契约均为「不注入 env」，此前 `!== "git"`
 * 的过滤把 host 值（SSH 密码/私钥）泄进了进程环境，与契约相悖，此处一并收口。
 */
export function pickInjectableCodes(
  picked: string[],
  kindByCode: Map<string, CredentialKind>,
): { injectable: string[]; excluded: Array<{ code: string; kind: CredentialKind }> } {
  const injectable: string[] = [];
  const excluded: Array<{ code: string; kind: CredentialKind }> = [];
  for (const code of picked) {
    const kind = kindByCode.get(code) ?? "generic";
    if (kind === "generic") injectable.push(code);
    else excluded.push({ code, kind });
  }
  return { injectable, excluded };
}

/** 别名冲突语义：pickedCodes 顺序靠后的 code 覆盖靠前的（与 Object.assign 一致） */
export function resolveInjectionEnv(
  filled: InjectionInput[],
  pickedCodes: string[],
  keySpecsByCode?: Map<string, CredentialKeySpec[]>,
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
    const aliasByKey = new Map(
      (keySpecsByCode?.get(code) ?? [])
        .filter((s) => s.envAlias)
        .map((s) => [s.key, s.envAlias as string]),
    );
    for (const [key, value] of Object.entries(values)) {
      env[toEnvName(code, key)] = value;
      const alias = aliasByKey.get(key);
      if (alias) env[alias] = value;
    }
    env[toEnvName(code)] = JSON.stringify(values);
  }
  return { env, missing };
}

/** 注入回执（审计/自检用）：只含 code、键数与别名清单，永不含值 */
export interface InjectionReceipt {
  injected: Array<{ code: string; keyCount: number; aliases: string[] }>;
  missing: string[];
  excluded: Array<{ code: string; kind: CredentialKind }>;
}

/** 组装回执文本（session_init 审计 text）：配置页「已勾选」与会话「已注入」从此有对照物 */
export function formatInjectionReceipt(receipt: InjectionReceipt): string {
  const parts: string[] = [];
  if (receipt.injected.length > 0) {
    parts.push(
      `已注入 ${receipt.injected
        .map((i) =>
          i.aliases.length > 0
            ? `${i.code}(${i.keyCount}键,别名${i.aliases.join("/")})`
            : `${i.code}(${i.keyCount}键)`,
        )
        .join("、")}`,
    );
  }
  if (receipt.missing.length > 0) {
    parts.push(`勾选但用户未配置（仅 _MISSING 标记）：${receipt.missing.join("、")}`);
  }
  if (receipt.excluded.length > 0) {
    parts.push(
      `不注入 env（经专用工具现取）：${receipt.excluded.map((x) => `${x.code}(${x.kind})`).join("、")}`,
    );
  }
  return parts.length > 0
    ? `凭证注入回执：${parts.join("；")}`
    : "凭证注入回执：该智能体未勾选任何凭证";
}
