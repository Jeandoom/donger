import type { UserModelConfig } from "../domain/model-config.js";

export interface UserModelConfigStore {
  migrate(): void;
  get(userId: string): Promise<UserModelConfig | undefined>;
  save(userId: string, config: UserModelConfig): Promise<void>;
}
