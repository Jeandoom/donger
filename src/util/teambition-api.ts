import { createHmac, timingSafeEqual } from "node:crypto";
import type { TeambitionModuleConfig } from "../domain/module-config.js";

/**
 * Teambition 开放平台出站与 Webhook 验签（spec 2026-10-27-platform-message-subscription-design
 * §4.4 D3 / §4.6 D5 / §9.2 技术验证）：
 * - 验签：X-Signature = HMAC-SHA256(原始 body, appSecret) hex（官方 Node 示例同式）
 * - 出站凭证：appAccessToken = 本地 JWT 自签（HS256，payload {_appId, iat, exp}，1h），
 *   无 token 换取端点；请求头 Authorization Bearer + X-Tenant-Id: orgId + X-Tenant-Type: organization
 * - 任务评论：POST https://open.teambition.com/api/v3/task/{taskId}/comment body {content}
 */

const TB_OPEN_BASE = "https://open.teambition.com";
const APP_TOKEN_TTL_SEC = 3600;
/** 提前 5 分钟换签（自签零成本，仅省 CPU） */
const APP_TOKEN_REFRESH_MARGIN_MS = 300_000;

interface TokenCacheEntry {
  token: string;
  expMs: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();

/** 重置 token 缓存（测试用） */
export function resetTeambitionTokenCache(): void {
  tokenCache.clear();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** 应用授权凭证：本地 JWT 自签（HS256），带缓存至 exp 前余量 */
export function getAppAccessToken(appId: string, appSecret: string, now = Date.now()): string {
  const cached = tokenCache.get(appId);
  if (cached && now < cached.expMs - APP_TOKEN_REFRESH_MARGIN_MS) return cached.token;
  const iat = Math.floor(now / 1000);
  const exp = iat + APP_TOKEN_TTL_SEC;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ _appId: appId, iat, exp }));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", appSecret).update(signingInput).digest("base64url");
  const token = `${signingInput}.${signature}`;
  tokenCache.set(appId, { token, expMs: exp * 1000 });
  return token;
}

/** Webhook 请求合法性验证：X-Signature(hex) 与 HMAC-SHA256(rawBody, appSecret) 恒时比对 */
export function verifyWebhookSignature(
  rawBody: string,
  appSecret: string,
  signatureHex: string | undefined,
): boolean {
  if (!signatureHex) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHex.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 评论任务响应体（仅取排障字段，不回显原文全文） */
export interface TbCommentResult {
  dynamicId?: string;
}

/** 任务评论回写（source 回源通道出站适配） */
export async function createTaskComment(
  cfg: TeambitionModuleConfig,
  taskId: string,
  content: string,
): Promise<TbCommentResult> {
  const token = getAppAccessToken(cfg.appKey, cfg.appSecret);
  const res = await fetch(`${TB_OPEN_BASE}/api/v3/task/${encodeURIComponent(taskId)}/comment`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Tenant-Id": cfg.orgId,
      "X-Tenant-Type": "organization",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Teambition 评论失败 (${res.status}): ${text.slice(0, 200)}`);
  }
  try {
    const j = JSON.parse(text) as TbCommentResult;
    return j;
  } catch {
    return {};
  }
}
