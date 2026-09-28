import { describe, expect, it } from "vitest";
import {
  conversationWorkspaceRoots,
  diffRows,
  displayPathOf,
  parseFileChanges,
  relativeUnderRoot,
} from "../../src/domain/file-changes.js";
import type { AuditEvent } from "../../src/domain/types.js";

function toolUse(
  id: string,
  toolName: string,
  input: unknown,
  recordedAt = "2026-09-24T10:00:00Z",
): AuditEvent {
  return {
    id,
    conversationId: "c1",
    taskId: "t1",
    userId: "u1",
    seq: 0,
    type: "tool_use",
    toolName,
    toolInput: JSON.stringify(input),
    recordedAt,
  } as AuditEvent;
}

describe("diffRows（行级 LCS）", () => {
  it("新增：全 add 带行号", () => {
    const { rows, truncated } = diffRows("", "a\nb");
    expect(truncated).toBe(false);
    expect(rows.map((r) => [r.type, r.newNo, r.text])).toEqual([
      ["add", 1, "a"],
      ["add", 2, "b"],
    ]);
  });

  it("修改：上下文保留 + del/add 对", () => {
    const { rows } = diffRows(
      "const a = 1;\nconst b = 2;\nconst c = 3;",
      "const a = 1;\nconst b = 20;\nconst c = 3;",
    );
    const mid = rows.filter((r) => r.type !== "ctx");
    expect(mid).toEqual([
      { type: "del", oldNo: 2, text: "const b = 2;" },
      { type: "add", newNo: 2, text: "const b = 20;" },
    ]);
  });

  it("删除：全 del 带原行号", () => {
    const { rows } = diffRows("x\ny\nz", "x");
    expect(rows.filter((r) => r.type === "del").map((r) => r.oldNo)).toEqual([2, 3]);
  });

  it("超大中段退化为全删全增并标 truncated", () => {
    const oldBig = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join("\n");
    const newBig = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join("\n");
    const { rows, truncated } = diffRows(oldBig, newBig);
    expect(truncated).toBe(true);
    expect(rows.filter((r) => r.type === "del")).toHaveLength(2000);
    expect(rows.filter((r) => r.type === "add")).toHaveLength(2000);
  });

  it("相同内容 → 空 diff", () => {
    const { rows, truncated } = diffRows("same\nlines", "same\nlines");
    expect(truncated).toBe(false);
    expect(rows.every((r) => r.type === "ctx")).toBe(true);
  });
});

describe("parseFileChanges（audit 写入类 tool_use 还原）", () => {
  const roots = ["/ws/users/u1/sessions/c1/workspace", "/ws/users/u1"];

  it("Write → created；Edit → modified；路径分组与行数聚合", () => {
    const events = [
      toolUse("e1", "Write", {
        file_path: "/ws/users/u1/sessions/c1/workspace/src/new.ts",
        content: "export {};\n",
      }),
      toolUse(
        "e2",
        "Edit",
        {
          file_path: "/ws/users/u1/sessions/c1/workspace/src/new.ts",
          old_string: "export {};",
          new_string: "export const a = 1;\nexport const b = 2;",
        },
        "2026-09-24T11:00:00Z",
      ),
    ];
    const { files, segmentsByPath } = parseFileChanges(events, { displayRoots: roots });
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f?.displayPath).toBe("src/new.ts");
    expect(f?.firstOp).toBe("created");
    expect(f?.lastChangedAt).toBe("2026-09-24T11:00:00Z");
    expect(f?.writes).toBe(1);
    expect(f?.edits).toBe(1);
    expect(f?.adds).toBe(3);
    expect(f?.removes).toBe(1);
    expect(segmentsByPath.get(f?.path ?? "")).toHaveLength(2);
  });

  it("MultiEdit 逐条展开为多个段", () => {
    const events = [
      toolUse("e1", "MultiEdit", {
        file_path: "/ws/users/u1/a.py",
        edits: [
          { old_string: "x = 1", new_string: "x = 2" },
          { old_string: "y = 1", new_string: "y = 2" },
        ],
      }),
    ];
    const { files, segmentsByPath } = parseFileChanges(events, { displayRoots: roots });
    expect(files[0]?.edits).toBe(2);
    expect(files[0]?.language).toBe("python");
    expect(segmentsByPath.get(files[0]?.path ?? "")).toHaveLength(2);
  });

  it("截断的 toolInput → truncated 段 + 抢救 file_path", () => {
    const events = [
      {
        ...toolUse("e1", "Write", {}),
        toolInput: '{"file_path":"/ws/users/u1/big.md","content":"很长的内容被截断了…',
      } as AuditEvent,
    ];
    const { files } = parseFileChanges(events, { displayRoots: roots });
    expect(files[0]?.path).toBe("/ws/users/u1/big.md");
    expect(files[0]?.truncated).toBe(true);
  });

  it("NotebookEdit 以 notebook_path 归组；非写入类工具被忽略", () => {
    const events = [
      toolUse("e1", "NotebookEdit", { notebook_path: "/ws/users/u1/n.ipynb", new_source: "{}" }),
      toolUse("e2", "Bash", { command: "echo hi" }),
    ];
    const { files } = parseFileChanges(events, { displayRoots: roots });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("/ws/users/u1/n.ipynb");
  });
});

describe("displayPathOf / relativeUnderRoot / conversationWorkspaceRoots", () => {
  it("最长前缀剥离并把反斜杠归一", () => {
    const roots = ["C:\\ws\\users\\u1\\agents\\a1\\workspace", "C:\\ws\\users\\u1"];
    expect(displayPathOf("C:\\ws\\users\\u1\\agents\\a1\\workspace\\src\\a.ts", roots)).toBe(
      "src/a.ts",
    );
    expect(displayPathOf("C:\\ws\\users\\u1\\other\\b.md", roots)).toBe("other/b.md");
    expect(displayPathOf("D:\\outside\\c.txt", roots)).toBe("D:/outside/c.txt");
  });

  it("relativeUnderRoot：工作区内回相对路径，越外返回 undefined", () => {
    expect(relativeUnderRoot("C:\\root\\a\\b.ts", "C:\\root")).toBe("a/b.ts");
    expect(relativeUnderRoot("C:\\elsewhere\\a.ts", "C:\\root")).toBeUndefined();
    expect(relativeUnderRoot("C:\\root", "C:\\root")).toBeUndefined();
  });

  it("conversationWorkspaceRoots：agent 绑定共享 workspace，闲聊会话隔离", () => {
    expect(conversationWorkspaceRoots("C:\\home", { id: "c9", agentId: "a1" })[0]).toBe(
      "C:\\home\\agents\\a1\\workspace",
    );
    expect(conversationWorkspaceRoots("C:\\home", { id: "c9", agentId: null })[0]).toBe(
      "C:\\home\\sessions\\c9\\workspace",
    );
  });
});
