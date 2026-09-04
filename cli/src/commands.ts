import { createInterface } from "node:readline";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { type ApiError, createApi, type DongerApi } from "./api.js";
import { CLI_VERSION, runAsk, runChat } from "./chat.js";
import { loadProfile, profilePath, resolveBaseUrl, saveProfile } from "./config.js";

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const id8 = (v: unknown): string => s(v).slice(0, 8);
const asArr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function fmtDate(v: unknown): string {
  return s(v).replace("T", " ").slice(0, 16);
}

function formatError(e: unknown): string {
  const err = e as ApiError;
  if (err?.kind === "auth")
    return pc.red(`登录已过期或权限不足（${err.message}）→ 运行 donger login`);
  if (err?.kind === "network") return pc.red(`${err.message}（确认后端已启动）`);
  return pc.red(e instanceof Error ? e.message : String(e));
}

interface Globals {
  url?: string;
  json?: boolean;
}

function globals(cmd: Command): Globals {
  return cmd.optsWithGlobals() as Globals;
}

/** 所有命令共用的前置：读 profile → 建 api。未登录抛错由 run 统一呈现。 */
function requireApi(cmd: Command): { api: DongerApi; baseUrl: string; token: string } {
  const profile = loadProfile();
  if (!profile?.token) {
    throw new Error("未登录。先在后端 .env 配置 CLI_TOKEN，再运行 donger login <CLI_TOKEN>");
  }
  const baseUrl = resolveBaseUrl(globals(cmd).url, profile);
  return { api: createApi(baseUrl, profile.token), baseUrl, token: profile.token };
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(formatError(e));
    process.exitCode = 1;
  }
}

/** TTY 下静默读入密钥（echo *）；非 TTY 且无值则报错 */
function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY !== true) return Promise.reject(new Error("需要提供 value"));
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    const chars: string[] = [];
    const wasRaw = stdin.isRaw;
    const onKey = (buf: Buffer): void => {
      const c = buf.toString();
      if (c === "\r" || c === "\n" || c === "\x03") finish();
      else if (c === "\x7f" || c === "\b") {
        if (chars.length > 0) {
          chars.pop();
          process.stdout.write("\b \b");
        }
      } else if (c >= " ") {
        chars.push(c);
        process.stdout.write("*");
      }
    };
    function finish(): void {
      stdin.removeListener("data", onKey);
      stdin.setRawMode?.(wasRaw ?? false);
      process.stdout.write("\n");
      resolve(chars.join(""));
    }
    stdin.setRawMode?.(true);
    stdin.on("data", onKey);
  });
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
  if (!token) throw new Error("未提供 CLI_TOKEN（后端 .env 配置 CLI_TOKEN 后可用）");
  const { token: jwt, user } = await createApi(baseUrl, "")
    .exchange(token)
    .catch((e: unknown) => {
      // login 场景的 auth 失败是「密钥不对」而非「登录过期」，避免「运行 donger login」死循环提示
      if ((e as ApiError)?.kind === "auth") {
        throw new Error("CLI_TOKEN 无效：请核对后端 .env 中的 CLI_TOKEN 后重试");
      }
      throw e as Error;
    });
  saveProfile({ baseUrl, token: jwt });
  console.log(`已登录：${user.name}（${user.role}）→ ${profilePath()}`);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("donger")
    .description("donger CLI 前端：对话 + 能力验证 + 轻管理")
    .version(CLI_VERSION)
    .option("--url <url>", "后端地址（默认 DONGER_URL 或已保存 profile）")
    .option("--json", "机器可读 JSON 输出");

  // ── 登录 ──
  program
    .command("login")
    .description("用后端 CLI_TOKEN 换 JWT 并保存")
    .argument("[secret]", "CLI_TOKEN（缺省交互输入）")
    .action((secret: string | undefined, _opts: object, cmd: Command) =>
      run(async () => {
        const profile = loadProfile();
        await runLogin(resolveBaseUrl(globals(cmd).url, profile), secret);
      }),
    );

  // ── chat / ask ──
  const chat = program
    .command("chat", { isDefault: true })
    .description("交互式对话（默认命令）")
    .option("-a, --agent <id|名称>", "直接选择智能体")
    // isDefault 使未知词落入 chat；捕获后显式报「未知命令」而非 commander 的莫名多参错误
    .argument("[extra...]", "", [])
    .action((extra: string[], opts: { agent?: string }, cmd: Command) =>
      run(async () => {
        if (extra.length > 0) {
          throw new Error(`未知命令 "${extra[0]}"，运行 donger --help 查看全部命令`);
        }
        const { api, baseUrl, token } = requireApi(cmd);
        await runChat({ api, baseUrl, token, agent: opts.agent });
      }),
    );

  program
    .command("ask")
    .description("一次性问答：输出回复后退出，exit code 表成败（审批自动驳回）")
    .argument("<text...>")
    .option("-a, --agent <id|名称>", "直接选择智能体")
    .action(async (text: string[], opts: { agent?: string }, cmd: Command) => {
      await run(async () => {
        const { api, baseUrl, token } = requireApi(cmd);
        process.exitCode = await runAsk({ api, baseUrl, token, agent: opts.agent }, text.join(" "));
      });
    });

  program
    .command("agent-new")
    .description("AI 生成助手：对话式创建 agent / skill（写操作经审批卡确认后落库）")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api, baseUrl, token } = requireApi(cmd);
        // 内置 assist 智能体（builtin-assist，不入库）：后端短路解析，写操作过 authoring 门
        await runChat({ api, baseUrl, token, agent: "builtin-assist" });
      }),
    );

  // ── tasks ──
  const tasks = program.command("tasks").description("任务查看与管理");
  tasks
    .command("list")
    .description("任务列表（创建时间倒序，含 phase/agent）")
    .option("-s, --status <status>", "按状态过滤：created/running/done/failed")
    .action((opts: { status?: string }, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
        const list = asArr(await api.call("GET", `/api/tasks${qs}`)).sort((a, b) =>
          s(b.createdAt).localeCompare(s(a.createdAt)),
        );
        if (globals(cmd).json) return printJson(list);
        for (const t of list) {
          console.log(
            `${id8(t.id)}  ${s(t.status).padEnd(9)}  ${(s(t.phase) || "-").padEnd(8)}  ${id8(t.agentId) || "-"}  ${fmtDate(t.createdAt)}  ${truncate(s(t.prompt) || s(t.text) || s(t.skill), 40)}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  tasks
    .command("running")
    .description("运行中任务实时状态（支持 --watch 持续刷新）")
    .option("-w, --watch", "持续刷新直到无运行中任务（Ctrl+C 退出）")
    .option("--interval <sec>", "刷新间隔秒数（默认 3）", (v: string): number => {
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("需为正整数");
      return n;
    })
    .action((opts: { watch?: boolean; interval?: number }, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const render = async (): Promise<number> => {
          const list = asArr(await api.call("GET", "/api/tasks?status=running"));
          const now = Date.now();
          process.stdout.write("\x1b[2J\x1b[H");
          console.log(
            pc.bold(`运行中任务 ${list.length} 个`) +
              pc.dim(`  ${new Date().toLocaleTimeString()}（Ctrl+C 退出）`),
          );
          for (const t of list) {
            const elapsed = Math.max(0, now - new Date(s(t.createdAt) || now).getTime());
            const mins = Math.floor(elapsed / 60000);
            const secs = Math.floor((elapsed % 60000) / 1000);
            console.log(
              `${id8(t.id)}  ${pc.yellow((s(t.phase) || "running").padEnd(8))}  ${id8(t.agentId) || "-"}  ${pc.dim(`${mins}m${String(secs).padStart(2, "0")}s`)}  ${truncate(s(t.prompt), 46)}`,
            );
          }
          return list.length;
        };
        if (!opts.watch) {
          const n = await render();
          if (n === 0) console.log("（当前无运行中任务）");
          return;
        }
        for (;;) {
          const n = await render();
          if (n === 0) {
            console.log("无运行中任务，监控退出");
            return;
          }
          await new Promise((r) => setTimeout(r, (opts.interval ?? 3) * 1000));
        }
      }),
    );
  tasks
    .command("cancel <id>")
    .description("取消运行中的任务")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const task = (await api.call("GET", `/api/tasks/${id}`)) as { threadId?: string };
        if (!task.threadId || task.threadId === "dispatch") {
          throw new Error("该任务没有可取消的会话（可能已完成或为分发内部任务）");
        }
        try {
          await api.cancel(task.threadId);
        } catch (e) {
          if ((e as ApiError).status === 409)
            throw new Error("任务未在运行中（可能已完成或已超时）");
          throw e;
        }
        console.log("已发送取消请求");
      }),
    );
  tasks
    .command("result <id>")
    .description("查看任务最终输出（后台任务 / 错过推送时回看）")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const task = (await api.call("GET", `/api/tasks/${id}`)) as {
          threadId?: string;
          status?: string;
          error?: string;
        };
        if (task.status === "failed") {
          console.error(pc.red(`任务失败：${s(task.error) || "未知原因"}`));
          return;
        }
        if (!task.threadId || task.threadId === "dispatch") {
          throw new Error("该任务没有关联会话，无法回看输出");
        }
        const msgs = asArr(await api.history(task.threadId)).filter((m) => s(m.role) === "bot");
        const last = msgs.at(-1);
        if (!last) {
          console.log("（尚无 bot 输出）");
          return;
        }
        console.log(last.text);
      }),
    );
  tasks
    .command("show <id>")
    .description("任务详情")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("GET", `/api/tasks/${id}`));
      }),
    );
  tasks
    .command("events <id>")
    .description("任务全量审计事件（T17.3 观测：llm/tool/结果流水）")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const list = asArr(await api.call("GET", `/api/tasks/${id}/events`));
        if (globals(cmd).json) return printJson(list);
        for (const e of list) {
          const head = `${s(e.recordedAt).slice(11, 19)}  ${s(e.type).padEnd(11)}`;
          const usage = e.usage as { totalTokens?: number } | undefined;
          const detail =
            s(e.toolName) ||
            truncate(s(e.text).replace(/\s+/g, " "), 60) ||
            (usage?.totalTokens ? `${usage.totalTokens} tok` : "");
          console.log(`${head}  ${detail}`);
        }
        // 观测汇总行：工具计数 / token 总量 / 执行耗时
        const toolCounts = new Map<string, number>();
        let totalTokens = 0;
        let totalMs = 0;
        for (const e of list) {
          if (s(e.type) === "tool_use") {
            const n = s(e.toolName) || "?";
            toolCounts.set(n, (toolCounts.get(n) ?? 0) + 1);
          }
          const u = e.usage as { totalTokens?: number } | undefined;
          if (u?.totalTokens) totalTokens += u.totalTokens;
          if (s(e.type) === "result") totalMs += Number(e.durationMs ?? 0);
        }
        const tools = [...toolCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}×${c}`)
          .join("、");
        console.error(
          pc.dim(
            `汇总：工具 ${tools || "无"} · tokens ${totalTokens} · 执行耗时 ${(totalMs / 1000).toFixed(1)}s`,
          ),
        );
      }),
    );
  tasks
    .command("comments <id>")
    .description("任务评论列表")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const list = asArr(await api.call("GET", `/api/tasks/${id}/comments`));
        if (globals(cmd).json) return printJson(list);
        for (const c of list) {
          console.log(
            `${pc.dim(s(c.createdAt).slice(5, 16))}  ${pc.cyan(s(c.userId).slice(0, 8))}  ${s(c.text)}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  tasks
    .command("comment <id> <text...>")
    .description("给任务添加评论")
    .action((id: string, text: string[], _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("POST", `/api/tasks/${id}/comments`, { text: text.join(" ") }));
      }),
    );
  tasks
    .command("files <id> [path]")
    .description("任务产物：无 path 列产物树，有 path 读文件内容（PM 评审：产物可达）")
    .action((id: string, path: string | undefined, _opts: object, cmd: Command) =>
      run(async () => {
        const { api, baseUrl, token } = requireApi(cmd);
        const events = asArr(await api.call("GET", `/api/tasks/${id}/events`));
        const conversationId = s(events[0]?.conversationId);
        if (!conversationId) throw new Error("该任务没有执行记录，无产物");
        const qs = new URLSearchParams({ scope: "runtime", conversationId });
        if (path) {
          // content 接口的 path 相对 runtime 根（含会话目录前缀，与 tree 返回的 path 一致）
          qs.set("path", `${conversationId}/${path.replace(/^\/+/, "")}`);
          const res = await fetch(`${baseUrl}/api/files/content?${qs.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`读文件失败：${res.status}`);
          process.stdout.write(await res.text());
          return;
        }
        const body = (await api.call("GET", `/api/files/tree?${qs.toString()}`)) as {
          nodes?: unknown[];
        };
        // 树根是会话目录本身，直接从其 children 展示
        const roots = asArr(asArr(body.nodes)[0]?.children);
        if (roots.length === 0) {
          console.log("（该会话暂无产物文件）");
          return;
        }
        const walk = (nodes: unknown[], depth: number): void => {
          for (const n of asArr(nodes)) {
            console.log(
              `${"  ".repeat(depth)}${n.isDir ? "📁" : "📄"} ${s(n.name)}${n.isDir ? "" : pc.dim(` (${Number(n.size ?? 0)}B)`)}`,
            );
            walk(asArr(n.children), depth + 1);
          }
        };
        if (globals(cmd).json) return printJson(roots);
        walk(roots, 0);
      }),
    );
  tasks
    .command("optimize <id>")
    .description("触发 task-optimize：聚合审计+评论，进入 AI 生成助手会话确认修订提案")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api, baseUrl, token } = requireApi(cmd);
        const { conversationId } = await api.optimizeTask(id);
        console.log(
          `已发起优化分析，进入优化会话 ${conversationId.slice(0, 8)}（提案落盘会弹审批卡）：`,
        );
        await runChat({ api, baseUrl, token, conversationId });
      }),
    );

  // ── audit ──
  const audit = program.command("audit").description("审计查看");
  audit
    .command("list")
    .description("会话审计摘要")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const list = asArr(await api.call("GET", "/api/audit/conversations"));
        if (globals(cmd).json) return printJson(list);
        for (const c of list) {
          console.log(
            `${id8(c.conversationId)}  ${fmtDate(c.createdAt)}  ${truncate(s(c.title), 40)}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  audit
    .command("show <conversationId>")
    .description("会话审计详情（按 task 分 turns，含 usage）")
    .action((cid: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("GET", `/api/audit/conversations/${cid}`));
      }),
    );

  // ── skills ──
  const skills = program.command("skills").description("技能包管理");
  skills
    .command("packs")
    .description("已安装技能包")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", "/api/skills/packs")) as { packs?: unknown[] };
        const packs = asArr(body.packs);
        if (globals(cmd).json) return printJson(packs);
        for (const p of packs) {
          const creds = asArr(p.credentials);
          const configured = creds.filter((c) => c.configured === true).length;
          console.log(
            `${id8(p.id)}  ${s(p.name)} [${p.enabled ? "on" : "off"}]  skills=${asArr(p.skills).length}  credentials=${configured}/${creds.length}`,
          );
        }
        console.error(pc.dim(`共 ${packs.length} 个包`));
      }),
    );
  skills
    .command("install <url>")
    .description("从 Git 仓库安装技能包")
    .option("--sub-path <path>", "仓库内子目录")
    .action((url: string, opts: { subPath?: string }, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const source: Record<string, unknown> = { kind: "git", url };
        if (opts.subPath) source.subPath = opts.subPath;
        const body = (await api.call("POST", "/api/skills/packs/install", { source })) as {
          pack?: Record<string, unknown>;
        };
        console.log(`已安装：${s(body.pack?.name)}`);
      }),
    );
  for (const [verb, method, path] of [
    ["update", "POST", "/api/skills/packs/update"],
    ["uninstall", "POST", "/api/skills/packs/uninstall"],
  ] as const) {
    skills
      .command(`${verb} <id>`)
      .description(`${verb === "update" ? "更新" : "卸载"}技能包`)
      .action((id: string, _opts: object, cmd: Command) =>
        run(async () => {
          const { api } = requireApi(cmd);
          await api.call(method, path, { id });
          console.log("ok");
        }),
      );
  }
  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    skills
      .command(`${verb} <id>`)
      .description(`${enabled ? "启用" : "停用"}技能包`)
      .action((id: string, _opts: object, cmd: Command) =>
        run(async () => {
          const { api } = requireApi(cmd);
          await api.call("POST", `/api/skills/packs/${enabled ? "enable" : "disable"}`, {
            id,
            enabled,
          });
          console.log("ok");
        }),
      );
  }

  // ── credentials ──
  const creds = program.command("credentials").description("技能凭证");
  creds
    .command("list")
    .description("凭证列表（值脱敏）")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", "/api/credentials")) as { credentials?: unknown[] };
        const list = asArr(body.credentials);
        if (globals(cmd).json) return printJson(list);
        for (const c of list) {
          const usedBy = asArr(c.usedBy)
            .map((u) => s(u))
            .join(",");
          console.log(`${s(c.key)}  ${s(c.label)}${usedBy ? pc.dim(`  ← ${usedBy}`) : ""}`);
        }
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  creds
    .command("set <key> [value]")
    .description("设置凭证（value 缺省且 TTY 时静默输入）")
    .option("-l, --label <label>")
    .action((key: string, value: string | undefined, opts: { label?: string }, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const v = value ?? (await readSecret("输入凭证值（不可见）: "));
        await api.call("PUT", `/api/credentials/${encodeURIComponent(key)}`, {
          key,
          value: v,
          label: opts.label,
        });
        console.log("ok");
      }),
    );
  creds
    .command("delete <key>")
    .description("删除凭证")
    .action((key: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        await api.call("DELETE", `/api/credentials/${encodeURIComponent(key)}`);
        console.log("ok");
      }),
    );

  // ── models ──
  const models = program.command("models").description("用户级 LLM 配置");
  models
    .command("show")
    .description("查看当前配置")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("GET", "/api/settings/models"));
      }),
    );
  models
    .command("set")
    .description("更新配置（未提供的字段保持原值）")
    .option("-u, --url <url>", "Anthropic 兼容 baseUrl")
    .option("-k, --key <key>", "API Key")
    .option("-m, --models <models>", "逗号分隔的模型列表")
    .option("-d, --default <model>", "默认模型")
    .action(
      (opts: { url?: string; key?: string; models?: string; default?: string }, cmd: Command) =>
        run(async () => {
          const { api } = requireApi(cmd);
          const cur = (await api.call("GET", "/api/settings/models")) as Record<string, unknown>;
          const body = {
            url: opts.url ?? s(cur.url),
            key: opts.key,
            models: opts.models
              ? opts.models.split(",").map((x) => x.trim())
              : (cur.models as string[]),
            defaultModel: opts.default ?? s(cur.defaultModel),
          };
          printJson(await api.call("PUT", "/api/settings/models", body));
        }),
    );

  // ── git ──
  const git = program.command("git").description("Git 连接");
  git
    .command("list")
    .description("我的 Git 连接")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", "/api/settings/git/connections")) as {
          connections?: unknown[];
          oauthConfigured?: Record<string, boolean>;
        };
        const conns = asArr(body.connections);
        if (globals(cmd).json) return printJson(body);
        for (const c of conns) {
          console.log(`${id8(c.id)}  ${s(c.provider).padEnd(8)}  ${s(c.url) || s(c.username)}`);
        }
        console.error(pc.dim(`OAuth: ${JSON.stringify(body.oauthConfigured ?? {})}`));
      }),
    );
  git
    .command("pat <provider> <token>")
    .description("用 PAT 保存连接（provider: github/gitee/jihulab）")
    .action((provider: string, token: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("POST", `/api/settings/git/${provider}/pat`, { token }));
      }),
    );
  git
    .command("remove <id>")
    .description("删除连接")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        await api.call("DELETE", `/api/settings/git/connections/${id}`);
        console.log("ok");
      }),
    );
  git
    .command("preflight <conversationId>")
    .description("会话 Git 权限预检")
    .action((cid: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("GET", `/api/conversations/${cid}/preflight`));
      }),
    );

  // ── workflows / triggers / loops（只读 + 快捷操作，CRUD 留 web/AI 生成）──
  const workflows = program.command("workflows").description("工作流");
  workflows
    .command("list")
    .description("工作流列表")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", "/api/workflows")) as { workflows?: unknown[] };
        const list = asArr(body.workflows);
        if (globals(cmd).json) return printJson(list);
        for (const w of list)
          console.log(
            `${id8(w.id)}  ${s(w.name)}  trigger=${id8(w.triggerId)} agent=${id8(w.agentId)}`,
          );
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  workflows
    .command("show <id>")
    .description("工作流详情")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("GET", `/api/workflows/${id}`));
      }),
    );

  const triggers = program.command("triggers").description("触发器");
  triggers
    .command("list")
    .description("触发器列表")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", "/api/triggers")) as { triggers?: unknown[] };
        const list = asArr(body.triggers);
        if (globals(cmd).json) return printJson(list);
        for (const t of list)
          console.log(
            `${id8(t.id)}  ${s(t.type).padEnd(9)}  ${s(t.name)}${t.enabled === false ? pc.red(" (off)") : ""}`,
          );
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  triggers
    .command("test <id>")
    .description("测试触发器（拉取源并匹配，不触发任务）")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("POST", `/api/triggers/${id}/test`));
      }),
    );

  const loops = program.command("loops").description("定时循环");
  loops
    .command("list")
    .description("循环列表（含下次触发时间）")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", "/api/loops")) as { loops?: unknown[] };
        const list = asArr(body.loops);
        if (globals(cmd).json) return printJson(list);
        for (const l of list) {
          const flag = l.enabled ? pc.green("on ") : pc.red("off");
          const err = l.lastError ? pc.red(` ⚠ ${truncate(s(l.lastError), 40)}`) : "";
          console.log(
            `${id8(l.id)}  ${flag}  ${s(l.name)}  next=${fmtDate(l.nextRunAt) || "-"}${err}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    loops
      .command(`${verb} <id>`)
      .description(`${enabled ? "启用（注册调度器）" : "停用"}循环`)
      .action((id: string, _opts: object, cmd: Command) =>
        run(async () => {
          const { api } = requireApi(cmd);
          printJson(await api.call("POST", `/api/loops/${id}/${enabled ? "enable" : "disable"}`));
        }),
      );
  }
  loops
    .command("run <id>")
    .description("手动触发一次")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("POST", `/api/loops/${id}/run`));
      }),
    );
  loops
    .command("runs <id>")
    .description("最近 50 次运行记录")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const body = (await api.call("GET", `/api/loops/${id}/runs`)) as { runs?: unknown[] };
        const list = asArr(body.runs);
        if (globals(cmd).json) return printJson(list);
        for (const r of list) {
          const icon =
            r.status === "success"
              ? pc.green("✔")
              : r.status === "failed"
                ? pc.red("✘")
                : pc.yellow("…");
          console.log(
            `${icon} ${id8(r.id)}  ${s(r.status).padEnd(8)}  ${fmtDate(r.startedAt)}${r.error ? pc.red(` ${truncate(s(r.error), 50)}`) : ""}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 次`));
      }),
    );

  // ── conversations / agents 轻命令 ──
  const convs = program.command("conversations").alias("conv").description("会话管理");
  convs
    .command("list")
    .description("我的会话列表")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const uid = (await api.me()).user.id;
        const list = await api.listConversations(uid);
        if (globals(cmd).json) return printJson(list);
        for (const c of list) {
          const title = (c.title || "（无标题）").replace(/\s+/g, " ");
          console.log(
            `${c.id.slice(0, 8)}  ${fmtDate(c.updatedAt)}  agent=${c.agentId ? c.agentId.slice(0, 8) : "-"}  ${truncate(title, 60)}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 条`));
      }),
    );
  convs
    .command("delete <id>")
    .description("删除会话（软删除）")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        await api.call("DELETE", `/api/conversations/${id}`);
        console.log("ok");
      }),
    );
  convs
    .command("prune")
    .description("批量归档空会话（0 条消息且无自定义标题）")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const uid = (await api.me()).user.id;
        const list = await api.listConversations(uid);
        let n = 0;
        for (const c of list) {
          if (c.archived) continue;
          if (c.title && c.title !== "新对话") continue;
          const msgs = await api.history(c.id).catch(() => []);
          if (msgs.length === 0) {
            await api.call("DELETE", `/api/conversations/${c.id}`).catch(() => {});
            n += 1;
          }
        }
        console.log(`已归档 ${n} 个空会话`);
      }),
    );

  const agents = program.command("agents").description("智能体查看");
  agents
    .command("list")
    .description("我的 + 共享的智能体")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const list = await api.listAgents();
        if (globals(cmd).json) return printJson(list);
        for (const a of list) {
          console.log(
            `${a.id.slice(0, 8)}  ${a._mine ? pc.dim("mine  ") : pc.cyan("shared")}  ${a.name}${a.description ? pc.dim(` - ${truncate(a.description, 40)}`) : ""}`,
          );
        }
        console.error(pc.dim(`共 ${list.length} 个`));
      }),
    );
  agents
    .command("show <id>")
    .description("智能体详情（skills/tools/llm/mcp）")
    .action((id: string, _opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        printJson(await api.call("GET", `/api/agents/${id}`));
      }),
    );

  // ── usage / users / files ──
  program
    .command("usage")
    .description("用量记录")
    .option("--since <iso>", "起始时间")
    .option("--until <iso>", "结束时间")
    .option("--limit <n>", "条数（正整数）", (v: string): number => {
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new InvalidArgumentError("需为正整数");
      }
      return n;
    })
    .action((opts: { since?: string; until?: string; limit?: number }, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const qs = new URLSearchParams();
        if (opts.since) qs.set("since", opts.since);
        if (opts.until) qs.set("until", opts.until);
        if (opts.limit) qs.set("limit", String(opts.limit));
        const body = (await api.call("GET", `/api/usage?${qs.toString()}`)) as {
          records?: unknown[];
        };
        if (globals(cmd).json) return printJson(body.records);
        printJson(body.records);
      }),
    );
  program
    .command("users")
    .description("用户列表")
    .action((_opts: object, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const list = asArr(await api.call("GET", "/api/users"));
        if (globals(cmd).json) return printJson(list);
        for (const u of list) console.log(`${id8(u.id)}  ${s(u.role).padEnd(6)}  ${s(u.name)}`);
        console.error(pc.dim(`共 ${list.length} 人`));
      }),
    );
  const files = program.command("files").description("工作区文件查看");
  files
    .command("tree <scope>")
    .description("文件树（scope: user/runtime/extension；runtime 配合 --conversation）")
    .option("-c, --conversation <id>", "会话级 runtime 目录")
    .action((scope: string, opts: { conversation?: string }, cmd: Command) =>
      run(async () => {
        const { api } = requireApi(cmd);
        const qs = new URLSearchParams({ scope });
        if (opts.conversation) qs.set("conversationId", opts.conversation);
        const body = (await api.call("GET", `/api/files/tree?${qs.toString()}`)) as {
          nodes?: unknown[];
        };
        const walk = (nodes: unknown[], depth: number): void => {
          for (const n of asArr(nodes)) {
            console.log(
              `${"  ".repeat(depth)}${n.isDir ? "📁" : "📄"} ${s(n.name)}${n.isDir ? "" : pc.dim(` (${Number(n.size ?? 0)}B)`)}`,
            );
            walk(asArr(n.children), depth + 1);
          }
        };
        if (globals(cmd).json) return printJson(body.nodes);
        walk(asArr(body.nodes), 0);
      }),
    );
  files
    .command("read <scope> <path>")
    .description("读文件内容")
    .option("-c, --conversation <id>", "会话级 runtime 目录")
    .action((scope: string, path: string, opts: { conversation?: string }, cmd: Command) =>
      run(async () => {
        const { baseUrl, token } = requireApi(cmd);
        const qs = new URLSearchParams({ scope, path });
        if (opts.conversation) qs.set("conversationId", opts.conversation);
        const res = await fetch(`${baseUrl}/api/files/content?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`读文件失败：${res.status}`);
        process.stdout.write(await res.text());
      }),
    );

  // exitOverride 需递归到每个子命令，解析错误才统一走 index.ts 的中文错误层；
  // 同时静音 commander 自己的 stderr 打印（英文 error 行），避免与中文层重复
  const applyExitOverride = (c: Command): void => {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {} });
    for (const sub of c.commands) applyExitOverride(sub);
  };
  applyExitOverride(program);

  return program;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
