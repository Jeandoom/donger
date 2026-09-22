import { z } from "zod";

/** 内置知识库的属主常量（不入 users 表；builtin=1 时 ownerId 恒为它） */
export const BUILTIN_KB_OWNER = "__builtin__";

export const KbLibrarySchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(""),
  /**
   * 库提示词：规范组织结构、说明用途，注入给 LLM 指引维护与检索。
   * 信任分级（spec §8）：本人 canManage 库直拼提示词；他人库必须 wrapUntrusted 包裹。
   */
  systemPrompt: z.string().max(8000).default(""),
  /** 系统默认库：seed 物化、全员可读、仅 admin 可写、不可删不可分享 */
  builtin: z.boolean().default(false),
  /** 个人知识库：每用户一个（懒 ensure）、含经验记忆、禁分享禁删除 */
  personal: z.boolean().default(false),
  /** 由 agent「独立知识库」自动创建时的溯源（弱引用） */
  sourceAgentId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KbLibrary = z.infer<typeof KbLibrarySchema>;

export const KbLibraryInputSchema = KbLibrarySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type KbLibraryInput = z.infer<typeof KbLibraryInputSchema>;

export function parseKbLibrary(raw: unknown): KbLibrary {
  return KbLibrarySchema.parse(raw);
}

export const KB_REVISION_ACTIONS = [
  "create",
  "update",
  "delete",
  "config",
  "import",
  "library-deleted",
] as const;
export type KbRevisionAction = (typeof KB_REVISION_ACTIONS)[number];

export const KB_REVISION_ACTOR_KINDS = [
  "manual",
  "chat",
  "auto-learn",
  "memory",
  "import",
  "system",
] as const;
export type KbRevisionActorKind = (typeof KB_REVISION_ACTOR_KINDS)[number];

/** 修订账本单条记录：kb_revisions 的读形态（详情见 spec §6/§6.1） */
export interface KbRevision {
  id: string;
  kbId: string;
  /** 库内相对路径；"" 表库级动作（config / library-deleted） */
  path: string;
  action: KbRevisionAction;
  actorUserId: string;
  actorKind: KbRevisionActorKind;
  conversationId?: string;
  taskId?: string;
  summary: string;
  beforeHash?: string;
  afterHash?: string;
  /** 自实现行级 diff（kb-diff.ts），截断 64KB；保留策略会清空旧行的该字段 */
  diffText?: string;
  createdAt: string;
}

export interface KbRevisionInput {
  kbId: string;
  path: string;
  action: KbRevisionAction;
  actorUserId: string;
  actorKind: KbRevisionActorKind;
  conversationId?: string;
  taskId?: string;
  summary?: string;
  beforeHash?: string;
  afterHash?: string;
  diffText?: string;
}
