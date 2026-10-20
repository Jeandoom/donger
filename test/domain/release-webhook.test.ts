import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWakeFileWriter,
  type ReleaseWebhookSecrets,
  verifyReleaseWebhook,
} from "../../src/domain/release-webhook.js";

/**
 * 发布 webhook 三平台验签单测（spec 2026-10-20-release-webhook-design §5.1/§11）：
 * 验签口径（gitee 明文 token / github HMAC / jihulab token）、唤醒过滤（仅 master push）、
 * 未配置 404 不暴露、唤醒文件原子落盘与目录缺失显形。
 */

const SECRET = "test-secret";
const SECRETS: ReleaseWebhookSecrets = { gitee: SECRET, github: SECRET, jihulab: SECRET };
const SHA = "a".repeat(40);
const MASTER_PUSH = JSON.stringify({ ref: "refs/heads/master", after: SHA });

function giteeHeaders(token: string, event = "Push Hook"): Record<string, string> {
  return { "x-gitee-token": token, "x-gitee-event": event };
}
function githubHeaders(secret: string, body: string, event = "push"): Record<string, string> {
  return {
    "x-hub-signature-256":
      "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    "x-github-event": event,
    "x-github-delivery": "d-123",
  };
}

describe("verifyReleaseWebhook", () => {
  it("未知 provider / 未配置密钥 → 404 不暴露存在性", () => {
    for (const provider of ["gitlab", "../etc", ""]) {
      expect(
        verifyReleaseWebhook({ provider, secrets: SECRETS, headers: {}, rawBody: MASTER_PUSH })
          .status,
      ).toBe(404);
    }
    expect(
      verifyReleaseWebhook({
        provider: "github",
        secrets: { gitee: SECRET },
        headers: githubHeaders(SECRET, MASTER_PUSH),
        rawBody: MASTER_PUSH,
      }).status,
    ).toBe(404);
  });

  it("gitee：正确 token + master push → 唤醒；错 token → 403", () => {
    const ok = verifyReleaseWebhook({
      provider: "gitee",
      secrets: SECRETS,
      headers: giteeHeaders(SECRET),
      rawBody: MASTER_PUSH,
    });
    expect(ok.ok).toBe(true);
    expect(ok.shouldWake).toBe(true);
    expect(ok.wake?.provider).toBe("gitee");
    expect(ok.wake?.sha).toBe(SHA);

    const bad = verifyReleaseWebhook({
      provider: "gitee",
      secrets: SECRETS,
      headers: giteeHeaders("wrong-token"),
      rawBody: MASTER_PUSH,
    });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(403);
  });

  it("github：HMAC 正确签名 → 唤醒；签名对 body 敏感；错签 → 403", () => {
    const ok = verifyReleaseWebhook({
      provider: "github",
      secrets: SECRETS,
      headers: githubHeaders(SECRET, MASTER_PUSH),
      rawBody: MASTER_PUSH,
    });
    expect(ok.shouldWake).toBe(true);
    expect(ok.wake?.deliveryId).toBe("d-123");

    // 用另一份合法 payload 但签名是原 body 的 → HMAC 对 body 逐字节敏感
    const tampered = verifyReleaseWebhook({
      provider: "github",
      secrets: SECRETS,
      headers: githubHeaders(SECRET, MASTER_PUSH),
      rawBody: JSON.stringify({ ref: "refs/heads/master", after: "b".repeat(40) }),
    });
    expect(tampered.status).toBe(403);
  });

  it("github：ping / 非 master 分支 / deleted / 全零 after → 验签过但不唤醒", () => {
    const base = { provider: "github" as const, secrets: SECRETS };
    const branch = JSON.stringify({ ref: "refs/heads/feature-x", after: "b".repeat(40) });
    expect(
      verifyReleaseWebhook({
        ...base,
        headers: githubHeaders(SECRET, branch),
        rawBody: branch,
      }).shouldWake,
    ).toBe(false);
    expect(
      verifyReleaseWebhook({
        ...base,
        headers: githubHeaders(SECRET, "{}", "ping"),
        rawBody: "{}",
      }).shouldWake,
    ).toBe(false);
    const deleted = JSON.stringify({ ref: "refs/heads/master", deleted: true });
    expect(
      verifyReleaseWebhook({
        ...base,
        headers: githubHeaders(SECRET, deleted),
        rawBody: deleted,
      }).shouldWake,
    ).toBe(false);
    const zeroed = JSON.stringify({ ref: "refs/heads/master", after: "0".repeat(40) });
    expect(
      verifyReleaseWebhook({
        ...base,
        headers: githubHeaders(SECRET, zeroed),
        rawBody: zeroed,
      }).shouldWake,
    ).toBe(false);
  });

  it("jihulab：token + Push Hook master → 唤醒；Tag Push Hook → 不唤醒；错 token → 403", () => {
    const ok = verifyReleaseWebhook({
      provider: "jihulab",
      secrets: SECRETS,
      headers: { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook" },
      rawBody: MASTER_PUSH,
    });
    expect(ok.shouldWake).toBe(true);
    const tag = verifyReleaseWebhook({
      provider: "jihulab",
      secrets: SECRETS,
      headers: { "x-gitlab-token": SECRET, "x-gitlab-event": "Tag Push Hook" },
      rawBody: JSON.stringify({ ref: "refs/tags/v1" }),
    });
    expect(tag.ok).toBe(true);
    expect(tag.shouldWake).toBe(false);
    expect(
      verifyReleaseWebhook({
        provider: "jihulab",
        secrets: SECRETS,
        headers: { "x-gitlab-token": "nope", "x-gitlab-event": "Push Hook" },
        rawBody: MASTER_PUSH,
      }).status,
    ).toBe(403);
  });

  it("gitee Ping Hook → 验签过但不唤醒；payload 非 JSON → 不唤醒（不阻断验签）", () => {
    const ping = verifyReleaseWebhook({
      provider: "gitee",
      secrets: SECRETS,
      headers: giteeHeaders(SECRET, "Ping Hook"),
      rawBody: "{}",
    });
    expect(ping.shouldWake).toBe(false);
    const junk = verifyReleaseWebhook({
      provider: "gitee",
      secrets: SECRETS,
      headers: giteeHeaders(SECRET),
      rawBody: "not-json",
    });
    expect(junk.ok).toBe(true);
    expect(junk.shouldWake).toBe(false);
  });
});

describe("createWakeFileWriter", () => {
  it("原子落盘：wake-*.json 可读且无临时残留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-writer-"));
    await createWakeFileWriter(dir).write({
      provider: "gitee",
      event: "push",
      ref: "refs/heads/master",
      ts: "2026-10-20T00:00:00.000Z",
    });
    const files = readdirSync(dir).filter((f) => f.startsWith("wake-"));
    expect(files).toHaveLength(1);
    const file = files[0];
    if (!file) throw new Error("wake file missing");
    const evt = JSON.parse(readFileSync(join(dir, file), "utf8")) as { provider: string };
    expect(evt.provider).toBe("gitee");
  });

  it("目录缺失 → 抛错显形（不静默写进容器层）", async () => {
    const missing = join(tmpdir(), `wake-missing-${Date.now()}`, "no-such");
    expect(existsSync(missing)).toBe(false);
    await expect(
      createWakeFileWriter(missing).write({ provider: "gitee", event: "push", ts: "t" }),
    ).rejects.toThrow();
  });
});
