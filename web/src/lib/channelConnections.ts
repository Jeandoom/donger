import { apiFetch } from "./auth";

/** 渠道能力声明（未适配能力由 UI 显示「暂未适配」；无适配渠道不进通知渠道选择列表） */
export interface ChannelCapabilitiesDTO {
  outboundPush: boolean;
  replyToSource: boolean;
  inbound: "webhook" | "pull" | "stream" | null;
}

export interface ChannelConnectionDTO {
  id: string;
  displayName: string;
  description: string;
  capabilities: ChannelCapabilitiesDTO;
  /** 配置真源归属：module_configs=引用授权页；address_book=按用户地址簿；connection=自持 */
  configSource: "module_configs" | "address_book" | "connection";
  configHint: string;
  available: boolean;
  status: { inbound?: Record<string, unknown> } | null;
}

export interface ChannelTestResultDTO {
  ok: boolean;
  error?: string;
  detail?: string;
}

/** 渠道连接列表（authenticated；永不回配置值） */
export async function fetchChannelConnections(): Promise<ChannelConnectionDTO[]> {
  const r = await apiFetch("/api/channel-connections");
  if (!r.ok) throw new Error(`channel-connections ${r.status}`);
  const body = (await r.json()) as { channels: ChannelConnectionDTO[] };
  return body.channels;
}

/** 渠道连通性测试（admin：发起真实外部探活） */
export async function testChannelConnection(id: string): Promise<ChannelTestResultDTO> {
  const r = await apiFetch(`/api/channel-connections/${id}/test`, { method: "POST" });
  const body = (await r.json()) as ChannelTestResultDTO & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `test ${r.status}`);
  return body;
}

/** 通知渠道选择列表（工作流/智能体编辑器用）：仅出站推送可用且渠道就绪的选项 */
export function notifyChannelOptions(channels: ChannelConnectionDTO[]): Array<{
  id: "inapp" | "dingtalk" | "webhook" | "email";
  label: string;
}> {
  const options: Array<{ id: "inapp" | "dingtalk" | "webhook" | "email"; label: string }> = [
    { id: "inapp", label: "站内信" },
  ];
  for (const c of channels) {
    if (!c.capabilities.outboundPush || !c.available) continue;
    const known = options.find((o) => o.id === c.id);
    if (known) known.label = c.displayName;
    else options.push({ id: c.id as "dingtalk" | "webhook" | "email", label: c.displayName });
  }
  return options;
}

export interface ChannelConfigView {
  platform: string;
  configured: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

/** 渠道自持配置元信息（admin；secret 永不回显） */
export async function fetchChannelConfig(platform: string): Promise<ChannelConfigView> {
  const r = await apiFetch(`/api/channel-connections/${platform}/config`);
  if (!r.ok) throw new Error(`config ${r.status}`);
  return (await r.json()) as ChannelConfigView;
}

export async function saveChannelConfig(
  platform: string,
  config: Record<string, string>,
  enabled = true,
): Promise<void> {
  const r = await apiFetch(`/api/channel-connections/${platform}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, enabled }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `save ${r.status}`);
  }
}
