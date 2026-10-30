import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { Logger } from "../util/logger.js";

/**
 * Teambition MCP token 常驻续期（spec 2026-10-27-platform-message-subscription-design §D-D
 * 用户级操作面的可用性前提）：TB MCP access_token 有效期 1h，连接器头引用凭证
 * `tb-mcp` 的 TOKEN 键——过期后 SDK 会话启动握手 401、MCP 服务被整体剔除（2026-10-29 生产实锤）。
 * 凭证三件套约定：{ TOKEN, REFRESH_TOKEN, CLIENT_ID }；刷新走授权服务器
 * refresh_token grant（public client 无 secret），refresh_token 轮换则同步回写。
 * 任一用户刷新失败仅记日志跳过（fail-open），不影响其他用户与其余启动流程。
 */

export const TB_CREDENTIAL_CODE = "tb-mcp";
const TOKEN_URL = "https://account.teambition.com/oauth2/mcp/token";
const RESOURCE = "https://open.teambition.com/api/mcp/v2";
/** 刷新周期：45min（access 1h，留 15min 余量） */
export const DEFAULT_REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export interface TeambitionTokenRefresherDeps {
  credentialSets: Pick<
    CredentialSetStore,
    "listUserIdsWithValue" | "getFilledValues" | "upsertValue"
  >;
  logger: Logger;
  /** 刷新周期；0=仅启动执行一次（测试用）。缺省 45min */
  intervalMs?: number;
}

export interface RefreshOutcome {
  refreshed: number;
  skipped: number;
  failed: number;
}

/** 单轮刷新：遍历已填 tb-mcp 凭证的用户，逐个 refresh_token 换新并回写凭证 */
export async function refreshTeambitionTokensOnce(
  deps: Pick<TeambitionTokenRefresherDeps, "credentialSets" | "logger">,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  const { credentialSets, logger } = deps;
  const out: RefreshOutcome = { refreshed: 0, skipped: 0, failed: 0 };
  let userIds: string[] = [];
  try {
    userIds = await credentialSets.listUserIdsWithValue(TB_CREDENTIAL_CODE);
  } catch (e) {
    logger.error({ err: String(e) }, "tb token refresh: 列举用户失败");
    return { ...out, failed: out.failed + 1 };
  }
  for (const userId of userIds) {
    try {
      const values = (await credentialSets.getFilledValues(userId, [TB_CREDENTIAL_CODE]))[0]
        ?.values;
      const refreshToken = values?.REFRESH_TOKEN;
      const clientId = values?.CLIENT_ID;
      if (!refreshToken || !clientId) {
        out.skipped += 1;
        continue;
      }
      const res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          resource: RESOURCE,
        }),
      });
      const j = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !j.access_token) {
        out.failed += 1;
        logger.error(
          { userId, status: res.status, err: j.error_description ?? j.error },
          "tb token refresh: 刷新失败",
        );
        continue;
      }
      await credentialSets.upsertValue(userId, TB_CREDENTIAL_CODE, {
        TOKEN: j.access_token,
        REFRESH_TOKEN: j.refresh_token ?? refreshToken,
        CLIENT_ID: clientId,
      });
      out.refreshed += 1;
      logger.info({ userId }, "tb token refresh: 已续期");
    } catch (e) {
      out.failed += 1;
      logger.error({ userId, err: String(e) }, "tb token refresh: 异常");
    }
  }
  return out;
}

export class TeambitionTokenRefresher {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: TeambitionTokenRefresherDeps) {}

  start(): void {
    const interval = this.deps.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    void refreshTeambitionTokensOnce(this.deps).catch(() => {});
    if (interval > 0) {
      this.timer = setInterval(() => {
        void refreshTeambitionTokensOnce(this.deps).catch(() => {});
      }, interval);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
