# 应用受控代理 v2：凭证从 .env 迁移到「应用勾选用户凭证」设计方案

> **已下线（2026-09-30）**：应用模块已整体移除，本文档仅作历史记录。服务端应用开发部署改走「方案 B：GitOps 外接流水线 + donger AI 控制面」；git 历史保留全部实现（a540654…dfe9a54）。

- 日期：2026-09-29
- 状态：待拍板（4 决策点见 §7）
- 关联：spec 2026-09-25-app-platform-architecture（应用内核 M1）、2026-09-28-app-proxy（受控代理 v1）、2026-09-11-connectors（连接器模块）
- 触发：09-29 maycur-ai-copilot 故障分析——生产 `.env` 缺 `JH_`/`JENKINS_`/`OPS_` 六键，app-proxy 全 503，项目列表/查询静默失败

## 0. 背景与问题定位

v1 的 app-proxy 把三个上游服务（jihulab/jenkins/ops）的凭证放在平台 `.env`（`JH_TOKEN`、`JENKINS_URL/USERNAME/API_TOKEN`、`OPS_BASE_URL/USERNAME/PASSWORD`），`parseAppProxyConfig` 在启动时读入。三个结构性问题：

1. **配置点错位**：平台已有「凭证」模块（用户自配、加密落库、永不回显）与「连接器」模块（baseUrl + headers + `{{credential:CODE.KEY}}` 引用 + private/global 共享域），代理却绕开两者走环境变量——用户无自助能力，换密钥要改 .env 重启，多用户各配各的凭证做不到（.env 是平台单份）。
2. **环境晋级黑洞**：dev .env 有六键、生产没有，开发全绿上生产全挂且无提示（叠加应用前端错误显示断链，表现为「没反应」）。
3. **违备预留方向**：`skills/app-develop/SKILL.md:82` 早已写明「外部服务密钥让用户走凭证模块配置（后续版本接入应用）」——v1 是过渡态，本设计兑现该预留。

## 1. 架构：出网通道 = 应用侧服务名 × 连接器绑定

能力抽象优先（不被 maycur 场景固化）：

```
应用 bundle          平台代理面                         平台既有模块
┌──────────┐  app-token  ┌──────────────────────┐   ┌─────────────────────────┐
│ proxy(s, │ ──────────▶ │ /api/app-proxy/      │──▶│ 连接器(type=http)        │
│  path…)  │             │   <appId>/<service>  │   │  url=baseUrl            │
└──────────┘             │  ①查应用绑定 service→ │   │  headers=静态头+凭证引用  │
        服务名=通道别名    │    connectorId       │   │  auth=认证风格+凭证code   │
                         │  ②取连接器(可见+启用)  │   └───────────┬─────────────┘
                         │  ③collectCredentialRefs│             │ {{credential:CODE.KEY}}
                         │  ④getFilledValues(应用属主) ──▶ 凭证集(加密值,永不回显)
                         │  ⑤substitute/适配器加工 │
                         │  ⑥转发并包装结果        │
                         └──────────────────────┘
```

- **服务名（service）**：应用 bundle 里的通道别名（`jihulab`/`jenkins`/`ops`…可任意命名），是应用与平台之间的接口契约；存量 bundle 的服务名与绑定键天然对齐，**产物零改动**。
- **连接器（type=http）**：解析目标，携带 baseUrl、静态头、凭证引用、共享域（private/global）、enabled 开关。
- **认证风格（auth）**：静态头之外的流程性认证（jenkins CRUMB、ops 登录换 JWT），声明在连接器上，仅代理面消费。
- **凭证**：一律来自凭证集，按**应用属主**的已填值解析，服务端替换；前端产物/响应永不含凭证（红线保持）。

## 2. 模型变更

### 2.1 连接器（src/domain/connector.ts）

新增可选字段（读容忍缺省，存量无 `auth` 即 `none`）：

```ts
auth: z.object({
  style: z.enum(["none", "basic-crumb", "token-login"]), // 预留 oauth2-cc 等
  credential: z.string(),                                // 凭证 code
}).optional()
```

| style | 凭证键约定 | 运行时行为 | 覆盖场景 |
|---|---|---|---|
| `none`（缺省） | — | headers 静态头 + 引用替换即最终请求头 | jihulab `PRIVATE-TOKEN`、任意 Bearer/自定义头 |
| `basic-crumb` | `username` / `apiToken` | 组 Basic 认证；POST 自动带 CRUMB，403 重取重试一次 | Jenkins |
| `token-login` | `username` / `password` | POST `<baseUrl>/api/token/` 换 JWT（25min 主动续），401 重登一次 | Ops |

- 凭证键直接从凭证集解密取用，**不经 headers 字符串编码**（避免 Basic base64 手拼）。
- 该字段仅代理面消费；MCP 注入面忽略（未来 agent HTTP 工具面复用时同源受益）。
- 适配器缺键 → 明确报 `凭证 CODE 缺键 username`（指引回凭证页），不静默。

### 2.2 应用（src/domain/app.ts + sqlite-app-store）

apps 表新增列 `proxyJson`（ALTER TABLE 惯例同 `managerAgentId`），**不进 manifest**——通道是运行时配置，变更不应触发重新发布版本：

```ts
/** 服务名 → 连接器 id */
appProxyBindings?: Record<string, string>;
// 如 { "jihulab": "conn_a", "jenkins": "conn_b", "ops": "conn_c" }
```

- 服务名约束 `/^[a-z][a-z0-9-]{0,31}$/`（URL 段安全），单应用上限 8 条；
- `PATCH /api/apps/:id` 增加 `proxyBindings` 字段；写入口校验：连接器存在 + `type=http` + `enabled` + 属主可见（own private 或 global）；非属主连接器 → 400；
- 读时再校验（连接器事后停用/删除/改私有 → 转发时 503「通道不可用」，不炸应用）；
- DTO（`appView`）回传绑定与服务状态，供通道页渲染。

### 2.3 代理路由（app-proxy.ts 重构）

- `createAppProxyHandler` 从 `.env` 配置切换为查应用绑定：service 未绑定 → 503 `应用未绑定出网通道: <service>（属主在应用详情-通道页配置）`；
- 通道绑定但凭证引用 missing → 503 带缺失清单（`凭证 jihulab-pat 未填写`）；
- 认证适配器注册表 `{ none, basic-crumb, token-login }` 替换现有三个具名 forwarder，进程内 crumb/JWT 缓存保持；
- **删** `config.ts` 的 `JH_`/`JENKINS_`/`OPS_` 六键与 `parseAppProxyConfig`（.env 退役，不留双轨——双真源是本项目反复踩的坑）。

## 3. UI：应用详情「通道」页签

- 已绑定通道列表：服务名、连接器名、认证风格、状态（✓ 就绪 / ⚠ 凭证未填 / ✕ 连接器已停用）；
- 添加通道：服务名输入 + 连接器下拉（仅 `type=http`、属主可见、enabled）+ 所选连接器引用的凭证在**应用属主名下**的填写状态预览（复用 `/api/connectors/test` 的 dry-run 语义）；
- 凭证未填 → 直链凭证页对应模板；应用管家对话引导语同步（含 app-develop 技能文案 §82 更新为「已接入」）；
- 会话侧零改动：app-token 面依旧只拿到包装结果。

## 4. 安全与权限

- 勾选权 = 应用属主；连接器可见范围沿用现有规则（`ownerId=? OR shareScope='global'`）；
- 凭证解析属主 = **应用属主** `getFilledValues(app.userId, codes)`；
- path/query 白名单字符、method 白名单、30s 超时、64KB body 上限、app-token 鉴权全部保持；
- 越权用例必须覆盖：勾选非属主连接器 400、已删连接器转发 503 不 500、引用 missing 不泄值、服务名大小写归一；
- 审计：proxy 调用记 app_logs 网关面（service、上游 status；不记头/体）。

## 5. 迁移与兼容

- 生产 `.env` 本就未配六键（无存量依赖），直接退役，**无数据迁移**；
- maycur copilot 恢复路径（产物零改动）：属主在凭证页填 3 个凭证（jihulab PAT / jenkins 用户+API Token / ops 用户+密码）→ 连接器页建 3 个 http 连接器（jenkins 连接器 auth=basic-crumb、ops 连接器 auth=token-login）→ 应用详情勾 3 条通道；
- 配套项（非阻塞）：应用前端 `deploy.js` 错误显示断链（loadErr 不渲染）走应用管家重新发布 v2 修复，避免下次故障继续「静默」。

## 6. 测试

- 域：绑定/服务名 schema、auth 键约定、`none` 缺省容忍；
- 存储：ALTER 迁移、绑定读写、appView DTO；
- API：PATCH 绑定越权矩阵、代理 401/503（未绑定/停用/missing）分支、web-route-guards 契约扫描；
- 适配器：basic-crumb 403 重取、token-login 401 重登（fetch mock）；
- 回归：MCP 注入面不受 `auth` 字段影响。

## 7. 拍板点

1. **认证风格挂连接器**（`connector.auth` 字段，通用抽象）vs 平台内置具名服务目录（仅凭证换用户配置）——推荐前者：兑现能力基座方向，服务目录形态会把「上游形态」焊死在平台代码里；
2. **.env 六键直接退役** vs 保留兜底双轨——推荐直接退役；
3. **绑定存 apps.proxyJson 新列** vs 进 manifest——推荐新列（通道变更不应触发重发布）；
4. **M1 适配器集 = none / basic-crumb / token-login** 三枚（覆盖 maycur 场景），agent HTTP 工具面复用连接器的泛化预留下轮——确认是否接受分期。
