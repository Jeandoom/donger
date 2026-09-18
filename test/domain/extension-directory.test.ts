import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentExtensionDirectoriesSchema } from "../../src/domain/extension-directory.js";

describe("AgentExtensionDirectoriesSchema", () => {
  it("接受多个绝对目录", () => {
    expect(
      AgentExtensionDirectoriesSchema.parse([
        { id: "d1", name: "docs", path: join(tmpdir(), "docs"), access: "readOnly" },
      ]),
    ).toHaveLength(1);
  });

  it("拒绝相对路径和重复名称", () => {
    expect(() =>
      AgentExtensionDirectoriesSchema.parse([
        { id: "d1", name: "docs", path: "./docs", access: "readOnly" },
      ]),
    ).toThrow();
    const path = join(tmpdir(), "docs");
    expect(() =>
      AgentExtensionDirectoriesSchema.parse([
        { id: "d1", name: "docs", path, access: "readOnly" },
        { id: "d2", name: "DOCS", path, access: "readWrite" },
      ]),
    ).toThrow();
  });
});
