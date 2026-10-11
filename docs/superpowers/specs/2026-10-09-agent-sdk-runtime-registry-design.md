# Agent SDK 运行时插件化设计（引擎运行时注册表）

- 日期：2026-10-09
- 状态：设计稿，待拍板（未动码）
- 背景：2026-10-08 事故复盘遗留项②——生产 `resolveCliPath()` 指向桌面版安装目录（`C:/Program Files/ZCode/resources/glm/zcode.cjs`），桌面自动更新即生产引擎悄悄换血。需求：SDK 插件化——首启强制选择一个支持的 agent sdk → 系统下载并应用 → 后续可随时更换/多选（范围=系统已支持的 sdk）；配置入口放「模型」模块。

## 0. 可行性结论

**可行，但概念须先收窄：可插件化的是「引擎运行时工件」，不是 runner 代码。**

1. **runner 代码不可插件化，也不应插件化。** 三引擎的接入面从来不是纯外部协议：审批门、AskUserQuestion 桥、审计映射、事件契约（specs/2026-10-08-zcode-session-lifecycle-contract.md）全是 donger 侧实现。放任第三方引擎绕过这层 = 退回 2026-09 安全审计前的裸奔面。因此「插件化」的准确含义是：**运行时工件（二进制/运行时目录）可下载、可钉版、可更换、可启停；runner 代码随平台发版**。这与「系统支持的 agent sdk」的语义一致：`LLM_SDK_TYPES = ["anthropic","openai","zcode"]` 是编译期注册表，新引擎接入本来就=写 runner + 加注册表条目。

2. **三引擎的运行时现状决定了「下载」只对 zcode 有意义：**

| sdkType | 运行时形态 | 换血风险 | 「下载并应用」的诚实语义 |
|---|---|---|---|
| anthropic | `@anthropic-ai/claude-agent-sdk` npm 内嵌，package-lock 钉版 | 无（随部署升级） | 无需下载；仅需启停/默认选择 |
| openai | `@openai/codex-sdk` npm 内嵌，同上 | 无 | 同上 |
| zcode | 外部二进制（桌面安装目录），无版本锁定 | **有（10-08 事故实锤）** | 真下载/钉版：官方渠道存在——官网安装包（zcode.z.ai）、开源仓库 zai-org/ZCode（Apache-2.0）；`--version` 探针可用（本机实测 `0.16.9`） |

3. **首启强制选择机制上顺路。** SetupPage 已有 `setupRequired` 强制门（AuthGuard 全入口重定向）+ `/api/setup/status|admin`；加一步引擎选择不引入新机制。
4. **许可证**：zcode Apache-2.0（可镜像分发）；codex SDK Apache-2.0；claude-agent-sdk 为 Anthropic 官方 SDK 许可（随 npm 依赖分发，无额外动作）。内网镜像自用无合规障碍。
5. **边界声明**：npm 上 `zcode-cli@0.0.1` 是无关占位包，**不可**作为下载源；远程源只认管理员配置的 URL（默认预填官方渠道），并强制校验和。

## 1. 架构：引擎运行时 = 平台资产（复用既有抽象）

按「平台只拥有资产+通道+治理」的既有口径（主机资产化 v3 同款思路）：不新建子系统，给引擎运行时建**一类资产 + 一个注册表 + 一条解析链**。

### 1.1 三层结构

```
静态层（已有）   LLM_SDK_TYPES ——「系统支持的 agent sdk」唯一范围
资产层（新增）   engine_runtimes 表 —— 每 sdkType 一行，工件的安装/版本/校验/状态
治理层（新增）   enabledEngines[] / defaultEngine —— 平台级启停与默认（admin）
```

### 1.2 engine_runtimes 表（新表，已核对无撞名）

```sql
CREATE TABLE engine_runtimes (
  sdkType TEXT PRIMARY KEY,            -- anthropic | openai | zcode
  sourceKind TEXT NOT NULL,            -- bundled | local | remote
  sourceRef TEXT,                      -- URL / 本机路径（bundled 为空）
  pinnedVersion TEXT,                  -- 冒烟探针所得版本，如 0.16.9
  installedPath TEXT,                  -- 受管安装目录（bundled 为空）
  sha256 TEXT,                         -- 主工件校验和（漂移检测基准）
  managed INTEGER NOT NULL DEFAULT 1,  -- local 直引模式 =0（不复制，漂移风险自担）
  status TEXT NOT NULL,                -- missing | installing | ready | error | drifted | disabled
  lastError TEXT,
  lastSmokeAt TEXT,
  updatedAt TEXT
);
```

- 迁移铁律照旧：建表前 grep DROP TABLE 撞名（已核对现存表清单无冲突）。
- 迁移默认行：anthropic/openai → `bundled/ready`；zcode → `missing`。存量部署不改变任何现行行为（zcode 未钉版时解析链落到底=现桌面路径发现，但状态面板显式标「未钉版」）。

### 1.3 受管安装目录与解析链

- 安装目录：`<data>/engines/<sdkType>/<pinnedVersion>/`（`<data>` 即生产 `D:\deploy\donger\data`，随库备份体系走）。
- zcode runner 解析链（`resolveCliPath` 改造，优先级从高到低）：
  1. `DONGER_ZCODE_CLI_PATH` env（开发逃生门，保留不动）；
  2. 注册表 `status=ready && managed=1` 的 `installedPath`；
  3. 现行桌面路径发现（降级态）——**命中此层时 runner 在 llm_input 审计与 UI 状态面板同时打「未钉版，随桌面更新漂移」警示**。任何漂移显性化，不再无声。

### 1.4 安装流（admin，三种来源）

| 来源 | 语义 | 安全口径 |
|---|---|---|
| `discover`（推荐，M1 主路径） | 检测本机桌面安装 → **复制**到受管目录 → 记 sha256 → 冒烟 | 一键把隐式依赖转成显式钉版资产 |
| `remote` | URL 下载（默认预填官方渠道，可改内网镜像）→ 边下边算 sha256 → 管理员确认校验和 → 落盘 → 冒烟 | URL 限 http(s)+禁内网段（复用 trigger SSRF 修复口径）；校验和人工确认防投毒 |
| `local` | 直接引用本机路径，不复制（managed=0） | 明示「不受漂移保护」 |

- 冒烟探针：`spawn(cli, ["--version"])`，超时 15s，输出回填 `pinnedVersion`/`lastSmokeAt`；失败 → `status=error` + lastError，**不得激活**。
- 激活语义：安装成功即写 `installedPath` 并置 `ready`（单行单资产，无历史版本轮换——M1 不做版本列表，更换=重装覆盖，旧目录留待下次覆盖前清理）。
- 漂移检测：服务启动时 + 每 24h 对 `ready` 行做 sha256 复核；不一致 → `status=drifted` + system_events 事件 + UI 警示横幅。**只报警不自动更换**（治理原则：换引擎是显式动作）。

### 1.5 治理层语义（多选/更换/默认）

- `enabledEngines[]`：平台级启用集合（admin）。门禁三处：ModelsPage 平台下拉按 sdkType 过滤；Chat 引擎/模型选择器同过滤；orchestrator 对「会话 llmSdkType 指向停用引擎」的轮 **fail-closed 显性报错**（错误文案归入契约 §C3 的不可恢复分类，不清指针只提示）。历史会话查看不受限。
- `defaultEngine`：仅作新会话无显式选择时的引擎维兜底（与现有 modelRef>lastModelRef>presetId>用户默认>全局 模型链正交，不插进模型链，避免语义纠缠）。
- 存量部署迁移：`enabledEngines` 默认=全量三引擎（现网 zcode 可用是事实），admin 后续在 UI 收窄——行为零破坏。

## 2. 首启流程（SetupPage 加一步）

现有流：创建首个 admin → 进授权模块。插入引擎步骤：

1. **选择启用引擎（多选，≥1 强制）**：anthropic/openai 卡片带「内置 · 即装即用」徽标，默认勾选；zcode 卡片带「需安装运行时」徽标。
2. **指定默认引擎（单选，强制）**：默认=已勾选的第一项。
3. 若勾选 zcode：展示引导（安装入口指向模型模块的引擎区块）；**不阻塞 setup 完成**（安装可后置——首启目标是注册偏好，不是逼管理员当场搞定工件）。
4. 完成后落 `enabledEngines`/`defaultEngine`，页面照旧进授权模块，ModelsPage 顶部给一条「为所选引擎创建模型配置」的引导提示。

存量已 setup 的部署不再回流程（`setup_completed` 已存在），靠迁移默认值 + 引擎区块补管理。

## 3. API（admin-only，登记 web-route-guards 守卫表）

```
GET   /api/admin/engine-runtimes              # 三行状态 + 解析链现状（含降级警示）
POST  /api/admin/engine-runtimes/:sdkType/install   # {sourceKind, sourceRef?, sha256?}
POST  /api/admin/engine-runtimes/:sdkType/smoke     # 手动重跑冒烟
PATCH /api/admin/engine-runtimes/:sdkType           # {enabled}（并入治理层亦可）
GET   /api/admin/engine-config                      # {enabledEngines, defaultEngine}
PUT   /api/admin/engine-config
```

- 全部动作写 system_events（管理员操作口径）。
- 安装子进程纪律沿用 runGit 同款（超时/输出上限/禁 shell 串接）。

## 4. Web UI 设计（ModelsPage 内，符合现行风格）

### 4.1 「执行引擎」区块（admin-only，置于「系统默认模型」之上）

沿用页面现有卡片语言（`section.space-y-2.rounded-xl.border.border-border.bg-card.p-5` + `h2.text-sm.font-semibold` 小节标题 + 行卡 + 右对齐动作），admin 可见性照 AuditPage 的 `isAdmin` 条件渲染先例：

```
┌─ 执行引擎（管理员）──────────────────────────────────────────────┐
│ 引擎运行时是平台级资产：钉版后不随第三方自动更新漂移。            │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ [Claude]  内置 · 即装即用                    启用 ●  [停用] │ │
│ │ anthropic · 随平台版本发布                                  │ │
│ ├────────────────────────────────────────────────────────────┤ │
│ │ [Codex]   内置 · 即装即用                    启用 ●  [停用] │ │
│ │ openai · 随平台版本发布                                    │ │
│ ├────────────────────────────────────────────────────────────┤ │
│ │ [ZCode]   ⚠ 未钉版（运行于桌面安装，随更新漂移） [安装运行时] │ │
│ │ zcode · 解析路径 C:/Program Files/.../zcode.cjs            │ │
│ └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

- **行卡状态徽标**（复用既有 badge/token）：`内置`（neutral）、`已钉版 vX.Y.Z`（primary 弱底）、`⚠ 已漂移`（destructive 边框整卡警示）、`error`（含 lastError 折叠）、`已停用`（降透明度）。
- **ready 行明细**：来源（官方 URL/本机发现/本地路径）、安装路径、sha256 前 8 位、安装时间、最近冒烟时间；动作：`[更换版本]` `[重新冒烟]` `[停用]`。
- **zcode 未钉版行**：CTA `[安装运行时]`，并展示当前实际解析路径（降级透明）。
- **安装对话框**（沿用技能包 InstallDialog 模式）：
  1. 来源三选一（本机发现【推荐，检测到桌面安装时高亮】/ 远程 URL【预填官方渠道】/ 本地路径）；
  2. remote 需确认 sha256（可留空=安装时计算后强确认）；
  3. 进度态（下载→校验→冒烟，`installing` 轮询）；
  4. 完成态展示探针版本（如 `0.16.9`）。
- **漂移横幅**：任一行 `drifted` 时区块顶部出警示条「引擎工件已被外部修改，建议重新安装钉版」，附 system_events 链接。

### 4.2 SetupPage 引擎步骤（第 2 步）

多选卡片组（≥1 强制 + 默认单选高亮），风格=现有 setup 表单（Button + input 卡片语言）：

```
┌─ 选择执行引擎 ─────────────────────────────────────┐
│ 至少启用一个；带 ★ 的为默认引擎，可随时在模型模块更换。│
│ [✓ Claude  内置·即装即用      ★默认]                │
│ [✓ Codex   内置·即装即用          ]                │
│ [    ZCode  需安装运行时（可稍后在模型模块安装）]     │
│                            [上一步] [完成初始化 →]  │
└─────────────────────────────────────────────────────┘
```

## 5. 里程碑

| 期 | 内容 | 价值 |
|---|---|---|
| M1 | engine_runtimes 表 + 安装/冒烟/激活 + 解析链改造 + 漂移检测 + ModelsPage 引擎区块 | **摘掉「悄悄换血」风险**（生产价值立得：装完即钉版） |
| M2 | SetupPage 首启选择 + enabledEngines 三处门禁 + fail-closed 报错 | 需求完整闭环（首启强制选择/多选/更换） |
| M3（可选） | 官方源新版本检查（仅提示）、引擎健康视图 | 治理增强 |

生产迁移动作（M1 上线后一次性）：admin 在引擎区块对 zcode 执行「本机发现」安装 → 钉版 + 冒烟 + 漂移保护生效。

## 6. 决策点（拍板用）

1. M1/M2 一起做还是分期？（建议：一起，M2 的门禁很小；Setup 步骤依赖 M1 的状态展示）
2. `defaultEngine` 是否 M1 就要？（建议 M2；模型链正交语义需单独讲清）
3. remote 源 M1 是否要？（建议 M1 就带上「本机发现」+「local 路径」，remote 可 M3；若官方渠道稳定性存疑，remote 留镜像口即可）
4. 停用引擎对存量会话：fail-closed 报错（建议）还是自动回退默认引擎？（建议报错——静默换引擎违背 fail-closed 原则）
