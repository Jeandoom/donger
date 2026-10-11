import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "../../src/domain/plugin.js";

/**
 * 内置插件 manifest 完备性契约（specs/2026-10-11-plugin-system-design.md §9.8）：
 * 仓库 plugins/builtin/ 的每份 plugin.json 必须合法、id 与目录一致、requires 指向存在的 id；
 * 引擎三件与关键 core 模块必须在册（防误删导致治理面/装配 gate 静默失明）。
 */
const BUILTIN_DIR = join(process.cwd(), "plugins", "builtin");

describe("内置插件 manifest 契约", () => {
  const dirs = readdirSync(BUILTIN_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const parsed = new Map(
    dirs.map((dir) => {
      const raw = JSON.parse(readFileSync(join(BUILTIN_DIR, dir, "plugin.json"), "utf8"));
      return [dir, PluginManifestSchema.parse(raw)] as const;
    }),
  );

  it("内置清单共 24 份且 id 与目录名一致", () => {
    expect(dirs).toHaveLength(24);
    for (const [dir, m] of parsed) expect(m.id).toBe(dir);
  });

  it("requires 指向存在的插件 id（无悬空依赖）", () => {
    for (const m of parsed.values()) {
      for (const dep of m.requires) {
        expect(parsed.has(dep), `${m.id} 依赖的 ${dep} 不在内置清单`).toBe(true);
      }
    }
  });

  it("引擎三件在册；安全/主干类 core 不可停", () => {
    for (const id of ["engine.claude", "engine.codex", "engine.zcode"]) {
      expect(parsed.get(id)?.kind).toBe("engine");
    }
    for (const id of ["tasks", "audit", "approval-gates", "tools", "notifications", "channel.web"]) {
      const m = parsed.get(id);
      expect(m?.core, `${id} 应为 core`).toBe(true);
      expect(m?.stoppable, `${id} 应不可停用`).toBe(false);
    }
  });

  it("M2 停用集六模块均为可停 capability", () => {
    for (const id of [
      "mcp-servers",
      "connectors",
      "host-exec",
      "channel.dingtalk",
      "workflows",
      "event-sources",
    ]) {
      const m = parsed.get(id);
      expect(m?.kind).toBe("capability");
      expect(m?.stoppable, `${id} 应可停用`).toBe(true);
    }
  });
});
