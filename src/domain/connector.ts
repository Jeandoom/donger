import { z } from "zod";

/** 传输类型：v1 仅 HTTP（streamable）；枚举为 stdio/OAuth 预留扩展位 */
export const ConnectorTransportSchema = z.enum(["http"]);
export type ConnectorTransport = z.infer<typeof ConnectorTransportSchema>;

/**
 * 连接器类型（对接外部能力的两类形态）：
 * - mcp：外部 MCP 服务（当前仅 streamable HTTP 协议），注入 agent 的 mcpServers；
 * - http：普通 HTTP/HTTPS 接口登记（承载配置/凭证/共享管理，暂不注入 agent 的 MCP 通道）。
 * 存量数据无 type 字段 → 读容忍缺省 mcp（与历史行为一致）。
 */
export const ConnectorTypeSchema = z.enum(["mcp", "http"]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

/** headers 值的凭证引用语法：{{credential:CODE}} / {{credential:CODE.KEY}} */
export const CREDENTIAL_REF_PATTERN = /\{\{credential:([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\}\}/g;

export function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const ConnectorSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional(),
  type: ConnectorTypeSchema.default("mcp"),
  transport: ConnectorTransportSchema.default("http"),
  url: z.string().refine(isHttpUrl, "URL 须为 http/https 地址"),
  /**
   * 值的两种形态：字面量（落库整体加密、DTO 掩码）或 {{credential:...}} 引用
   * （引用语法本身不含密钥、明文可读；运行时按访问者经凭证集解析替换）
   */
  headers: z.record(z.string(), z.string()).default({}),
  /** 停用后运行时跳过该连接器（不炸引用它的 agent） */
  enabled: z.boolean().default(true),
  shareScope: z.enum(["private", "global"]).default("private"),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

/** 入参用：id/owner/时间戳由 store 填充；type 缺省 = 沿用存量值（update）或 mcp（create），防 PATCH 误翻类型 */
export const ConnectorInputSchema = ConnectorSchema.omit({
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
}).extend({ type: ConnectorTypeSchema.optional() });
export type ConnectorInput = z.input<typeof ConnectorInputSchema>;

export function parseConnector(raw: unknown): Connector {
  return ConnectorSchema.parse(raw);
}
export function parseConnectorInput(raw: unknown): ConnectorInput {
  return ConnectorInputSchema.parse(raw);
}

/**
 * 提取 headers 中引用的全部凭证 code（去重）。
 * 供缺失问询/解析预取；同名多次引用只计一次。
 */
export function collectCredentialRefs(headers: Record<string, string>): string[] {
  const codes = new Set<string>();
  for (const value of Object.values(headers)) {
    // matchAll 克隆正则，不受 lastIndex 状态影响
    for (const m of value.matchAll(CREDENTIAL_REF_PATTERN)) {
      codes.add(m[1] as string);
    }
  }
  return [...codes];
}
