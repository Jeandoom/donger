import { z } from "zod";
import { findLlmPlatform, LLM_SDK_TYPES, type LlmSdkType } from "./llm-platforms.js";

/** 用户 LLM 供应商配置（域对象不含 key：解密仅 getWithKey/findDefaultWithKey 链路） */
export interface UserLlmProvider {
  id: string;
  userId: string;
  name: string;
  platform: string;
  baseUrl: string;
  models: string[];
  sdkType: LlmSdkType;
  /** 用户级默认（≤1 条）：对话未显式选模型时的基底（M1：models[0] 作默认模型） */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 端点入参（create/update 共用；update 时 key 可留空=保持原值） */
export const UserLlmProviderInputSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(50),
  platform: z.string().min(1),
  baseUrl: z.string().trim().optional(),
  key: z.string(),
  models: z.array(z.string().trim().min(1)).min(1, "至少配置一个模型"),
  sdkType: z.enum(LLM_SDK_TYPES).optional(),
  isDefault: z.boolean().optional().default(false),
});
export type UserLlmProviderInput = z.infer<typeof UserLlmProviderInputSchema>;

/** 规格化入参：平台锁定 baseUrl/sdkType（custom 除外），models 去重保序。 */
export function normalizeLlmProviderInput(
  input: UserLlmProviderInput,
):
  | { name: string; platform: string; baseUrl: string; sdkType: LlmSdkType; models: string[] }
  | { error: string } {
  const platform = findLlmPlatform(input.platform);
  if (!platform) return { error: `未知平台：${input.platform}` };
  let baseUrl: string;
  let sdkType: LlmSdkType;
  if (platform.custom) {
    baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) return { error: "自定义平台必须填写 http(s) baseUrl" };
    sdkType = input.sdkType ?? "anthropic";
  } else {
    baseUrl = platform.baseUrl;
    sdkType = platform.sdkType;
  }
  const models = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))];
  if (models.length === 0) return { error: "至少配置一个模型" };
  return { name: input.name, platform: platform.id, baseUrl, sdkType, models };
}
