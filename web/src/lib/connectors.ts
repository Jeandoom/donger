// 连接器（外部能力接入注册表：MCP 服务 / HTTP 接口）数据获取。headers 中的字面量密钥
// 后端掩码为 ••••，提交时留掩码即保留原值；{{credential:code}} 引用语法本身不含密钥、保持可读。
import { apiFetch } from "./auth";

export type ConnectorType = "mcp" | "http";

export interface ConnectorDTO {
  id: string;
  name: string;
  description?: string;
  type: ConnectorType;
  transport: "http";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  shareScope: "private" | "global";
  ownerId: string;
  createdByMe: boolean;
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorInput {
  name: string;
  description?: string;
  /** 缺省 = 服务端沿用存量值（更新）或 mcp（新建） */
  type?: ConnectorType;
  transport?: "http";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  shareScope: "private" | "global";
}

export interface ConnectorTestResult {
  ok: boolean;
  latencyMs?: number;
  toolCount?: number;
  tools?: string[];
  error?: string;
}

async function errorOf(r: Response, fallback: string): Promise<Error> {
  try {
    const body = (await r.json()) as { error?: string };
    if (body.error) return new Error(body.error);
  } catch {
    // 非 JSON 响应保持通用文案
  }
  return new Error(fallback);
}

export async function fetchConnectors(): Promise<ConnectorDTO[]> {
  const r = await apiFetch("/api/connectors");
  if (!r.ok) throw new Error(`connectors ${r.status}`);
  const body = (await r.json()) as { connectors: ConnectorDTO[] };
  return body.connectors;
}

export async function createConnector(input: ConnectorInput): Promise<ConnectorDTO> {
  const r = await apiFetch("/api/connectors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw await errorOf(r, `create ${r.status}`);
  return (await r.json()) as ConnectorDTO;
}

export async function updateConnector(id: string, input: ConnectorInput): Promise<ConnectorDTO> {
  const r = await apiFetch(`/api/connectors/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw await errorOf(r, `update ${r.status}`);
  return (await r.json()) as ConnectorDTO;
}

export async function deleteConnector(id: string): Promise<void> {
  const r = await apiFetch(`/api/connectors/${id}`, { method: "DELETE" });
  if (!r.ok) throw await errorOf(r, `delete ${r.status}`);
}

/** 连接测试（未保存也可测）；用当前登录者的凭证解析 {{credential:*}} 引用 */
export async function testConnector(
  input: Pick<ConnectorInput, "url" | "headers">,
): Promise<ConnectorTestResult> {
  const r = await apiFetch("/api/connectors/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw await errorOf(r, `test ${r.status}`);
  return (await r.json()) as ConnectorTestResult;
}
