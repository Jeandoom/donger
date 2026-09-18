import type { ConversationStore } from "../ports/conversation-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UserStore } from "../ports/user-store.js";
import type { RouteGuardSpec } from "./api-route-guard.js";

/** 守卫表 loadOwner 依赖（缺 store 的部署下 owner 规则条目不登记——本地免认证模式无需守卫） */
export interface WebRouteGuardDeps {
  conversationStore?: ConversationStore;
  taskStore?: TaskStore;
  userStore?: UserStore;
}

/**
 * web 通道全部 /api 路由的显式访问规则（设计规格 §3.3）。
 *
 * fail-closed：未在此登记的 /api 请求一律 404。新增路由必须同步登记，
 * route-coverage 契约测试会用源码字面量扫描兜底核对。
 *
 * 规则分级约定：
 *  - owner(conversation|task|user-memory)：P0 收口的新增校验/迁移自内联校验；
 *    loadOwner 用对应 store.get，资源不存在统一 404。
 *  - authenticated：仅需登录；属主/共享判定由 handler 内既有领域逻辑
 *    （canUseAgent / canManageAgent / requireOwned* / store 按 viewer 过滤）执行——M1 保留内联，避免双轨漂移。
 *  - admin：审计与用户管理面。
 *  - public：显式枚举（含 token 自鉴权的 callbacks/by-share——凭证在路径上，handler 内校验）。
 */
export function buildWebRouteGuardSpecs(deps: WebRouteGuardDeps): RouteGuardSpec[] {
  const conv = deps.conversationStore;
  const task = deps.taskStore;
  const users = deps.userStore;

  const ownerConversation = conv
    ? {
        loadOwner: async (id: string) => {
          const c = await conv.get(id);
          return c ? { ownerId: c.userId } : undefined;
        },
      }
    : {
        // store 未装配：路由保持登记但一律 404（fail-closed，与功能缺失语义一致）
        loadOwner: async () => undefined,
      };
  const ownerTask = task
    ? {
        loadOwner: async (id: string) => {
          const t = await task.get(id);
          return t ? { ownerId: t.requesterId } : undefined;
        },
      }
    : {
        loadOwner: async () => undefined,
      };
  const ownerUserMemory = users
    ? {
        // 记忆目录按用户自身判定：ownerId 即路径上的 :id，user 不存在则 404
        loadOwner: async (id: string) => {
          const u = await users.get(id);
          return u ? { ownerId: u.id } : undefined;
        },
      }
    : {
        loadOwner: async () => undefined,
      };

  return [
    // ===== public（显式枚举）=====
    { method: "GET", pattern: "/api/health", access: { kind: "public" } },
    { method: "POST", pattern: "/api/auth/exchange", access: { kind: "public" } },
    { method: "POST", pattern: "/api/auth/register", access: { kind: "public" } },
    { method: "POST", pattern: "/api/auth/login", access: { kind: "public" } },
    { method: "GET", pattern: "/api/auth/verify", access: { kind: "public" } },
    { method: "POST", pattern: "/api/auth/code-exchange", access: { kind: "public" } },
    { method: "GET", pattern: "/api/auth/qrcode-url", access: { kind: "public" } },
    { method: "GET", pattern: "/api/auth/dingtalk/callback", access: { kind: "public" } },
    { method: "GET", pattern: "/api/auth/github/url", access: { kind: "public" } },
    { method: "GET", pattern: "/api/auth/github/callback", access: { kind: "public" } },
    { method: "GET", pattern: "/api/agents/by-share/:token", access: { kind: "public" } },
    // 回调链接自带 token 凭证，handler 内校验
    { method: "GET", pattern: "/api/callbacks/:token", access: { kind: "public" } },
    {
      method: "GET",
      pattern: "/api/callbacks/:token/conversations/:cid",
      access: { kind: "public" },
    },
    // 废弃端点：410 直接返回，无需登录
    { method: "POST", pattern: "/api/auth/merge-confirm", access: { kind: "public" } },

    // ===== 会话资源（owner）=====
    {
      method: "GET",
      pattern: "/api/conversations/:id/stream",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "POST",
      pattern: "/api/conversations/:id/messages",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "POST",
      pattern: "/api/conversations/:id/cancel",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "GET",
      pattern: "/api/conversations/:id/messages",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "GET",
      pattern: "/api/conversations/:id/preflight",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "PATCH",
      pattern: "/api/conversations/:id",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "DELETE",
      pattern: "/api/conversations/:id",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "GET",
      pattern: "/api/conversations/:id/activity",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "GET",
      pattern: "/api/conversations/:id/events",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    {
      method: "GET",
      pattern: "/api/conversations/:id/pending-question",
      access: { kind: "owner", resource: "conversation" },
      ...ownerConversation,
    },
    // 上传的会话 id 在 query（threadId），属主校验在 resolveAttachmentDir 内执行
    { method: "POST", pattern: "/api/upload", access: { kind: "authenticated" } },

    // ===== 任务资源（owner）=====
    {
      method: "GET",
      pattern: "/api/tasks/:id",
      access: { kind: "owner", resource: "task" },
      ...ownerTask,
    },
    {
      method: "GET",
      pattern: "/api/tasks/:id/events",
      access: { kind: "owner", resource: "task" },
      ...ownerTask,
    },
    {
      method: "GET",
      pattern: "/api/tasks/:id/comments",
      access: { kind: "owner", resource: "task" },
      ...ownerTask,
    },
    {
      method: "POST",
      pattern: "/api/tasks/:id/comments",
      access: { kind: "owner", resource: "task" },
      ...ownerTask,
    },
    {
      method: "POST",
      pattern: "/api/tasks/:id/optimize",
      access: { kind: "owner", resource: "task" },
      ...ownerTask,
    },

    // ===== 用户维度 =====
    { method: "GET", pattern: "/api/users", access: { kind: "admin" } },
    { method: "GET", pattern: "/api/admin/email-verifications", access: { kind: "admin" } },
    { method: "GET", pattern: "/api/audit/conversations", access: { kind: "admin" } },
    { method: "GET", pattern: "/api/audit/conversations/:id", access: { kind: "admin" } },
    {
      method: "GET",
      pattern: "/api/users/:id/memory",
      access: { kind: "owner", resource: "user-memory" },
      ...ownerUserMemory,
    },

    // ===== 登录即可（属主/共享判定在 handler 领域逻辑中）=====
    { method: "GET", pattern: "/api/auth/me", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/auth/github/bind", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/auth/logout", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/settings/llm-platforms", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/settings/llm-providers", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/settings/llm-providers", access: { kind: "authenticated" } },
    {
      method: "PUT",
      pattern: "/api/settings/llm-providers/:id",
      access: { kind: "authenticated" },
    },
    {
      method: "DELETE",
      pattern: "/api/settings/llm-providers/:id",
      access: { kind: "authenticated" },
    },
    {
      method: "POST",
      pattern: "/api/settings/llm-providers/:id/test",
      access: { kind: "authenticated" },
    },
    { method: "GET", pattern: "/api/invites", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/invites", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/invites/:id/disable", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/tasks", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/conversations", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/conversations", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/usage", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/llm/debug", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/approvals/stream", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/approvals/:id/respond", access: { kind: "authenticated" } },
    {
      method: "POST",
      pattern: "/api/credential-missing/:id/decide",
      access: { kind: "authenticated" },
    },
    { method: "POST", pattern: "/api/user-inputs/:id/respond", access: { kind: "authenticated" } },

    // 智能体（canUseAgent/canManageAgent 在 handler 内判定，含共享授予语义）
    { method: "GET", pattern: "/api/agents", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/agents", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/agents/meta/options", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/agents/:id", access: { kind: "authenticated" } },
    { method: "PATCH", pattern: "/api/agents/:id", access: { kind: "authenticated" } },
    { method: "DELETE", pattern: "/api/agents/:id", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/agents/:id/versions", access: { kind: "authenticated" } },
    {
      method: "POST",
      pattern: "/api/agents/:id/versions/:num/rollback",
      access: { kind: "authenticated" },
    },
    { method: "GET", pattern: "/api/agents/:id/conversation", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/agents/:id/share", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/agents/:id/share", access: { kind: "authenticated" } },
    {
      method: "DELETE",
      pattern: "/api/agents/:id/share/grants/:gid",
      access: { kind: "authenticated" },
    },
    { method: "GET", pattern: "/api/agents/:id/callback", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/agents/:id/callback", access: { kind: "authenticated" } },
    { method: "DELETE", pattern: "/api/agents/:id/callback", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/agents/:id/accept-share", access: { kind: "authenticated" } },
    {
      method: "GET",
      pattern: "/api/agents/:id/mention-candidates",
      access: { kind: "authenticated" },
    },

    // 文件浏览（fileBrowser 内部做属主与路径越界校验）
    { method: "GET", pattern: "/api/files/tree", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/files/content", access: { kind: "authenticated" } },

    // 连接器（handler 内 owner/global 判定）
    { method: "POST", pattern: "/api/connectors/test", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/connectors", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/connectors", access: { kind: "authenticated" } },
    { method: "*", pattern: "/api/connectors/:id", access: { kind: "authenticated" } },

    // 工作流模块（requireOwned* 在 handler 内判定）
    { method: "GET", pattern: "/api/triggers", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/triggers", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/triggers/:id", access: { kind: "authenticated" } },
    { method: "PUT", pattern: "/api/triggers/:id", access: { kind: "authenticated" } },
    { method: "DELETE", pattern: "/api/triggers/:id", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/triggers/:id/test", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/workflows", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/workflows", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/workflows/:id", access: { kind: "authenticated" } },
    { method: "PUT", pattern: "/api/workflows/:id", access: { kind: "authenticated" } },
    { method: "DELETE", pattern: "/api/workflows/:id", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/loops", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/loops", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/loops/:id", access: { kind: "authenticated" } },
    { method: "PUT", pattern: "/api/loops/:id", access: { kind: "authenticated" } },
    { method: "DELETE", pattern: "/api/loops/:id", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/loops/:id/enable", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/loops/:id/disable", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/loops/:id/run", access: { kind: "authenticated" } },
    { method: "GET", pattern: "/api/loops/:id/runs", access: { kind: "authenticated" } },

    // 凭证集（handler 内按 viewer 解析）
    { method: "GET", pattern: "/api/credential-templates", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/credential-templates", access: { kind: "authenticated" } },
    {
      method: "PUT",
      pattern: "/api/credential-templates/:code",
      access: { kind: "authenticated" },
    },
    {
      method: "DELETE",
      pattern: "/api/credential-templates/:code",
      access: { kind: "authenticated" },
    },
    { method: "GET", pattern: "/api/credential-values", access: { kind: "authenticated" } },
    { method: "PATCH", pattern: "/api/credential-values/:code", access: { kind: "authenticated" } },
    { method: "PUT", pattern: "/api/credential-values/:code", access: { kind: "authenticated" } },
    {
      method: "DELETE",
      pattern: "/api/credential-values/:code",
      access: { kind: "authenticated" },
    },

    // 技能包（handler 内按 viewer 解析）
    { method: "GET", pattern: "/api/skills/packs", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/skills/packs/install", access: { kind: "authenticated" } },
    {
      method: "POST",
      pattern: "/api/skills/packs/install/upload",
      access: { kind: "authenticated" },
    },
    { method: "POST", pattern: "/api/skills/packs/update", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/skills/packs/uninstall", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/skills/packs/enable", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/skills/packs/disable", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/skills/skills/enable", access: { kind: "authenticated" } },
    { method: "POST", pattern: "/api/skills/skills/disable", access: { kind: "authenticated" } },
  ];
}
