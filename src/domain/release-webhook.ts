/**
 * 发布 webhook 三平台验签与规范化（spec docs/superpowers/specs/2026-10-20-release-webhook-design.md §5.1）。
 * 不变量：webhook 是加速器不是裁判——payload 只承载「验签 + 唤醒」两个信息，部署决策
 * 永远由 host agent 自行 fetch origin/master 作出；本模块产出的字段仅进唤醒文件供观测，
 * host agent 不从中读任何部署决策输入。
 *
 * 三平台验签口径：
 *  - gitee  ：X-Gitee-Token 明文常量恒时比对（密码模式）
 *  - github ：X-Hub-Signature-256 = sha256=HMAC-SHA256(secret, rawBody)（必须用原始 body；
 *             fetch 层读出的 utf8 字符串与线上字节无损等价，HMAC 以 utf8 编码回补）
 *  - jihulab：X-Gitlab-Token 明文常量恒时比对
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_WEBHOOK_PROVIDERS = ["gitee", "github", "jihulab"] as const;
export type ReleaseWebhookProvider = (typeof RELEASE_WEBHOOK_PROVIDERS)[number];

export interface ReleaseWebhookSecrets {
  gitee?: string;
  github?: string;
  jihulab?: string;
}

/** 唤醒文件内容（全部字段仅观测用） */
export interface ReleaseWakeEvent {
  provider: ReleaseWebhookProvider;
  event: string;
  ref?: string;
  sha?: string;
  deliveryId?: string;
  ts: string;
}

export interface ReleaseWakeWriter {
  write(evt: ReleaseWakeEvent): Promise<void>;
}

/**
 * 原子写唤醒文件（temp+rename）。目录缺失/不可写时抛错——由路由层记日志并仍回 202
 * （轮询兜底）；刻意不做 mkdir 兜底：挂载缺失时 ENOENT 让故障显形，而非静默写进容器层。
 */
export function createWakeFileWriter(dir: string): ReleaseWakeWriter {
  return {
    async write(evt: ReleaseWakeEvent): Promise<void> {
      const name = `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const tmp = path.join(dir, `.${name}.tmp`);
      await writeFile(tmp, JSON.stringify(evt), "utf8");
      await rename(tmp, path.join(dir, name));
    },
  };
}

export interface ReleaseWebhookVerdict {
  ok: boolean;
  /** 拒绝码：404=provider 未知或未配置（不暴露存在性）、403=验签失败 */
  status: number;
  error?: string;
  /** 唤醒载荷（ok=true 时给出，含非唤醒事件，供日志观测） */
  wake?: ReleaseWakeEvent;
  /** push 事件且 ref=refs/heads/master 且非删除 → 唤醒；其余（ping/分支/tag）202 静默 */
  shouldWake: boolean;
}

type HeadersLike = Record<string, string | string[] | undefined>;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function firstHeader(headers: HeadersLike, name: string): string {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? "";
  return "";
}

/** best-effort 解析 payload；解析失败不阻断验签（github HMAC 按原始 body 字节） */
function parsePayload(raw: string): { ref?: string; after?: string; deleted?: boolean } {
  try {
    const p = JSON.parse(raw) as { ref?: unknown; after?: unknown; deleted?: unknown };
    return {
      ref: typeof p.ref === "string" ? p.ref : undefined,
      after: typeof p.after === "string" ? p.after : undefined,
      deleted: p.deleted === true,
    };
  } catch {
    return {};
  }
}

export function verifyReleaseWebhook(input: {
  provider: string;
  secrets: ReleaseWebhookSecrets;
  headers: HeadersLike;
  rawBody: string;
}): ReleaseWebhookVerdict {
  const provider = input.provider as ReleaseWebhookProvider;
  if (!(RELEASE_WEBHOOK_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, status: 404, error: "not found", shouldWake: false };
  }
  const secret = input.secrets[provider];
  if (!secret) return { ok: false, status: 404, error: "not found", shouldWake: false };

  const h = (name: string): string => firstHeader(input.headers, name);
  let event = "other";
  let sigOk = false;
  if (provider === "gitee") {
    sigOk = safeEqual(h("x-gitee-token"), secret);
    const ev = h("x-gitee-event");
    event = ev === "Push Hook" ? "push" : ev === "Ping Hook" ? "ping" : ev || "other";
  } else if (provider === "github") {
    const sig = h("x-hub-signature-256");
    const expected =
      "sha256=" + createHmac("sha256", secret).update(input.rawBody, "utf8").digest("hex");
    sigOk = safeEqual(sig, expected);
    event = h("x-github-event") || "other";
  } else {
    sigOk = safeEqual(h("x-gitlab-token"), secret);
    const ev = h("x-gitlab-event");
    event = ev === "Push Hook" ? "push" : ev || "other";
  }
  if (!sigOk) {
    return { ok: false, status: 403, error: "signature verification failed", shouldWake: false };
  }

  const payload = parsePayload(input.rawBody);
  // github 分支删除推 after=全零 SHA；^0{40}$ 一并挡 gitee/jihulab 同形载荷
  const isMasterPush =
    event === "push" &&
    payload.ref === "refs/heads/master" &&
    !payload.deleted &&
    !/^0{40}$/.test(payload.after ?? "");
  return {
    ok: true,
    status: 202,
    shouldWake: isMasterPush,
    wake: {
      provider,
      event,
      ref: payload.ref,
      sha: payload.after,
      deliveryId: h("x-github-delivery") || h("x-gitee-delivery") || h("x-gitee-uuid") || undefined,
      ts: new Date().toISOString(),
    },
  };
}
