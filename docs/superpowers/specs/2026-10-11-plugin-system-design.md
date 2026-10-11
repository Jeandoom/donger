# 通用插件系统设计（引擎插件 + 能力插件 + 扩展包插件三层）

- 日期：2026-10-11
- 状态：**已实施（M0+M1+M2）**——拍板见 §8，实施规划见 §9；验证=后端 1567 / web 215 全绿 + 双端 tsc + vite build + 真实组合根启动冒烟（24 插件对账 0 错误、路由守卫生效、两表种子正确）。实施取舍：SetupPage「引擎步」落地为创建管理员成功后的非阻塞确认屏（默认引擎=claude 已是种子默认态，免强加一步）；remote 来源按单文件下载实现（官方渠道安装包形态待 M3 观察）。生产部署与 zcode「本机发现」钉版迁移动作待执行（§9.9）。
- 背景：需求四条——①claude/openai/zcode 三个 agent sdk 全部插件化；②系统初始化时默认安装 claude agent sdk；③增加插件系统：一级目录「插件」模块 + 插件配置页面可安装/卸载；④梳理 agent 配置中相关功能全部插件化，核心功能默认安装。
- 前置：2026-10-09《Agent SDK 运行时插件化设计（引擎运行时注册表）》（docs/superpowers/specs/2026-10-09-agent-sdk-runtime-registry-design.md）已交付待拍板——**本文整体收编该稿为插件系统的 engine 类别**，其表结构/解析链/API/UI 设计原样保留，入口从「模型页引擎区块」迁移到「插件页」。

## 0. 可行性结论

**可行，但「插件」必须拆成三种形态分别落地；其中「第三方代码插件」明确不做。**

一刀切的插件化（任意代码 require 进主进程）不可行也不应做：donger 是单进程 Node 应用，宿主进程内执行第三方代码 = 把 admin 权限交给插件作者，且会直接击穿三条既有防线——fail-closed 路由守卫契约（web-route-guards.ts 未登记路由一律 404 + route-coverage 源码扫描兜底）、刚收口的安全内核 M1（PreToolUse hook/解码管线/env 白名单/引擎状态隔离）、confine 系统级读写边界。现有技能包体系刻意避开这一点：技能内容（提示词+脚本）由 agent 会话在沙箱内消费，不进宿主进程——这是平台的信任边界设计，插件系统必须沿用而非突破。

三种形态与需求的映射：

| 形态 | 对象 | 分发方式 | 安装/卸载语义 | 信任档 |
|---|---|---|---|---|
| **A 引擎插件** | 三个 agent sdk 的运行时 | claude/openai = bundled（npm 内嵌 `@anthropic-ai/claude-agent-sdk`/`@openai/codex-sdk`，随平台发版钉版）；zcode = 外部工件（本机发现/远程下载/本地路径，sha256 钉版） | bundled 不可卸载仅启停；工件可安装/更换/卸载 | admin 受管 |
| **B 能力插件** | 平台内置功能模块（知识库/触发器/凭证/git/host/连接器/通知/会话引用…） | 随平台发版（代码内置），插件化的是**装配+启停+依赖治理**，不是代码分发 | 全量预装；core 不可卸载；非 core 可停用（配置保留、执行忽略） | 平台代码，无第三方 |
| **C 扩展包插件** | 技能包体系泛化（技能/agent 蓝本/提示词模板/MCP 预设） | git 仓库/zip/内置目录安装 | 真安装/真卸载（复用技能包全链路先例） | 声明式内容，agent 会话消费，不进宿主进程 |

逐条可行性证据：

1. **「三 SDK 插件化」→ 形态 A。** runner 代码不可插件化也不应插件化：审批门、AskUserQuestion 桥、审计映射、事件契约全是 donger 侧实现（10-09 稿 §0.1 已论证），「插件化」的诚实语义 = 运行时工件可下载/钉版/更换/启停 + 引擎启停治理随平台发版。三引擎现状决定了「下载」只对 zcode 有真实意义（claude/openai 无换血风险，仅需启停与默认选择）。
2. **「初始化默认安装 claude」→ 顺路。** engine_runtimes 表 anthropic 行迁移默认 `bundled/ready` + defaultEngine=anthropic + Setup 首启步默认勾选；零新机制（setupRequired 强制门已存在）。
3. **「一级目录+插件配置页+安装卸载」→ 双落点。** web 一级导航新增「插件」（admin-only）+ 运行时受管一级目录 `<data>/plugins/`（与既有 `skills/` 内置目录、`repos/` 同层先例）+ 仓库内置 `plugins/builtin/`（能力插件 manifest 所在）。安装/卸载的真实语义落在形态 C（扩展包）与形态 A 的引擎工件上；形态 B 只有启停（代码在平台里，「卸载」是伪动作）。
4. **「agent 配置功能全插件化 + core 默认安装」→ 形态 B。** 现状全部功能模块硬编码装配（index.ts 692 行组合根手工 new、RuntimeManager 654 行注入链、AgentEditorPage 静态区块），插件化 = 每模块发 manifest + 登记注册表 + 装配点按注册表过滤，**不重写模块内部实现**。agent 配置 schema 不做动态扩展：字段随平台 schema 走，插件只决定「字段是否生效/UI 是否展示」——弱引用+停用忽略口径已有三处先例（knowledgeBaseIds 失效库读时忽略、connectorIds 弱引用、技能 auditAgentSkillAvailability 静默缺失对账），停用/卸载不丢用户配置。

关键约束（现状实锤，设计必须绕开）：

- **web-channel.ts 7614 行手写路由 + 守卫表 fail-closed** → 插件不得开任意路由注入口。扩展包插件无路由；能力插件路由随平台代码走、照旧登记守卫表；新增 `/api/plugins` 管理面照常登记。
- **组合根手工装配（60+ deps 巨型构造）** → 插件装载器（PluginHost）作为独立装配阶段插入，组合根只加一处调用，不重写。
- **功能间依赖真实存在**（凭证←git 集成/连接器/host 执行；连接器←MCP；反馈引用←反馈模块；KB←提示词注入与审计）→ 注册表带依赖声明，启停做前置校验：被依赖模块禁停（或强警示二次确认）。
- **存量行为零变化铁律**：迁移默认全量预装 enabled=true，非 core 模块的「裁剪」是 admin 之后的显式动作，升级当天平台行为与今天完全一致。

## 1. 架构：一个注册表 + 三类插件 + 统一生命周期

按「平台只拥有资产+通道+治理」的既有口径（引擎注册表稿/主机资产化同款思路）：不新建平行子系统，给插件建**一份 manifest 契约 + 一张注册表 + 一个装载器 + 一组装配点过滤**。

### 1.1 manifest 契约（plugin.json）

```jsonc
{
  "id": "knowledge-base",        // 全局唯一；引擎 = engine.claude / engine.codex / engine.zcode
  "kind": "capability",          // capability | engine | pack
  "version": "1.0.0",
  "core": false,                 // true = 核心：预装、不可卸载（决策点①定停用档位）
  "title": "知识库",
  "description": "智能体绑定知识库、检索工具注入与自动学习沉淀",
  "scope": "agent",              // agent = 智能体配置相关 | platform = 平台级模块
  "requires": [],                // 依赖的插件 id（启停前置校验）
  "contributes": {               // 贡献点声明（形态 B 描述注入面；M0 仅作展示，M2 起生效）
    "agentConfigFields": ["knowledgeBaseIds", "kbAutoLearn", "kbWriteTargetId"],
    "navEntries": ["/kb"]
  }
}
```

- 能力插件 manifest 随平台代码内置（`plugins/builtin/<id>/plugin.json`），代码模块不因此搬家——manifest 是登记与治理声明，不是代码分发单元。
- 引擎插件 manifest 由安装器生成（bundled 两条在迁移时写死）。
- 扩展包 manifest 复用技能包 pack 元数据扩展 `kind:"pack"` 与 `packType`（skill 承接存量；agent-template / prompt-template / mcp-preset 为 M3 新贡献点）。

### 1.2 注册表（新表 plugins，建表前照旧 grep DROP TABLE 撞名）

```sql
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,          -- knowledge-base / engine.claude / my-skill-pack
  kind TEXT NOT NULL,           -- capability | engine | pack
  version TEXT,
  core INTEGER NOT NULL DEFAULT 0,
  scope TEXT,                   -- agent | platform
  source TEXT,                  -- builtin | git:<url> | zip | local:<path> | bundled | discover | remote
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT,                  -- ready | missing | error（对账结果；pack 沿用技能包状态语义）
  error TEXT,
  installedAt TEXT,
  updatedAt TEXT
);
```

- **迁移默认行 = 内置能力插件全量 + 三引擎全量，全部 enabled=1**——存量部署行为零变化；「按需裁剪」是上线后 admin 的显式动作。
- 扩展包与技能包的关系：存量 skill_pack 表保留（技能域有自己的物化/对账/共享链路），plugins 表对 pack 只存一行索引（id=`pack:<name>`），安装/卸载动作转调既有 LocalSkillInstaller/SkillJobRunner——**不平行造第二套安装器**。

### 1.3 PluginHost 装载器（src/plugins/host.ts，新）

启动序列插入组合根（store 迁移完成后、WebChannel 构造前）：

1. 扫描 `plugins/builtin/*/plugin.json`（能力+引擎 bundled 声明）与 `<data>/plugins/*/plugin.json`（用户安装的扩展包/引擎工件记录）；
2. 与 plugins 表对账：新 manifest 补登记（enabled=1）、消失的 pack 标 missing（沿用技能包静默缺失口径）、core 行保护性纠偏（enabled 可被 admin 改，core/卸载状态不可漂移）；
3. 产出 `PluginSnapshot`（全量清单+enabled 集+依赖图），注入三个消费点。

三个装配点消费（只加过滤，不改模块内部）：

1. **RoutingAgentRunner**：按 engine.* enabled 集过滤；orchestrator 对「会话 sdkType 指向停用引擎」的轮 fail-closed 显性报错（10-09 稿 §1.5 口径原样收编，历史会话查看不受限）。
2. **RuntimeManager 装配链**：capability 停用 → 对应 agent 字段不解析（mcpServers 不合并、kb 工具不注入、credentialsEnv 不注入、git 仓库不物化、host 工具不注册）、提示词节不注入、connectorIds/凭证缺失问询跳过——弱引用忽略，不抛错不丢配置。
3. **Web 前端**：`GET /api/plugins/snapshot` 下发清单（无敏感字段，登录即可读）；NavigationSidebar 按 navEntries+enabled 过滤（非 core 停用后入口隐藏）；AgentEditorPage 按贡献点过滤功能区块，已配置值但模块停用 → 区块显示「模块未启用，配置已保留」徽标。

### 1.4 生命周期语义矩阵

| 动作 | core 能力 | bundled 引擎（claude/openai） | 外部引擎工件（zcode） | 扩展包 |
|---|---|---|---|---|
| 安装 | 预装，无动作 | 预装，无动作 | 本机发现/远程钉版/本地路径（10-09 §1.4 三来源+冒烟+漂移检测原样收编） | git/zip/内置目录（复用技能包安装流+凭证桥） |
| 启用/停用 | 可（档位见决策点①） | 可 | 可 | 可 |
| 卸载 | 禁止（API 409 + UI 隐藏按钮） | 禁止（仅停用） | 允许（删工件+停用+解析链降级显性警示） | 允许（删内容+级联对账） |

- 卸载对账：扩展包卸载后，agent 声明悬空走既有 auditAgentSkillAvailability 静默缺失治理 + AgentEditor 警示徽标；引擎工件卸载后 zcode 解析链落「现行桌面路径发现」降级态并显性标「未钉版」（10-09 §1.3 第 3 层）。
- 全部治理动作（安装/启停/卸载/安装失败）写 system_events（管理员操作口径）。

## 2. agent 配置功能盘点与插件归属（需求④梳理结果）

来源：AgentSchema（src/domain/agent.ts）+ RuntimeManager 注入链 + 组合根。scope=agent 的进 AgentEditor 过滤；scope=platform 的进插件页平台区。

| 功能模块 | 插件 id | core | requires | 备注 |
|---|---|---|---|---|
| 引擎·Claude（anthropic） | engine.claude | ✅ | — | bundled；**默认引擎**（需求②落点） |
| 引擎·Codex（openai） | engine.codex | 否 | — | bundled |
| 引擎·ZCode | engine.zcode | 否 | — | 外部工件；待钉版 |
| 工具面（白名单/校验） | tools | ✅ 不可停 | — | 安全内核 |
| 审批门/权限模式 | approval-gates | ✅ 不可停 | tools | 安全内核（force 门也在内） |
| 审计/LLM 观测 | audit | ✅ 不可停 | — | 合规底线 |
| 任务/会话/消息 | tasks | ✅ 不可停 | — | 平台主干 |
| 通知（站内信） | notifications | ✅ 不可停 | — | 审批卡送达依赖（e44e4d7 轮强制站内信） |
| 渠道·Web | channel.web | ✅ 不可停 | tasks | 平台主干 |
| 技能（pack/用户仓库/内置） | skills | ✅（建议） | — | agent 主干执行面；形态 C 宿主 |
| 凭证（模板+注入） | credentials | ✅（建议） | — | 被 git/连接器/host 四方依赖，停用=连锁瘫痪 |
| 渠道·钉钉 | channel.dingtalk | 否 | notifications | module_configs 运行时换血已有 |
| MCP 服务器（agent 级） | mcp-servers | 否 | — | |
| 连接器（HTTP MCP） | connectors | 否 | mcp-servers | |
| Git 集成（物化+donger-git+shell git 门） | git-integration | 否 | credentials | |
| 知识库（绑定/自动学习/独立库） | knowledge-base | 否 | — | |
| 会话引用（%） | conversation-scope | 否 | tasks | |
| 反馈引用（#） | feedback-scope | 否 | feedback | |
| host 执行（host-ops+白名单） | host-exec | 否 | credentials | 2026-10-10 白名单轮 |
| 扩展目录 | extension-dirs | 否 | — | |
| 场景预设 | scenarios | 否 | — | |
| 触发器/工作流 | workflows | 否 | tasks | scope=platform |
| 反馈模块 | feedback | 否 | — | scope=platform |
| 外呼/事件源探针 | event-sources | 否 | workflows | scope=platform |

core 判据三档：**安全内核**（审批/审计/工具面）、**平台主干**（任务/站内信通知/web 渠道）、**被广泛依赖**（凭证/技能）。「核心功能默认安装」的实现口径 = 全量预装 enabled=1 + core 行不可卸载；不是「最小集安装起步」（那会破坏存量行为，也违背零变化铁律）。

## 3. API（登记 web-route-guards 守卫表）

```
GET    /api/admin/plugins                     # 全量清单+状态+依赖图+影响面摘要
POST   /api/admin/plugins/:id/enable          # 前置校验 requires（被依赖方挂起则 409 带链路）
POST   /api/admin/plugins/:id/disable
POST   /api/admin/plugins/:id/install         # pack：{source: git|zip|builtin, ref, credentialCode?}
                                              # engine.zcode：{source: discover|remote|local, sourceRef?, sha256?}（10-09 §3 原样收编）
DELETE /api/admin/plugins/:id                 # core/bundled → 409
GET    /api/plugins/snapshot                  # authenticated：清单+enabled 集+导航/编辑器过滤所需（无敏感字段）
```

安装子进程纪律沿用 runGit 同款（超时/输出上限/禁 shell 串接）；remote 引擎源限 http(s)+禁内网段（trigger SSRF 修复口径）。

## 4. Web UI

- **一级导航「插件」**（NavigationSidebar 新条目，admin-only）：三分区（引擎/能力/扩展包），行卡沿用页面卡片语言；core 徽标、依赖提示（requires 反查「被谁依赖」）、启停开关、安装/卸载按钮按 §1.4 矩阵显隐。
- **安装对话框**：复用技能包 InstallDialog 交互模式；引擎安装对话框 = 10-09 §4.1 设计原样平移（来源三选一/sha256 确认/进度态/探针版本回显）。
- **ModelsPage 引擎区块退役迁入插件页**（模型页留「执行引擎在插件页管理」入口链接），避免双入口漂移。
- **AgentEditorPage**：功能区块按 snapshot 贡献点渲染；停用模块已配置值 → 区块降透明度+「模块未启用，配置已保留」徽标（不隐藏，保可发现性）。
- **SetupPage 首启第 2 步**：10-09 §2 引擎步收编并泛化为「核心插件确认」——claude 默认勾选+默认引擎单选（需求②落点），其余展示预装清单；不阻塞 setup 完成。
- **漂移横幅**：engine.zcode drifted 时插件页顶部警示（10-09 §4.1 原样收编）。

## 5. 里程碑

| 期 | 内容 | 价值 |
|---|---|---|
| **M0 注册表+盘点面** | plugins 表+manifest 契约+PluginHost 装载+插件页（全量预装 enabled=1，只读盘点+快照过滤导航/编辑器）+snapshot API | 治理面立得：现状 24 个模块可视化管理，零行为变化；后续各期都长在这个骨架上 |
| **M1 引擎插件** | =10-09 稿 M1+M2 收编：engine_runtimes 工件资产（zcode 钉版/冒烟/漂移检测）+启停门禁三处+首启步+插件页引擎区 | 摘掉「桌面更新悄悄换血」生产风险；需求①②闭环 |
| **M2 能力启停** | RuntimeManager 装配过滤+依赖前置校验+AgentEditor 过滤与徽标+core 档位执行 | admin 可裁剪功能面（合规/最小面诉求）；需求④闭环 |
| **M3 扩展包** | 技能包体系泛化贡献点（agent 蓝本/提示词模板/MCP 预设）+插件页安装/卸载 | 用户可安装第三方声明式内容（不进宿主进程） |

生产迁移动作（M0 上线后一次性）：迁移自动登记 24 行全 enabled；admin 如需裁剪按依赖图逐个停用。

## 6. 决策点（拍板用）

1. **core 停用档位**：安全类（approval-gates/audit/tools）+主干类（tasks/notifications/channel.web）建议**不可停用**（UI 灰置+API 409）；凭证/技能建议 core 但可停用（停用走依赖校验，被依赖方连带停用提示）。是否同意？
2. **停用模块的既有 API 面**：写操作（保存 agent 时解析停用模块字段/模块专属写接口）返回 409 带指引 vs 照常受理但不生效。建议：**读照常、写 409**（显性优于静默）。
3. **M3 贡献点范围**：agent 蓝本+提示词模板先行、MCP 预设缓行（连接器已覆盖 HTTP MCP 登记场景）？还是三贡献点一起？
4. **第三方代码插件**：本期明确不做，能力外挂一律走进程外 MCP（连接器即先例）——是否同意写进边界声明？
5. **插件页可见性**：admin-only（建议）vs 全员只读+admin 可操作？
6. **与 10-09 引擎稿的关系**：本文收编后，该稿不再单独拍板（其 4 个决策点中，defaultEngine=随 M1 做、停用引擎 fail-closed=沿用其建议、remote 源=随 M1 带上、分期=本文 M1）——是否同意按此合并？
7. **M2 是否收窄**（收益分析 §7.4 结论）：只对平台级+安全敏感模块（host-exec/connectors/channel.dingtalk/workflows/event-sources，约 6 个）做启停，agent 级配置功能只做 M0 可见性登记不做停用语义——砍掉全量启停的测试组合爆炸，是否同意？

## 7. 收益分析（拍板参考）

**总判断：收益分两层——「已兑现型」（有事故/审计史背书，确定到手）与「期权型」（取决于平台走向，不兑现即纯开销）。建议分级推进：M0+M1 无条件做，M2 收窄后做，M3 挂起待需求。**

### 7.1 已兑现型收益（M0+M1）

| 收益 | 证据 | 对应期 |
|---|---|---|
| 消除引擎悄悄换血风险 | 10-08 事故实锤：resolveCliPath 指向桌面安装目录，桌面自动更新=生产引擎换血；当前唯一缓解是人工警觉，钉版+sha256 漂移检测使其结构上不可能 | M1 |
| 引擎成为可审计资产 | 出问题可回答「当时跑的什么版本」（pinnedVersion/sha256/冒烟时间落库）——10-08 复盘时此问题靠考古回答 | M1 |
| 会话引擎 fail-closed | 停用引擎不再静默回退，对齐安全轮既定原则；需求②（首启默认 claude）顺路完成 | M1 |
| 全平台功能面有机器可读底账 | 历轮安全审计（09-17 十二项、09-24 十一项高+十五项中、10-09~11 内核三轮）每次都靠人工盘「系统现在开着什么」；注册表把盘点变成一次查询 | M0 |
| 新功能接入有登记契约 | 历史上 dingtalk 渠道/host-exec 等都是先实现后治理；manifest 登记使下一个功能不能无声混进装配链 | M0 |
| 隐性依赖图显性化 | 凭证←git/连接器/host 的依赖链首次有机器可读表达（盘点副作用=文档化） | M0 |

即使放弃整个插件系统，M1（引擎钉版）也值得作为独立事项做——它本来就是 10-08 复盘遗留项②；M0 是后三期的公共骨架，不做则各期重复造登记机制。

### 7.2 期权型收益（M2/M3）与兑现条件

- **M2 能力启停**：价值兑现取决于三件事之一发生——①对外输出/多环境部署（合规「用不到的不开」）；②故障隔离常态化（停模块替代回滚版本）；③新功能灰度（装而未启）。当前单机 DDNS+单 admin 部署形态下三者均不紧迫；若「裁剪」需求永不兑现，M2 是纯治理开销（每模块维护停用语义+测试组合面）。**收窄方案（决策点⑦）**：只做平台级+安全敏感模块约 6 个的启停（host-exec/connectors/channel.dingtalk/workflows/event-sources），agent 级配置功能仅 M0 可见性登记——组合爆炸砍掉约 2/3，保留「最小攻击面」这一最实的部分（host-exec/连接器恰是安全史最重的模块）。
- **M3 扩展包**：技能包链路现成、边际成本中等；但 agent 分享/技能分享已覆盖分享场景，M3 增量=「模板化复用」（蓝本反复实例化），对个人价值低、对团队/对外输出价值高。可无限期挂起，骨架已预留 kind=pack。

### 7.3 战略性收益

插件注册表是「资产+通道+治理」口径的又一次实例化：此后「按环境差异化部署」「事故时停用某功能」「对外版裁剪」都有现成挂点，无需再造治理机制；能力清单成为一等公民后，AgentEditor/导航/守卫表的动态化也有了单一数据源。

### 7.4 代价面（诚实账）

- 一次性：M0 小（新表+装载器+只读页，零行为变化）；M1 中（10-09 稿收编实施）；M2 中（收窄后）~大（全量 24 模块时，不推荐）；M3 中。
- 长期：停用态 UX 与测试组合面（收窄后可控）；admin 认知成本（理解启停/卸载语义矩阵）；skills 双表心智负担（用 pack:`<name>` 索引行缓解）。
- 不做的代价：M1 不做=10-08 类事故风险继续存在（桌面更新随时触发）；M0 不做=功能面底账继续靠人工考古。

## 8. 拍板记录（2026-10-11，全部按建议裁定）

| # | 决策点 | 裁定 |
|---|---|---|
| 1 | core 停用档位 | 安全类（approval-gates/audit/tools）+ 主干类（tasks/notifications/channel.web）**不可停用**；credentials/skills/engine.claude 为 core 但**可停用**（走依赖校验） |
| 2 | 停用模块 API 面 | **读照常、写 409**（带指引文案），显性优于静默 |
| 3 | M3 贡献点范围 | agent 蓝本 + 提示词模板先行；MCP 预设缓行（连接器已覆盖） |
| 4 | 第三方代码插件 | **不做**，写进边界声明；能力外挂一律进程外 MCP（连接器即先例） |
| 5 | 插件页可见性 | **admin-only**（导航 admin 区 + 守卫表 admin 规则） |
| 6 | 与 10-09 引擎稿关系 | **本文收编**，该稿不再单独拍板（defaultEngine 随 M1、停用引擎 fail-closed、remote 源随 M1、分期=本文 M1） |
| 7 | M2 收窄 | **收窄**：启停只覆盖 mcp-servers / connectors / host-exec / channel.dingtalk / workflows / event-sources 六模块；git-integration 留 M0 可见性登记（后续可追加为 M2.1）；agent 级配置功能只做可见性，不做停用语义 |

## 9. 系统化实施规划

### 9.0 总纲（五条不变量，全程有效）

1. **存量零变化**：迁移默认 24 行全量预装 enabled=1；升级当天行为与升级前完全一致，裁剪是此后 admin 的显式动作。
2. **代码不分发**：能力插件 manifest 是登记与治理声明，不是代码分发单元；模块内部实现不搬家。
3. **fail-closed**：解析链只有 `status=ready` 才被消费；停用引擎的会话显性报错；被依赖模块禁停（409 带链路）。
4. **守卫表铁律**：新路由必须登记 web-route-guards.ts（route-coverage 契约测试兜底），插件不开任意路由注入口。
5. **两表分工**：`plugins`=治理面（清单/启停/依赖）；`engine_runtimes`=引擎工件资产（安装/校验/漂移）。治理行与工件行以 id 关联，迁移同事务写，启动对账纠偏。

### 9.1 数据模型终稿

**plugins 表**（建表前照旧 grep DROP TABLE 撞名）：

```sql
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,          -- knowledge-base / engine.claude / pack:<name>
  kind TEXT NOT NULL,           -- capability | engine | pack
  version TEXT,
  core INTEGER NOT NULL DEFAULT 0,
  stoppable INTEGER NOT NULL DEFAULT 1,   -- 拍板①：core 且 stoppable=0 → 停用 API 409
  scope TEXT,                   -- agent | platform
  source TEXT,                  -- builtin | bundled | discover | remote | local | git | zip
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ready',   -- ready | missing | error
  error TEXT,
  requires TEXT,                -- JSON 数组（依赖插件 id）
  installedAt TEXT,
  updatedAt TEXT
);
```

**engine_runtimes 表**：10-09 稿 §1.2 原样收编（sdkType 主键/sourceKind/sourceRef/pinnedVersion/installedPath/sha256/managed/status/lastError/lastSmokeAt）。

迁移顺序：`plugins` 建表+24 行种子 → `engine_runtimes` 建表+3 行种子（anthropic/openai=bundled/ready，zcode=missing）→ PluginHost 启动对账（manifest↔DB：新增补登记/消失标 missing/core+stoppable 保护性纠偏）。对账幂等单测覆盖。

### 9.2 manifest 契约与内置清单

zod schema（src/domain/plugin.ts）：`id/kind/version/core/stoppable/scope/title/description/requires/contributes{agentConfigFields?,navEntries?}`；坏 manifest fail-soft（标 error 不炸启动）。仓库一级目录 `plugins/builtin/<id>/plugin.json` 共 27 份（与 `skills/` 内置目录同层先例）。

| id | kind | core | stoppable | scope | requires | M2 停用集 |
|---|---|---|---|---|---|---|
| engine.claude | engine | ✅ | ✅ | platform | — | （启停随 M1） |
| engine.codex | engine | — | ✅ | platform | — | （启停随 M1） |
| engine.zcode | engine | — | ✅ | platform | — | （启停随 M1） |
| tasks | capability | ✅ | ✗ | platform | — | |
| audit | capability | ✅ | ✗ | platform | — | |
| approval-gates | capability | ✅ | ✗ | agent | tools | |
| tools | capability | ✅ | ✗ | agent | — | |
| notifications | capability | ✅ | ✗ | platform | — | |
| channel.web | capability | ✅ | ✗ | platform | tasks | |
| channel.dingtalk | capability | — | ✅ | platform | notifications | ✅ |
| skills | capability | ✅ | ✅ | agent | — | |
| credentials | capability | ✅ | ✅ | agent | — | |
| mcp-servers | capability | — | ✅ | agent | — | ✅ |
| connectors | capability | — | ✅ | agent | mcp-servers | ✅ |
| host-exec | capability | — | ✅ | agent | credentials | ✅ |
| workflows | capability | — | ✅ | platform | tasks | ✅ |
| event-sources | capability | — | ✅ | platform | workflows | ✅ |
| git-integration | capability | — | —（仅登记） | agent | credentials | |
| knowledge-base | capability | — | —（仅登记） | agent | — | |
| conversation-scope | capability | — | —（仅登记） | agent | tasks | |
| feedback-scope | capability | — | —（仅登记） | agent | feedback | |
| extension-dirs | capability | — | —（仅登记） | agent | — | |
| scenarios | capability | — | —（仅登记） | agent | — | |
| feedback | capability | — | —（仅登记） | platform | — | |

（pack 类无内置行，安装时登记 `pack:<name>`。）

### 9.3 装配点接线图（file:line 锚点，实施对照用）

| 装配点 | 位置 | 消费插件 | 生效期 |
|---|---|---|---|
| zcode CLI 解析链 | src/adapters/zcode-agent-runner.ts:957（resolveCliPath：env → **注册表 ready** → 桌面降级+警示） | engine.zcode | M1 |
| 三引擎路由过滤+fail-closed | src/adapters/routing-agent-runner.ts + orchestrator 会话 sdkType 校验 | engine.* | M1 |
| agent 级 MCP 合并 | src/orchestrator/runtime-manager.ts:182-209（mcpServers 合并与 connectorIds 解析处） | mcp-servers / connectors | M2 |
| host 工具挂载+提示词节 | src/orchestrator/orchestrator.ts:511-548（createHostToolsServer + allowlist 注入） | host-exec | M2 |
| 钉钉通道运行时换血 | src/index.ts:473（applyDingTalkChannel：停用=no-op+摘除） | channel.dingtalk | M2 |
| 触发管线恢复 | src/index.ts:632-634（scheduler.restore/eventDispatcher.restore 前置 gate） | workflows | M2 |
| 外呼/探针 | src/index.ts:590-615（callEndpoint/eventProbe 装配 gate） | event-sources | M2 |
| 导航过滤 | web/src/components/layout/NavigationSidebar.tsx:43-68（entries 数组按 snapshot navEntries 过滤）+ 新增 admin 区「插件」条目 | 全部 | M0 |
| 编辑器区块过滤 | web/src/pages/AgentEditorPage.tsx（按 contributes.agentConfigFields 过滤+「模块未启用」徽标） | scope=agent | M0（徽标随 M2） |
| SetupPage 引擎步 | web/src/pages/SetupPage.tsx（第 2 步：claude 默认勾选+默认引擎单选） | engine.* | M1 |
| 技能可用性对账（复用先例） | src/domain/skill-availability.ts（pack 卸载后静默缺失治理） | pack | M3 |

### 9.4 M0 工作分解（注册表+盘点面，~1-2 天）

新建：
- `plugins/builtin/<id>/plugin.json` ×27（§9.2 清单）
- `src/domain/plugin.ts`（manifest zod schema + 依赖校验纯函数 `assertDisableAllowed`/依赖反查）
- `src/adapters/sqlite-plugin-store.ts`（CRUD+reconcile+种子迁移）
- `src/plugins/plugin-host.ts`（扫描 builtin 目录→对账→产出 PluginSnapshot；启动+对账失败降级日志）
- `web/src/pages/PluginsPage.tsx`（admin；三分区行卡盘点：清单/状态/依赖图反查「被谁依赖」；M0 无启停动作）

修改：
- `src/index.ts`（组合根插入 PluginHost 装配阶段：pluginStore.migrate → host.reconcile → snapshot 注入 WebChannelDeps）
- `src/adapters/web-channel.ts`（`GET /api/admin/plugins`+`GET /api/plugins/snapshot` 两路由）
- `src/adapters/web-route-guards.ts`（admin×1 + authenticated×1）
- `web/src/App.tsx`（`/plugins` 路由，懒加载）、`web/src/lib/api.ts`（client 方法）、`web/src/types.ts`
- `NavigationSidebar.tsx`（「插件」admin 条目 + navEntries 过滤钩子）

验收：snapshot 返回 24 行全 enabled=1；导航/编辑器渲染与升级前逐屏一致（存量零变化截图对比）；manifest 完备性契约测试绿（id 唯一/requires 指向存在 id/JSON 可解析）。

### 9.5 M1 工作分解（引擎插件，~2-3 天；=10-09 稿 M1+M2 收编）

新建：
- `src/adapters/sqlite-engine-runtime-store.ts`（engine_runtimes CRUD）
- `src/adapters/engine-runtime-installer.ts`（discover/remote/local 三来源+sha256+冒烟探针 `spawn(cli,["--version"])` 15s；子进程纪律沿用 runGit；remote 限 http(s)+禁内网段）
- `src/plugins/engine-resolver.ts`（解析链：env → registry ready → 桌面降级；漂移检测定时器：启动+24h sha256 复核→drifted+system_events）

修改：
- `zcode-agent-runner.ts:957`（resolveCliPath 接 resolver；降级命中时 llm_input 审计打「未钉版」警示）
- `routing-agent-runner.ts`（enabled 过滤；停用引擎会话 fail-closed 报错，归入不可恢复分类）
- `web-channel.ts`（install/smoke/engine-config API ×5，admin+守卫表+system_events）
- `ModelsPage.tsx`（引擎区块退役，留入口链接）；`PluginsPage.tsx`（引擎区：行卡状态徽标/安装对话框/漂移横幅）；`SetupPage.tsx`（第 2 步）

验收：安装失败不触碰解析链（fail-closed 单测）；校验和不符拒装；drifted 报警且不自动更换；存量 zcode 路径行为不变（未钉版降级+警示）；首启步默认 claude。

### 9.6 M2 工作分解（收窄六模块启停，~2-3 天）

每模块停用语义（全部=读照常、写 409）：

| 模块 | 停用时动作 | 前置校验 |
|---|---|---|
| mcp-servers | runtime-manager.ts:182 起跳过 agent.mcpServers 合并（工具面无 MCP） | 无 |
| connectors | connectorIds 解析跳过；连接器页写 409 | requires mcp-servers |
| host-exec | orchestrator.ts:511 不注入 allowlist 提示词节+不挂载 donger-host 工具 | requires credentials |
| channel.dingtalk | applyDingTalkChannel no-op；已装配通道 stop+摘除 | requires notifications |
| workflows | scheduler/eventDispatcher 不 restore；触发入队拒收 | requires tasks |
| event-sources | callEndpoint/eventProbe 不装配 | requires workflows |

新建/修改：`PluginSnapshot` 贯通六个装配点（webChannelDeps/orchestrator 构造参数各加一个 `pluginGate` 注入）；`PluginsPage.tsx` 启停开关+禁停 409 链路提示+停用影响面文案；受影响页面（连接器/工作流/事件/授权页钉钉区）只读态横幅；AgentEditor「模块未启用，配置已保留」徽标。

验收：六模块逐个停用→e2e 验证 fail-closed（工具不出现/写 409/停用引擎会话报错同款口径）；依赖禁停组合全量单测（connectors enabled 时禁停 mcp-servers 等）；重新启用后行为恢复（含钉钉通道重装配）。

### 9.7 M3 概要（扩展包，挂起待需求再启动）

技能包体系泛化贡献点：packType=skill（存量承接）/agent-template/prompt-template；安装流复用 LocalSkillInstaller+SkillJobRunner（plugins 表只存 `pack:<name>` 索引行，不平行造安装器）；插件页 pack 区安装/卸载+卸载对账走 auditAgentSkillAvailability。骨架（kind=pack、安装 API 形态、插件页分区）已在 M0/M1 预留。

### 9.8 测试与验收策略

- 单测：reconcile 幂等（新增/消失/core+stoppable 纠偏）；manifest 坏文件 fail-soft；依赖校验全组合；resolveCliPath 三级解析链；安装器校验和不符/冒烟失败拒激活。
- 契约：manifest 完备性（24 目录一一对应）；route-coverage 自动兜底新路由；security-hardening.test.ts 既有锚点全绿。
- e2e：升级前后 snapshot 对比（存量零变化）；M1 安装流三来源（discover 用临时目录 mock）；M2 六模块停用 fail-closed 矩阵；SetupPage 首启步冒烟。
- 对抗性复用 sec-probe harness 思路：停用 host-exec 后探针确认 donger-host 工具确不可达。

### 9.9 部署与生产迁移

1. 部署前真库备份（惯例 bak-日期-plugin）；
2. 上线 M0+M1（同期合入）：迁移自动登记 24+3 行；验证 snapshot 与导航逐屏一致；
3. **生产迁移动作（一次性）**：插件页对 engine.zcode 执行「本机发现」→ 复制钉版+冒烟+漂移保护生效，摘掉桌面换血风险；
4. M2 单独发版（与 M1 间隔一轮观察），上线后 admin 按需裁剪。

### 9.10 风险登记

| 风险 | 缓解 |
|---|---|
| plugins/engine_runtimes 双表漂移 | 迁移同事务种子+启动对账纠偏+单测 |
| 引擎安装破坏现网 zcode | fail-closed：只有 ready 行被解析链消费；生产用「本机发现」复制不替换原路径 |
| M2 组合爆炸 | 收窄六模块+依赖校验全组合单测+停用语义逐模块表驱动 |
| snapshot 泄漏敏感信息 | 白名单字段（source 脱敏，不回传 sourceRef 原文/凭证） |
| 前端 bundle 增量 | PluginsPage 懒加载（docx-preview/jszip 动态分包先例） |
| 建表撞名 | 建表前 grep DROP TABLE（迁移铁律） |
| 守卫表漏登记 → 404 | route-coverage 契约测试兜底（既有机制） |

### 9.11 排期建议

M0（1-2 天）→ M1（2-3 天，与 M0 同期开发、合并发版）→ 生产迁移 zcode 钉版 → 观察一轮 → M2（2-3 天，单独发版）→ M3 挂起。合计 M0-M2 约 5-8 个工作日。
