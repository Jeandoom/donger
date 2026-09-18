# donger

技能驱动的通用自动化 Agent 服务。**本地运行**，可插拔 LLM（默认智谱 GLM），通过 **钉钉 / Web / CLI** 三端远程管理与对话。核心能力 = 具名智能体（Agent）加载各类专业 Skill 完成自动化任务（写代码、文档、运维等），关键节点（部署 / 发布 / 推送等高危操作）经审批门确认。

## 功能总览

- **三端接入**：钉钉通道（Stream 模式，AI 卡片流式回复）、Web 控制台（HTTP + SSE 流式，PWA）、CLI 终端前端（SSE 客户端）。
- **具名智能体（Agent）**：按场景配置技能白名单、权限模式（含 Full access）、LLM 与仓库绑定；可视化编辑器 + 场景预设。
- **技能系统**：SKILL.md 技能包管理与安装、预装技能目录（`BUILTIN_SKILLS_DIR`）、内置技能（`skills/`）。
- **对话与会话**：SSE 流式回复、Turn 合并渲染、@文件 //技能 $连接器 引用、问答卡交互、消息持久化。
- **审批门**：高危操作推卡审批（IM / Web），durable gate 持久化、重启不丢。
- **Git 平台集成**：GitHub / Gitee / GitLab PAT 凭证、一凭一仓绑定、工具化 git 操作与 worktree 隔离。
- **自动化**：触发器（Trigger）、多步工作流（Workflow）、循环（Loop）、定时调度。
- **LLM 多供应商**：供应商 / 模型管理，Agent 级与会话级选模型（默认智谱 GLM，Anthropic 兼容端点）。
- **连接器与凭证集**：外部系统集成，凭证集中管理（加密存储、按仓库 / 连接器绑定、共享访问解析）。
- **多用户与账号**：邮箱邀请注册、钉钉扫码 / GitHub OAuth / 邮箱登录，登录方式按 `.env` 实配动态返回；admin / member 角色。
- **可观测**：审计事件、LLM 观测、用量统计、任务历史与文件浏览器。

## 架构

六边形架构，依赖方向单一：`domain` → `ports` ← `adapters`，`orchestrator` 负责编排。

```
src/
  domain/       纯领域逻辑（状态机、注册表、路由、规划器、门控、策略）
  ports/        端口契约（AgentRunner / Channel / 各类 Store 接口）
  adapters/     适配器（Claude Agent SDK、钉钉、Web、SQLite、Git 平台 API 等）
  orchestrator/ 编排核心（任务流转、审批门、事件桥、调度、运行时管理）
  memory/       文件式记忆
  util/         横切工具（logger / errors / git-worktree / dingtalk-api）
  config.ts     zod 校验的环境配置
  index.ts      应用入口（装配 Web + 钉钉双通道）
web/            前端子包：React 18 + Vite 6 + Tailwind + assistant-ui，生产期由后端托管
cli/            CLI 前端子包：commander + SSE，经 CLI_TOKEN 换 JWT 登录
skills/         内置技能包（task-dispatch / task-optimize / web-ui-iterate）
test/           测试（镜像 src）
docs/           设计规格（superpowers/specs）、路线图、部署指南、测试记录
```

通信协议：Web 通道为 **HTTP + SSE**（用户消息 `POST /api/conversations/:id/messages`，Bot 流式回复与审批推送走 SSE），WebSocket 已废弃。规范详见 [`AGENTS.md` §10](./AGENTS.md)。

## 快速开始

环境要求：Node.js ≥ 20、npm。

```bash
npm install                  # 安装依赖（web/ 为 file: 子包一并装好）
cp .env.example .env         # 按需填写配置（至少填 LLM token）
```

开发运行：

```bash
npm run dev                  # 后端 tsx 热重载，默认 http://localhost:3330
npm run dev:web              # 前端 Vite dev（默认 3333，/api 反向代理到后端）
npm run dev:cli              # CLI 终端前端
```

生产构建与运行（生产期前端静态资源由后端托管，只暴露一个端口）：

```bash
npm run build                # tsc 编译后端到 dist/
npm run build:web            # vite 构建前端到 web/dist
npm start                    # node dist/index.js
```

### 关键配置（`.env`）

全集见 [`.env.example`](./.env.example)，常用项：

| 配置 | 说明 |
|---|---|
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `LLM_MODEL` | LLM 接入（默认智谱 GLM 的 Anthropic 兼容端点） |
| `PORT` / `HOST` / `WEB_PORT` | 后端端口（默认 3330）、监听地址、前端 dev 端口（默认 3333） |
| `HTTPS_*` | 证书路径，配置后服务以 HTTPS 运行 |
| `DINGTALK_*` | 钉钉企业自建应用（通道 + 扫码登录） |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth 登录 |
| `EMAIL_SIGNUP_ALLOWED_DOMAINS` / `EMAIL_LOGIN_ENABLED` | 邮箱注册域名白名单 / 邮箱登录开关 |
| `ADMIN_EXTERNAL_IDS` | 管理员白名单（外部 ID） |
| `CLI_TOKEN` | CLI 登录共享密钥（启用 `/api/auth/exchange`） |
| `BUILTIN_SKILLS_DIR` | 预装技能根目录 |

登录页按实际配置动态渲染可用方式（邮箱 > 钉钉 > GitHub）；注册支持域名白名单或邀请链接。远程部署（DDNS + HTTPS + 端口转发）见 [`docs/deploy-remote-access.md`](./docs/deploy-remote-access.md)。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm test` / `npm run test:watch` | Vitest 全量 / 监听（前端 `npm --prefix web run test`，CLI `npm run test:cli`） |
| `npm run lint` | Biome 检查（lint + format 二合一） |
| `npm run smoke` / `npm run smoke:e2e` | 冒烟脚本 / e2e 冒烟 |
| `npm run build` / `npm run build:web` | 后端 / 前端构建 |

CI（`.github/workflows/ci.yml`）在 push / PR 时跑 `lint → test → build`，三者须全绿。提交前本地自测：`npm run lint && npm test`。

## 文档

- **协作与技术规范**：[`AGENTS.md`](./AGENTS.md)（架构约定、编码规范、SSE + HTTP 协议）
- **路线图**：[`docs/superpowers/roadmap.md`](./docs/superpowers/roadmap.md)（M0–M18 任务主计划）
- **设计规格**：[`docs/superpowers/specs/`](./docs/superpowers/specs/)（编排、多智能体平台、凭证集、连接器、LLM 多供应商等）
- **部署指南**：[`docs/deploy-remote-access.md`](./docs/deploy-remote-access.md)

## 状态

开发中，核心链路（钉钉 / Web / CLI 三端 + 智能体 + 技能 + 审批门 + 自动化）已可用，持续推进见路线图。
