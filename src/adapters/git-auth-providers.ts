import type { GitProvider } from "../domain/git.js";
import type {
  GitAuthorizationResult,
  GitAuthProviderAdapter,
  GitIdentity,
} from "../ports/git-auth-provider.js";

export interface GitOAuthClientConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface ProviderConfig {
  provider: GitProvider;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scopes: string[];
}

abstract class OAuthGitAuthProvider implements GitAuthProviderAdapter {
  abstract readonly provider: GitProvider;
  protected abstract readonly settings: ProviderConfig;

  constructor(
    private readonly oauth: GitOAuthClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get oauthConfigured(): boolean {
    return Boolean(this.oauth.clientId && this.oauth.clientSecret && this.oauth.redirectUri);
  }

  getAuthorizationUrl(state: string): string {
    this.assertOAuthConfigured();
    const url = new URL(this.settings.authorizeUrl);
    url.searchParams.set("client_id", this.oauth.clientId ?? "");
    url.searchParams.set("redirect_uri", this.oauth.redirectUri ?? "");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.settings.scopes.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<GitAuthorizationResult> {
    this.assertOAuthConfigured();
    const body = new URLSearchParams({
      client_id: this.oauth.clientId ?? "",
      client_secret: this.oauth.clientSecret ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: this.oauth.redirectUri ?? "",
    });
    const response = await this.fetchImpl(this.settings.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await readJson(response);
    const accessToken = stringField(payload, "access_token");
    if (!response.ok || !accessToken) throw new Error(`${this.provider} OAuth 换取 token 失败`);
    const identity = await this.fetchIdentity(accessToken);
    const expiresIn = numberField(payload, "expires_in");
    return {
      ...identity,
      authType: "oauth",
      accessToken,
      refreshToken: stringField(payload, "refresh_token"),
      scopes: parseScopes(payload.scope, this.settings.scopes),
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    };
  }

  async verifyPat(token: string): Promise<GitAuthorizationResult> {
    if (!token.trim()) throw new Error("访问令牌不能为空");
    const identity = await this.fetchIdentity(token.trim());
    return {
      ...identity,
      authType: "pat",
      accessToken: token.trim(),
      scopes: [],
    };
  }

  protected abstract parseIdentity(payload: Record<string, unknown>): GitIdentity;

  private async fetchIdentity(token: string): Promise<GitIdentity> {
    const response = await this.fetchImpl(this.settings.userUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "donger",
      },
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(`${this.provider} 访问令牌无效`);
    return this.parseIdentity(payload);
  }

  private assertOAuthConfigured(): void {
    if (!this.oauthConfigured) throw new Error(`${this.provider} OAuth 未配置`);
  }
}

export class GitHubAuthProvider extends OAuthGitAuthProvider {
  readonly provider = "github" as const;
  protected readonly settings: ProviderConfig = {
    provider: this.provider,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl: "https://api.github.com/user",
    scopes: ["repo", "read:user"],
  };

  protected parseIdentity(payload: Record<string, unknown>): GitIdentity {
    return identity(payload.id, payload.login, payload.avatar_url, this.provider);
  }
}

export class GiteeAuthProvider extends OAuthGitAuthProvider {
  readonly provider = "gitee" as const;
  protected readonly settings: ProviderConfig = {
    provider: this.provider,
    authorizeUrl: "https://gitee.com/oauth/authorize",
    tokenUrl: "https://gitee.com/oauth/token",
    userUrl: "https://gitee.com/api/v5/user",
    scopes: ["user_info", "projects"],
  };

  protected parseIdentity(payload: Record<string, unknown>): GitIdentity {
    return identity(payload.id, payload.login ?? payload.name, payload.avatar_url, this.provider);
  }
}

export class JihuLabAuthProvider extends OAuthGitAuthProvider {
  readonly provider = "jihulab" as const;
  protected readonly settings: ProviderConfig = {
    provider: this.provider,
    authorizeUrl: "https://jihulab.com/oauth/authorize",
    tokenUrl: "https://jihulab.com/oauth/token",
    userUrl: "https://jihulab.com/api/v4/user",
    scopes: ["read_user", "read_repository"],
  };

  protected parseIdentity(payload: Record<string, unknown>): GitIdentity {
    return identity(
      payload.id,
      payload.username ?? payload.name,
      payload.avatar_url,
      this.provider,
    );
  }
}

function identity(
  rawId: unknown,
  rawName: unknown,
  rawAvatar: unknown,
  provider: GitProvider,
): GitIdentity {
  if ((typeof rawId !== "string" && typeof rawId !== "number") || typeof rawName !== "string") {
    throw new Error(`${provider} 用户信息响应无效`);
  }
  return {
    accountId: String(rawId),
    accountName: rawName,
    avatarUrl: typeof rawAvatar === "string" ? rawAvatar : undefined,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseScopes(value: unknown, fallback: string[]): string[] {
  if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return fallback;
}
