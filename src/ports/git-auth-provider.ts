import type { GitAuthType, GitProvider } from "../domain/git.js";

export interface GitIdentity {
  accountId: string;
  accountName: string;
  avatarUrl?: string;
}

export interface GitAuthorizationResult extends GitIdentity {
  authType: GitAuthType;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: string;
}

export interface GitAuthProviderAdapter {
  readonly provider: GitProvider;
  readonly oauthConfigured: boolean;
  getAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<GitAuthorizationResult>;
  verifyPat(token: string): Promise<GitAuthorizationResult>;
}
