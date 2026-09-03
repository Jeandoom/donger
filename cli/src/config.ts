import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** CLI 本地配置（~/.donger/cli.json） */
export interface CliProfile {
  baseUrl: string;
  token: string;
  /** 上次使用的 agent（chat 默认复选） */
  lastAgentId?: string;
  /** 上次使用的会话 */
  lastConversationId?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3330";

export function profilePath(home = homedir()): string {
  return join(home, ".donger", "cli.json");
}

export function loadProfile(home = homedir()): CliProfile | null {
  const p = profilePath(home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CliProfile;
  } catch {
    return null;
  }
}

export function saveProfile(profile: CliProfile, home = homedir()): void {
  const p = profilePath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(profile, null, 2));
}

/** baseUrl 解析顺序：--url 参数 > DONGER_URL 环境变量 > 已存 profile > 默认本机 3330 */
export function resolveBaseUrl(explicit?: string, profile?: CliProfile | null): string {
  return (
    explicit?.replace(/\/$/, "") ||
    process.env.DONGER_URL?.replace(/\/$/, "") ||
    profile?.baseUrl ||
    DEFAULT_BASE_URL
  );
}
