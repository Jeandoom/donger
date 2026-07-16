import { z } from "zod";

export const UserModelConfigSchema = z.object({
  url: z.string().trim().min(1),
  key: z.string().min(1),
  models: z.array(z.string().trim().min(1)).min(1),
  defaultModel: z.string().trim().min(1),
});

export type UserModelConfig = z.infer<typeof UserModelConfigSchema>;

export function parseUserModelConfig(input: unknown): UserModelConfig {
  const config = UserModelConfigSchema.parse(input);
  if (!config.models.includes(config.defaultModel)) {
    throw new Error("默认模型必须包含在可用模型列表中");
  }
  return { ...config, models: [...new Set(config.models)] };
}
