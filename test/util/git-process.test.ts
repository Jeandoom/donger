// git 子进程认证通道强制隔离的回归测试：
// 平台只允许 HTTPS + PAT/匿名（凭证桥单一通道），宿主机 SSH 公钥/credential helper/
// 外部 AskPass/env 注入配置一律 fail-closed（策略见 src/util/git-process.ts 文件头）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitProcess } from "../../src/util/git-process.js";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  savedEnv.__cleared = undefined;
  roots.splice(0).forEach((r) => {
    rmSync(r, { recursive: true, force: true });
  });
});

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_/.test(key) || key === "GIT_CONFIG_COUNT") delete process.env[key];
  }
  roots.splice(0).forEach((r) => {
    rmSync(r, { recursive: true, force: true });
  });
});

describe("git 子进程认证通道隔离", () => {
  it("剥离继承的 GIT_CONFIG_COUNT/KEY_n/VALUE_n 环境注入配置", async () => {
    setEnv("GIT_CONFIG_COUNT", "1");
    setEnv("GIT_CONFIG_KEY_0", "credential.helper");
    setEnv("GIT_CONFIG_VALUE_0", "injected-fake-helper");
    const r = await runGitProcess(["config", "--get-all", "credential.helper"], {}, 15_000);
    // 注入值必须不出现；系统级存量 helper（如 manager）在 config 列表层面仍可见，
    // 但凭证机的 helper 列表已被 -c 复位（见下一条行为测试）
    expect(r.stdout).not.toContain("injected-fake-helper");
  });

  it("-c credential.helper= 复位宿主机/全局凭证助手（GCM 不得向匿名操作供凭）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-iso-"));
    roots.push(dir);
    const fakeConfig = join(dir, "global.gitconfig");
    writeFileSync(fakeConfig, "[credential]\n\thelper = !echo password=hacked\n");
    setEnv("GIT_CONFIG_GLOBAL", fakeConfig);
    // credential fill：全局 helper 会吐 password=hacked；隔离复位后必须为空，随后在
    // askpass/终端环节失败（均为预期）——关键断言是「hacked 不出现」
    const r = await runGitProcess(["credential", "fill"], {}, 15_000);
    expect(`${r.stdout}\n${r.stderr}`).not.toContain("hacked");
  }, 20_000);

  it("SSH 通道 fail-closed：GIT_SSH 指向占位命令，ssh 形式 URL 立即报错", async () => {
    const r = await runGitProcess(["ls-remote", "git@github.com:acme/repo.git"], {}, 30_000);
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toContain("donger-git-ssh-disabled");
  }, 40_000);
});
