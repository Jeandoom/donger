import { z } from "zod";

/** 传输类型：v1 仅 HTTP（streamable）；枚举为 stdio/OAuth 预留扩展位 */
export const ConnectorTransportSchema = z.enum(["http"]);
export type ConnectorTransport = z.infer<typeof ConnectorTransportSchema>;

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

/** 入参用：id/owner/时间戳由 store 填充 */
export const ConnectorInputSchema = ConnectorSchema.omit({
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
});
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
    CREDENTIAL_REF_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREDENTIAL_REF_PATTERN.exec(value)) !== null) {
      codes.add(m[1]);
    }
  }
  return [...codes];
}
