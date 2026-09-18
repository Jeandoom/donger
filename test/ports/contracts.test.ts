import { describe, expect, it } from "vitest";
import type { LLMConfig } from "../../src/domain/llm-config.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import type { AgentShare, AgentShareStore, ShareRef } from "../../src/ports/agent-share-store.js";
import type { AgentStore } from "../../src/ports/agent-store.js";
import type { Channel } from "../../src/ports/channel.js";
import type { TaskStore } from "../../src/ports/task-store.js";

const fakeTask: Task = {
  id: "t",
  channelId: "cli",
  threadId: "th",
  requesterId: "u",
  prompt: "p",
  status: "created",
  skillChain: [],
  createdAt: "t",
  updatedAt: "t",
};

const fakeLLM: LLMConfig = {
  model: "glm-4.6",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  authToken: "tok",
};

describe("端口契约（编译期可实现性）", () => {
  it("AgentRunner 可实现", () => {
    const runner: AgentRunner = {
      async *run(): AsyncIterable<RunnerEvent> {
        yield { type: "text", taskId: "t", text: "hi" };
      },
    };
    expect(typeof runner.run).toBe("function");
  });

  it("Channel 可实现（requestApproval 返回 ApprovalResult）", () => {
    const channel: Channel = {
      id: "cli",
      onMessage: () => {},
      send: async () => {},
      requestApproval: async () => ({ approved: true, responderId: "u" }),
    };
    expect(channel.id).toBe("cli");
  });

  it("TaskStore 可实现", () => {
    const store: TaskStore = {
      create: async () => {},
      get: async () => fakeTask,
      updateStatus: async () => {},
      listByStatus: async () => [fakeTask],
    };
    expect(typeof store.create).toBe("function");
  });

  it("LLMConfig 独立结构", () => {
    expect(fakeLLM.model).toBe("glm-4.6");
    expect(fakeLLM.baseUrl).toContain("anthropic");
  });

  it("AgentStore 可实现", () => {
    const store: AgentStore = {
      create: async () => ({
        id: "a",
        ownerId: "u",
        name: "n",
        skills: [],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        llm: {},
        createdAt: "",
        updatedAt: "",
      }),
      get: async () => undefined,
      listByOwner: async () => [],
      listSharedWith: async () => [],
      update: async (_id, patch) =>
        ({
          id: "a",
          ownerId: "u",
          name: "n",
          skills: [],
          tools: { mode: "all", whitelist: [] },
          mcpServers: [],
          llm: {},
          createdAt: "",
          updatedAt: "",
          ...patch,
        }) as never,
      delete: async () => {},
    };
    expect(typeof store.create).toBe("function");
  });

  it("AgentShareStore 可实现", () => {
    const share: AgentShare = {
      agentId: "a",
      token: "t",
      enabled: true,
      createdAt: "",
    };
    const ref: ShareRef = { agentId: "a", enabled: true };
    const store: AgentShareStore = {
      getShare: async () => share,
      enableShare: async () => share,
      disableShare: async () => {},
      listGrants: async () => [],
      addGrant: async () => {},
      removeGrant: async () => {},
      isGranted: async () => false,
      findByToken: async () => ref,
    };
    expect(typeof store.isGranted).toBe("function");
  });
});
