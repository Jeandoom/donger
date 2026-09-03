import { createInterface } from "node:readline";
import { createApi } from "./api.js";
import { runChat } from "./chat.js";
import { loadProfile, profilePath, resolveBaseUrl, saveProfile } from "./config.js";

function usage(): void {
  console.log(`用法: donger <command> [options]

命令:
  login [secret]   用后端 CLI_TOKEN 换 JWT，保存到 ${profilePath()}
  chat             交互式对话（默认命令）

选项:
  --url <url>      后端地址（默认 DONGER_URL 环境变量或 http://127.0.0.1:3330）
  --agent <id|名称> chat 直接选择智能体
  -h, --help       帮助`);
}

interface ParsedArgs {
  cmd: string;
  url?: string;
  agent?: string;
  secret?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { cmd: "chat" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") parsed.url = argv[++i];
    else if (a === "--agent") parsed.agent = argv[++i];
    else if (a === "-h" || a === "--help") parsed.cmd = "help";
    else if (a) positional.push(a);
  }
  if (positional[0] === "login" || positional[0] === "chat") parsed.cmd = positional[0];
  if (positional[0] === "login") parsed.secret = positional[1];
  return parsed;
}

async function runLogin(baseUrl: string, secret?: string): Promise<void> {
  let token = secret;
  if (!token) {
    const rl = createInterface({ input: process.stdin });
    token = await new Promise<string>((resolve) => {
      rl.question("请输入后端 CLI_TOKEN: ", (ans) => resolve(ans.trim()));
    });
    rl.close();
  }
  if (!token) {
    console.error("未提供 CLI_TOKEN（后端 .env 配置 CLI_TOKEN 后可用）");
    process.exitCode = 1;
    return;
  }
  const { token: jwt, user } = await createApi(baseUrl, "").exchange(token);
  saveProfile({ baseUrl, token: jwt });
  console.log(`已登录：${user.name}（${user.role}）→ ${profilePath()}`);
}

async function main(): Promise<void> {
  const { cmd, url, agent, secret } = parseArgs(process.argv.slice(2));
  if (cmd === "help") {
    usage();
    return;
  }
  const profile = loadProfile();
  const baseUrl = resolveBaseUrl(url, profile);
  if (cmd === "login") {
    await runLogin(baseUrl, secret);
    return;
  }
  if (!profile?.token) {
    console.error("未登录。先运行: npm run dev:cli -- login <CLI_TOKEN>");
    process.exitCode = 1;
    return;
  }
  await runChat({ api: createApi(baseUrl, profile.token), baseUrl, token: profile.token, agent });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
