import { describe, expect, it } from "vitest";
import {
  HOST_KEY_SPECS,
  sshEndpointFromValues,
  withKindKeySpecs,
} from "../../src/domain/credential.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { canViewerUseHostTools, hostToolDefinitions } from "../../src/orchestrator/host-tools.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { SshCommandRunner } from "../../src/ports/ssh-command-runner.js";

const HOST_VALUES = {
  host: "homedb.example.com",
  port: "22",
  username: "ubuntu",
  password: "secret",
};

function credStore(
  templates: Array<{
    code: string;
    name: string;
    kind: "generic" | "git" | "host";
    description?: string;
  }>,
  filledByUser: Record<string, Record<string, string>> = {},
): CredentialSetStore {
  return {
    listTemplates: async () => templates,
    getTemplate: async (code) => templates.find((t) => t.code === code),
    listValueCodes: async (userId) => Object.keys(filledByUser[userId] ?? {}),
    getFilledValues: async (userId, codes) =>
      codes
        .filter((c) => filledByUser[userId]?.[c])
        .map((c) => ({
          userId,
          code: c,
          values: filledByUser[userId]?.[c],
          createdAt: "t",
          updatedAt: "t",
        })),
  } as unknown as CredentialSetStore;
}

function tools(
  viewer: { id: string; role: "admin" | "user" },
  store: CredentialSetStore,
  runner?: SshCommandRunner,
) {
  const ssh =
    runner ?? ((async () => ({ exitCode: 0, stdout: "out", stderr: "" })) as SshCommandRunner);
  const defs = hostToolDefinitions({ viewer, credentialSets: store, sshRunner: ssh });
  const byName = (n: string) => {
    const t = defs.find((d) => d.name === n);
    if (!t) throw new Error(`tool not found: ${n}`);
    return t;
  };
  return { byName };
}

const HOST_TPL = [{ code: "ssh-homedb", name: "homedb", kind: "host" as const }];

describe("credential 域 host kind", () => {
  it("kind=host 模板键收口为固定五键；generic 原样", () => {
    const h = withKindKeySpecs({ kind: "host", keySpecs: [{ key: "whatever" }] });
    expect(h.keySpecs).toEqual(HOST_KEY_SPECS);
    const g = withKindKeySpecs({ kind: "generic", keySpecs: [{ key: "k" }] });
    expect(g.keySpecs).toEqual([{ key: "k" }]);
  });
  it("sshEndpointFromValues：缺端点/缺认证/正常解析（port 缺省 22）", () => {
    expect(() => sshEndpointFromValues({ password: "x" }, "c")).toThrow(/host\/username/);
    expect(() => sshEndpointFromValues({ host: "h", username: "u" }, "c")).toThrow(/认证材料/);
    const ep = sshEndpointFromValues({ host: "h", username: "u", private_key: "K" }, "c");
    expect(ep).toMatchObject({ host: "h", port: 22, username: "u", privateKey: "K" });
  });
});

describe("canViewerUseHostTools（挂载判定 v3）", () => {
  it("admin 恒可；有 host 已填值可；未填/无 host 模板不可", async () => {
    const store = credStore(HOST_TPL, { u1: { "ssh-homedb": HOST_VALUES } });
    expect(await canViewerUseHostTools(store, { id: "a", role: "admin" })).toBe(true);
    expect(await canViewerUseHostTools(store, { id: "u1", role: "user" })).toBe(true);
    expect(await canViewerUseHostTools(store, { id: "u2", role: "user" })).toBe(false);
    const noTpl = credStore([{ code: "g", name: "g", kind: "generic" }], { u1: { g: { x: "y" } } });
    expect(await canViewerUseHostTools(noTpl, { id: "u1", role: "user" })).toBe(false);
  });
});

describe("donger-host 工具集 v3（凭证化）", () => {
  it("resolveHost：未配置值 → isError（提示补全）；非 host 模板拒绝", async () => {
    const store = credStore(HOST_TPL, {});
    const r = await tools({ id: "u1", role: "user" }, store)
      .byName("host_status")
      .handler({ hostCode: "ssh-homedb" });
    expect(r.isError).toBe(true);
    expect((r as { content: Array<{ text: string }> }).content[0]?.text).toContain("补全");
    const genericStore = credStore([{ code: "g", name: "g", kind: "generic" }], {
      u1: { g: { x: "y" } },
    });
    const bad = await tools({ id: "u1", role: "user" }, genericStore)
      .byName("host_status")
      .handler({ hostCode: "g" });
    expect(bad.isError).toBe(true);
  });

  it("host_logs_tail：值解析端点 + 固定命令模板 + 元字符拒绝", async () => {
    const commands: Array<{ endpoint: { host: string }; cmd: string }> = [];
    const store = credStore(HOST_TPL, { u1: { "ssh-homedb": HOST_VALUES } });
    const runner: SshCommandRunner = async (endpoint, _auth, cmd) => {
      commands.push({ endpoint, cmd });
      return { exitCode: 0, stdout: "log", stderr: "" };
    };
    const { byName } = tools({ id: "u1", role: "user" }, store, runner);
    const r = await byName("host_logs_tail").handler({
      hostCode: "ssh-homedb",
      file: "/var/log/app.log",
      lines: 50,
    });
    expect(r.isError).toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.endpoint.host).toBe("homedb.example.com");
    expect(commands[0]?.cmd).toBe("tail -n 50 /var/log/app.log");
    const bad = await byName("host_logs_tail").handler({
      hostCode: "ssh-homedb",
      file: "/var/log/a;rm -rf /",
    });
    expect(bad.isError).toBe(true);
    expect(commands).toHaveLength(1);
  });

  it("host_exec：命令透传（按 code 取端点）；多行拒绝", async () => {
    const commands: string[] = [];
    const store = credStore(HOST_TPL, { u1: { "ssh-homedb": HOST_VALUES } });
    const { byName } = tools({ id: "u1", role: "user" }, store, async (_e, _a, cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "done", stderr: "" };
    });
    const deployCmd = "cd /srv/app && git pull origin master && sudo systemctl restart stock";
    const r = await byName("host_exec").handler({ hostCode: "ssh-homedb", command: deployCmd });
    expect(r.isError).toBeUndefined();
    expect(commands).toEqual([deployCmd]);
    const bad = await byName("host_exec").handler({
      hostCode: "ssh-homedb",
      command: "cd /x\nrm -rf /",
    });
    expect(bad.isError).toBe(true);
  });

  it("hosts_list：标注已配置/未配置", async () => {
    const store = credStore(HOST_TPL, { u1: { "ssh-homedb": HOST_VALUES } });
    const text = (
      (await tools({ id: "u1", role: "user" }, store).byName("hosts_list").handler({})) as {
        content: Array<{ text: string }>;
      }
    ).content[0]?.text;
    expect(text).toContain("ssh-homedb｜homedb｜已配置");
    const text2 = (
      (await tools({ id: "u2", role: "user" }, store).byName("hosts_list").handler({})) as {
        content: Array<{ text: string }>;
      }
    ).content[0]?.text;
    expect(text2).toContain("未配置");
  });
});

describe("host-ops 审批门", () => {
  const g = createDefaultGates();
  it("host_exec / host_logs_clean 命中 force 门；只读工具不设门", () => {
    for (const t of ["host_exec", "host_logs_clean"]) {
      expect(g.match(`mcp__donger-host__${t}`, {})?.gateId).toBe("host-ops");
      expect(g.match(`mcp__donger-host__${t}`, {})?.force).toBe(true);
    }
    for (const t of [
      "hosts_list",
      "host_status",
      "host_disk_usage",
      "host_process_top",
      "host_logs_tail",
    ]) {
      expect(g.match(`mcp__donger-host__${t}`, {})).toBeUndefined();
    }
  });
});
