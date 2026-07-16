import { isAbsolute } from "node:path";
import { z } from "zod";

export const AgentExtensionDirectorySchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^/\\]+$/),
  path: z.string().min(1).refine(isAbsolute, "扩展目录必须是绝对路径"),
  access: z.enum(["readOnly", "readWrite"]).default("readWrite"),
});

export type AgentExtensionDirectory = z.infer<typeof AgentExtensionDirectorySchema>;

export const AgentExtensionDirectoriesSchema = z
  .array(AgentExtensionDirectorySchema)
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "目录 id 重复" });
      }
      const name = item.name.toLowerCase();
      if (names.has(name)) {
        ctx.addIssue({ code: "custom", path: [index, "name"], message: "目录显示名重复" });
      }
      ids.add(item.id);
      names.add(name);
    }
  })
  .default([]);
