import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { User } from "../../src/domain/user.js";
import { GitAccessGate } from "../../src/orchestrator/git-access-gate.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
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
  gitAllowShellGit: false,
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

function fakeMaterializer(
  anonymousOk: boolean,
  authorized?: { ok: boolean; reason?: "access_denied"; message?: string },
) {
  return {
    checkRead: vi.fn(async (_repo, credential) => {
      if (!credential) {
        return anonymousOk
          ? { ok: true }
          : { ok: false, reason: "access_denied", message: "denied" };
      }
      return authorized ?? { ok: true };
    }),
  } as unknown as RepositoryMaterializer;
}

function fakeCredentialSets(values: Record<string, string> | undefined) {
  return {
    getFilledValues: vi.fn(async (uid: string, codes: string[]) =>
      values === undefined
        ? []
        : codes.map((code) => ({
            userId: uid,
            code,
            values,
            createdAt: "t",
            updatedAt: "t",
          })),
    ),
  } as unknown as CredentialSetStore;
}

describe("GitAccessGate（凭证桥单轨）", () => {
  it("公共仓库匿名可读即通过并物化", async () => {
    const gate = new GitAccessGate(fakeMaterializer(true));
    const r = await gate.check(user, agent);
    expect(r.ready).toBe(true);
    expect(r.materializeItems).toHaveLength(1);
  });

  it("非公共仓库无 credentialCode：聚合 access_denied（平台连接流程已退役）", async () => {
    const gate = new GitAccessGate(fakeMaterializer(false));
    const r = await gate.check(user, agent);
    expect(r.ready).toBe(false);
    expect(r.requirements[0]?.reason).toBe("access_denied");
  });

  it("内网 host：allowPrivateHosts=false 时拒绝；=true 时按正常链路处理", async () => {
    const intranetAgent = {
      ...agent,
      gitRepositories: [
        {
          id: "r-intra",
          name: "intra",
          provider: "github" as const,
          url: "https://192.168.1.10/acme/repo.git",
          required: true,
          shallow: true,
          syncMode: "fastForward" as const,
        },
      ],
    };
    const deny = new GitAccessGate(fakeMaterializer(true), undefined, 600_000, false);
    const r1 = await deny.check(user, intranetAgent);
    expect(r1.ready).toBe(false);
    expect(r1.requirements[0]?.reason).toBe("provider_unavailable");

    const allow = new GitAccessGate(fakeMaterializer(true), undefined, 600_000, true);
    const r2 = await allow.check(user, intranetAgent);
    expect(r2.ready).toBe(true);
  });

  describe("凭证桥（credentialCode）", () => {
    const credAgent = {
      ...agent,
      credentials: ["jihulab-pat"],
      gitRepositories: [jihulabRepo],
    };

    it("用户已填值：用 PAT 凭证校验并物化，username 缺省用平台默认", async () => {
      const materializer = fakeMaterializer(false);
      const gate = new GitAccessGate(materializer, fakeCredentialSets({ token: "tok" }));
      const r = await gate.check(user, credAgent);
      expect(r.ready).toBe(true);
      expect(r.materializeItems[0]?.credential).toEqual({ username: "oauth2", accessToken: "tok" });
    });

    it("模板提供 username 键时优先用模板值", async () => {
      const gate = new GitAccessGate(
        fakeMaterializer(false),
        fakeCredentialSets({ token: "tok", username: "alice" }),
      );
      const r = await gate.check(user, credAgent);
      expect(r.materializeItems[0]?.credential?.username).toBe("alice");
    });

    it("用户未填值：不硬阻断，放行待预检问询（item 无凭证、无 requirements）", async () => {
      const gate = new GitAccessGate(fakeMaterializer(false), fakeCredentialSets(undefined));
      const r = await gate.check(user, credAgent);
      expect(r.ready).toBe(true);
      expect(r.materializeItems[0]?.credential).toBeUndefined();
      expect(r.requirements).toEqual([]);
    });

    it("已填值但远端拒绝：聚合 access_denied 要求", async () => {
      const gate = new GitAccessGate(
        fakeMaterializer(false, { ok: false, reason: "access_denied", message: "403" }),
        fakeCredentialSets({ token: "tok" }),
      );
      const r = await gate.check(user, credAgent);
      expect(r.ready).toBe(false);
      expect(r.requirements[0]?.reason).toBe("access_denied");
    });
  });
});
