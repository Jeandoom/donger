import type { Skill } from "./types.js";

/** Skill 声明中心（内存态）。复用 T0.2 的 Skill 类型。 */
export class SkillRegistry {
  private readonly byId = new Map<string, Skill>();

  register(s: Skill): void {
    if (this.byId.has(s.id)) throw new Error(`skill 已存在: ${s.id}`);
    this.byId.set(s.id, s);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Skill | undefined {
    return this.byId.get(id);
  }

  all(): Skill[] {
    return [...this.byId.values()];
  }

  /** 大小写不敏感子串匹配：skill 的任一 trigger 命中文本即返回 */
  findByTrigger(text: string): Skill[] {
    const lower = text.toLowerCase();
    return this.all().filter((s) =>
      (s.triggers ?? []).some((t) => lower.includes(t.toLowerCase())),
    );
  }
}
