// 连接器 headers 的凭证引用解析（纯函数）：web 测试端点与运行时注入共用同一条语义，
// 保证「测试连接」测到的就是运行时会发出的请求头。

import type { McpServerConfig } from "./agent.js";
import { CREDENTIAL_REF_PATTERN } from "./connector.js";

/** 凭证值映射：code → 该访问者的凭证值集合（getFilledValues 结果按 code 索引） */
export type CredentialValuesByCode = Map<string, Record<string, string>>;

export interface RefSubstitution {
  resolved: Record<string, string>;
  /** 解析失败的引用清单："code"（模板缺失/未配置/多键歧义）或 "code.KEY"（显式键不存在） */
  missing: string[];
}

/**
 * 将 headers 值中的 {{credential:CODE[.KEY]}} 替换为凭证值。
 * 规则：显式 KEY 直取；单键模板缺省 KEY 取该键值；多键模板不带 KEY 视为歧义 → missing。
 * 解析失败的引用替换为空串并记入 missing，不抛错（调用方决定 fail-fast 还是挂起问询）。
 */
export function substituteCredentialRefs(
  headers: Record<string, string>,
  valuesByCode: CredentialValuesByCode,
): RefSubstitution {
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!value.includes("{{credential:")) {
      resolved[name] = value;
      continue;
    }
    resolved[name] = value.replace(
      CREDENTIAL_REF_PATTERN,
      (_match: string, code: string, key?: string): string => {
        const values = valuesByCode.get(code);
        if (!values) {
          missing.add(code);
          return "";
        }
        if (key) {
          const v = values[key];
          if (v === undefined) {
            missing.add(`${code}.${key}`);
            return "";
          }
          return v;
        }
        const keys = Object.keys(values);
        if (keys.length === 1) return values[keys[0] as string] ?? "";
        missing.add(code);
        return "";
      },
    );
  }
  return { resolved, missing: [...missing].sort() };
}

/**
 * 合并内联 mcpServers 与连接器派生的 server：**连接器优先**——同名内联配置被丢弃。
 * 这是重名硬拦（保存时校验）的运行时兜底，防御存量数据/并发改名的边角，
 * 确保 LLM 看到的工具命名空间永无重名（spec 2026-09-11-connectors §6.2）。
 */
export function mergeConnectorMcpServers(
  inline: McpServerConfig[],
  connectors: McpServerConfig[],
): McpServerConfig[] {
  if (connectors.length === 0) return inline;
  const connectorNames = new Set(connectors.map((s) => s.name));
  return [...connectors, ...inline.filter((s) => !connectorNames.has(s.name))];
}
