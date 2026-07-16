import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { GitConnection, GitRepositoryGrant } from "../../src/domain/git.js";
import type { User } from "../../src/domain/user.js";
import { GitAccessGate } from "../../src/orchestrator/git-access-gate.js";
import type { GitConnectionStore } from "../../src/ports/git-connection-store.js";
import type { RepositoryMaterializer } from "../../src/ports/repository-materializer.js";

const user: User = {
  id: "u1",
  name: "U",
  role: "user",
  homeDir: "/u1",
  createdAt: "t",
  updatedAt: "t",
};

const agent: Agent = {
  id: "a1",
  ownerId: "u1",
  name: "A",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  gitRepositories: [
    {
      id: "r1",
      name: "private",
      provider: "github",
      url: "https://github.com/acme/private.git",
      required: true,
      shallow: true,
      syncMode: "fastForward",
    },
  ],
  llm: {},
  createdAt: "t",
  updatedAt: "t",
};

const connection: GitConnection = {
  id: "c1",
  userId: "u1",
  provider: "github",
  accountId: "1",
  accountName: "alice",
  authType: "pat",
  scopes: [],
  status: "active",
  createdAt: "t",
  updatedAt: "t",
};

function setup(args?: {
  connection?: GitConnection;
  grant?: GitRepositoryGrant;
  authenticated?: boolean;
}) {
  const store = {
    getDefault: vi.fn(async () => args?.connection),
    getGrant: vi.fn(async () => args?.grant),
    getSecrets: vi.fn(async () => ({ accessToken: "token" })),
    saveGrant: vi.fn(async () => undefined),
  } as unknown as GitConnectionStore;
  const materializer = {
    checkRead: vi.fn(async (_repo, credential) => ({
      ok: credential ? (args?.authenticated ?? true) : false,
      ...(!credential || args?.authenticated === false
        ? { reason: "access_denied", message: "denied" }
        : {}),
    })),
  } as unknown as RepositoryMaterializer;
  return { gate: new GitAccessGate(store, materializer, 60_000), store, materializer };
}

describe("GitAccessGate", () => {
  it("缺少平台连接时聚合授权要求", async () => {
    const { gate } = setup();
    const result = await gate.check(user, agent);
    expect(result.ready).toBe(false);
    expect(result.requirements).toEqual([
      {
        provider: "github",
        reason: "connection_missing",
        repositories: [{ id: "r1", name: "private", fingerprint: "github:acme/private" }],
      },
    ]);
  });

  it("已有连接但未确认仓库时要求 grant", async () => {
    const { gate } = setup({ connection });
    expect((await gate.check(user, agent)).requirements[0]?.reason).toBe("grant_missing");
  });

  it("连接、grant 和真实访问均通过后返回物化凭证", async () => {
    const grant: GitRepositoryGrant = {
      userId: "u1",
      agentId: "a1",
      repositoryId: "r1",
      repositoryFingerprint: "github:acme/private",
      connectionId: "c1",
      permission: "read",
      grantedAt: "t",
    };
    const { gate } = setup({ connection, grant });
    const result = await gate.check(user, agent);
    expect(result.ready).toBe(true);
    expect(result.materializeItems[0]?.credential).toEqual({
      username: "x-access-token",
      accessToken: "token",
    });
  });
});
