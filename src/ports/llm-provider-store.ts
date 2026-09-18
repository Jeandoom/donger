import type { UserLlmProvider } from "../domain/user-llm-provider.js";

/** 含解密 key 的完整配置（仅运行时基底解析 / 连通性测试使用，严禁直接下发渠道） */
export type UserLlmProviderWithKey = UserLlmProvider & { key: string };

export interface LlmProviderCreateInput {
  name: string;
  platform: string;
  baseUrl: string;
  key: string;
  models: string[];
  sdkType: UserLlmProvider["sdkType"];
  isDefault: boolean;
}

export interface LlmProviderUpdateInput {
  name?: string;
  baseUrl?: string;
  key?: string;
  models?: string[];
  isDefault?: boolean;
}

export interface LlmProviderStore {
  migrate(): void;
  list(userId: string): Promise<UserLlmProvider[]>;
  getWithKey(userId: string, id: string): Promise<UserLlmProviderWithKey | undefined>;
  findDefaultWithKey(userId: string): Promise<UserLlmProviderWithKey | undefined>;
  create(userId: string, input: LlmProviderCreateInput): Promise<UserLlmProvider>;
  update(
    userId: string,
    id: string,
    input: LlmProviderUpdateInput,
  ): Promise<UserLlmProvider | undefined>;
  remove(userId: string, id: string): Promise<boolean>;
}
