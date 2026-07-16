import { apiFetch } from "./auth";

export interface ModelSettingsDTO {
  url: string;
  models: string[];
  defaultModel: string;
  keyConfigured: boolean;
}

export interface ModelSettingsInput {
  url: string;
  key?: string;
  models: string[];
  defaultModel: string;
}

export async function fetchModelSettings(): Promise<ModelSettingsDTO> {
  const response = await apiFetch("/api/settings/models");
  if (!response.ok) throw new Error(`加载 Models 配置失败：HTTP ${response.status}`);
  return (await response.json()) as ModelSettingsDTO;
}

export async function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettingsDTO> {
  const response = await apiFetch("/api/settings/models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let message = `保存 Models 配置失败：HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // 使用默认错误信息
    }
    throw new Error(message);
  }
  return (await response.json()) as ModelSettingsDTO;
}
