import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { McpWhitelistOption } from "../src/lib/agents";
import { emptyAgent } from "../src/pages/agent-editor/model";
import { ToolsPermsSection } from "../src/pages/agent-editor/ToolsPermsSection";

// MCP 服务器级白名单候选（2026-11-06）：编辑页白名单勾选器下发 MCP 分组，
// 与 API 能力面对齐——donger-host 不满足挂载条件时置灰不可勾，可选项勾选即
// 写入 whitelist（matchesToolWhitelist 的服务器前缀语义）。

const mcpFixture: McpWhitelistOption[] = [
  {
    entry: "mcp__donger-kb",
    server: "donger-kb",
    label: "知识库",
    hint: "恒挂载",
    available: true,
  },
  {
    entry: "mcp__donger-host",
    server: "donger-host",
    label: "远程主机",
    hint: "admin 或名下有已填值主机凭证后挂载",
    available: false,
  },
  {
    entry: "mcp__teambition",
    server: "teambition",
    label: "teambition",
    hint: "连接器 · 在「MCP 工具」区勾选引用后挂载",
    available: true,
  },
];

function renderSection(whitelist: string[] = [], mcpTools: McpWhitelistOption[] = mcpFixture) {
  const patch = vi.fn();
  render(
    <MemoryRouter>
      <ToolsPermsSection
        form={{ ...emptyAgent, tools: { mode: "whitelist", whitelist } }}
        patch={patch}
        tools={["Bash", "Read"]}
        mcpTools={mcpTools}
        connectors={[]}
        issues={[]}
        mcpJsonText="[]"
        onMcpJsonTextChange={() => {}}
        mcpJsonError={null}
        onMcpJsonErrorChange={() => {}}
      />
    </MemoryRouter>,
  );
  return patch;
}

/** entry 文本定位行内 checkbox（label 文本含提示，getByLabelText 不可用） */
function inputOf(entry: string): HTMLInputElement {
  const row = screen.getByText(entry).closest("label");
  if (!row) throw new Error(`row not found: ${entry}`);
  return row.querySelector("input") as HTMLInputElement;
}

describe("ToolsPermsSection 白名单 MCP 分组", () => {
  it("渲染 MCP 候选及挂载语义提示；不满足条件项置灰", () => {
    renderSection();
    expect(screen.getByText("mcp__donger-kb")).toBeTruthy();
    expect(screen.getByText("知识库 · 恒挂载")).toBeTruthy();
    expect(inputOf("mcp__donger-host").disabled).toBe(true);
    expect(inputOf("mcp__donger-kb").disabled).toBe(false);
    expect(screen.getByText(/已填值主机凭证/)).toBeTruthy();
    // 分组标题说明服务器级放行语义
    expect(screen.getByText(/勾选放行该服务器全部工具/)).toBeTruthy();
  });

  it("勾选可用项写入 whitelist；已勾选项回显选中", () => {
    const patch = renderSection(["mcp__donger-kb"]);
    expect(inputOf("mcp__donger-kb").checked).toBe(true);
    fireEvent.click(inputOf("mcp__teambition"));
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          mode: "whitelist",
          whitelist: ["mcp__donger-kb", "mcp__teambition"],
        },
      }),
    );
  });

  it("搜索框同时过滤内置工具与 MCP 分组", () => {
    renderSection();
    fireEvent.change(screen.getByPlaceholderText(/搜索工具名/), {
      target: { value: "host" },
    });
    expect(screen.queryByText("mcp__donger-kb")).toBeNull();
    expect(screen.getByText("mcp__donger-host")).toBeTruthy();
  });
});
