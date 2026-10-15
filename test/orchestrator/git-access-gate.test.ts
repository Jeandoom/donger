import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { User } from "../../src/domain/user.js";
import { GitAccessGate } from "../../src/orchestrator/git-access-gate.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";

const user: User = {
  id: "u1",
  name: "U",
  role: "user",
  homeDir: "/u1",
  createdAt: "t",
  updatedAt: "t",
};

function agentWith(repositories: Agent["gitRepositories"]): Agent {
  return {
    id: "a1",
    ownerId: "u1",
    name: "A",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitAllowShellGit: false,
    gitRepositories: repositories,
    connectorIds: [],
    defaultPermissionMode: "ask_before_change",
    extensionDirectories: [],
    version: 1,
    createdAt: "t",
    updatedAt: "t",
  };
}

const httpsRepo = {
  id: "r1",
  name: "some-repo",
  provider: "github" as const,
  url: "https://github.com/acme/some-repo.git",
  required: true,
  shallow: true,
  syncMode: "fastForward" as const,
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

function fakeCredentialSets(values: Record<string, string> | undefined) {
  return {
    getFilledValues: (uid: string, codes: string[]) =>
      Promise.resolve(
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

describe("GitAccessGate（纯本地预检：无网络探测）", () => {
  it("无 credentialCode：放行物化（公共/私有判定交给物化层现取现败）", async () => {
    const gate = new GitAccessGate();
    const r = await gate.check(user, agentWith([httpsRepo]));
    expect(r.ready).toBe(true);
    expect(r.requirements).toEqual([]);
    expect(r.materializeItems[0]?.credential).toBeUndefined();
  });

  it("内网 host：allowPrivateHosts=false 时拒绝；=true 时放行", async () => {
    const intranetAgent = agentWith([
      {
        id: "r-intra",
        name: "intra",
        provider: "github",
        url: "https://192.168.1.10/acme/repo.git",
        required: true,
        shallow: true,
        syncMode: "fastForward",
      },
    ]);
    const deny = new GitAccessGate(undefined, false);
    const r1 = await deny.check(user, intranetAgent);
    expect(r1.ready).toBe(false);
    expect(r1.requirements[0]?.reason).toBe("provider_unavailable");
    expect(r1.requirements[0]?.repositories[0]?.fingerprint).toBe("192.168.1.10/acme/repo");

    const allow = new GitAccessGate(undefined, true);
    const r2 = await allow.check(user, intranetAgent);
    expect(r2.ready).toBe(true);
  });

  it("URL 非法：不就绪且不抛（指纹回落原文；旧实现此处会 throw 打崩预检）", async () => {
    const gate = new GitAccessGate();
    const r = await gate.check(
      user,
      agentWith([{ ...httpsRepo, url: "https://github.com/single-segment" }]),
    );
    expect(r.ready).toBe(false);
    expect(r.requirements[0]?.reason).toBe("provider_unavailable");
    expect(r.requirements[0]?.repositories[0]?.fingerprint).toBe(
      "https://github.com/single-segment",
    );
  });

  describe("凭证桥（credentialCode 本地解析）", () => {
    const credAgent = agentWith([{ ...jihulabRepo }]);

    it("用户已填值：item 随单携带 PAT，username 缺省用平台默认", async () => {
      const gate = new GitAccessGate(fakeCredentialSets({ access_token: "tok" }));
      const r = await gate.check(user, credAgent);
      expect(r.ready).toBe(true);
      expect(r.materializeItems[0]?.credential).toEqual({ username: "oauth2", accessToken: "tok" });
    });

    it("模板提供 user 键时优先用模板值", async () => {
      const gate = new GitAccessGate(fakeCredentialSets({ access_token: "tok", user: "alice" }));
      const r = await gate.check(user, credAgent);
      expect(r.materializeItems[0]?.credential?.username).toBe("alice");
    });

    it("用户未填值：不硬阻断，放行待通用凭证问询（item 无凭证）", async () => {
      const gate = new GitAccessGate(fakeCredentialSets(undefined));
      const r = await gate.check(user, credAgent);
      expect(r.ready).toBe(true);
      expect(r.materializeItems[0]?.credential).toBeUndefined();
      expect(r.requirements).toEqual([]);
    });

    it("凭证集 store 未装配：放行物化（凭证缺失在物化层报错引导）", async () => {
      const gate = new GitAccessGate();
      const r = await gate.check(user, credAgent);
      expect(r.ready).toBe(true);
      expect(r.materializeItems[0]?.credential).toBeUndefined();
    });
  });
});
