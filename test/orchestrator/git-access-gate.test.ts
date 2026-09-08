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
  credentials: [],
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
  extensionDirectories: [],
  llm: {},
  version: 1,
  createdAt: "t",
  updatedAt: "t",
};

const jihulabRepo = {
  id: "r1",
  name: "private",
  provider: "jihulab" as const,
  url: "https://jihulab.com/acme/private.git",
  required: true,
  shallow: true,
  syncMode: "fastForward" as const,
  credentialCode: "jihulab-pat",
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
  credentialValues?: Record<string, string> | undefined;
}) {
  const store = {
    getDefault: vi.fn(async () => args?.connection),
    getGrant: vi.fn(async () => args?.grant),
    getSecrets: vi.fn(async () => ({ accessToken: "token" })),
    saveGrant: vi.fn(async () => undefined),
  } as unknown as GitConnectionStore;
  const credentialSets = {
    getFilledValues: vi.fn(async (_userId: string, codes: string[]) =>
      args?.credentialValues === undefined
        ? []
        : codes.map((code) => ({
            userId: "u1",
            code,
            values: args.credentialValues as Record<string, string>,
            createdAt: "t",
            updatedAt: "t",
          })),
    ),
  } as unknown as import("../../src/ports/credential-set-store.js").CredentialSetStore;
  const materializer = {
    checkRead: vi.fn(async (_repo, credential) => ({
      ok: credential ? (args?.authenticated ?? true) : false,
      ...(!credential || args?.authenticated === false
        ? { reason: "access_denied", message: "denied" }
        : {}),
    })),
  } as unknown as RepositoryMaterializer;
  return {
    gate: new GitAccessGate(store, materializer, credentialSets, 60_000),
    store,
    materializer,
    credentialSets,
  };
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

  describe("凭证集 PAT 桥（credentialCode）", () => {
    const patAgent: Agent = {
      ...agent,
      gitRepositories: [jihulabRepo],
    };

    it("用户已填值：用 PAT 凭证校验并物化，username 缺省用平台默认", async () => {
      const { gate, materializer } = setup({ credentialValues: { token: "pat-1" } });
      const result = await gate.check(user, patAgent);
      expect(result.ready).toBe(true);
      expect(result.requirements).toEqual([]);
      expect(result.materializeItems[0]?.credential).toEqual({
        username: "oauth2",
        accessToken: "pat-1",
      });
      expect(materializer.checkRead).toHaveBeenCalledWith(
        patAgent.gitRepositories[0],
        { username: "oauth2", accessToken: "pat-1" },
        undefined,
      );
    });

    it("模板提供 username 键时优先用模板值", async () => {
      const { gate } = setup({ credentialValues: { username: tester, token: "pat-1" } });
      const result = await gate.check(user, patAgent);
      expect(result.materializeItems[0]?.credential?.username).toBe(tester);
    });

    it("用户未填值：不硬阻断，放行待预检问询（item 无凭证、无 requirements）", async () => {
      const { gate, credentialSets } = setup({ credentialValues: undefined });
      const result = await gate.check(user, patAgent);
      expect(result.ready).toBe(true);
      expect(result.requirements).toEqual([]);
      expect(result.materializeItems[0]?.credential).toBeUndefined();
      expect(credentialSets.getFilledValues).toHaveBeenCalledWith("u1", ["jihulab-pat"]);
    });

    it("已填值但远端拒绝：聚合 access_denied 要求", async () => {
      const { gate } = setup({ credentialValues: { token: "bad" }, authenticated: false });
      const result = await gate.check(user, patAgent);
      expect(result.ready).toBe(false);
      expect(result.requirements[0]?.reason).toBe("access_denied");
      expect(result.requirements[0]?.provider).toBe("jihulab");
    });
  });
});
