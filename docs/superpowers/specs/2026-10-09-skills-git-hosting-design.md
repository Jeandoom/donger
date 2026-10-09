# 技能统一托管与全量视图设计（Skills Git Hosting & Unified Inventory）

- 日期：2026-10-09
- 状态：设计稿，待拍板（未动码）
- 需求人：何建东
- 背景：生产会话 c385dc71 实锤——agent 在工作区创建的技能（ops-check-stock-analysis）平台零索引、无法入 git；技能模块只见 pack 不见全量。

---

## 0. 需求 → 能力映射（验收样板）

| 需求 | 能力 |
|---|---|
| R1 技能模块配置「git 仓库」，agent 创建的 skills 版本化统一托管 | 托管通道：个人技能仓库（push 镜像已有，补提升托管 + 反向回装） |
| R2 未托管技能按用户选择安装到 agent 级 / user 级 | 双落点安装：agent 级（工作区）/ user 级（个人 pack），运行时双引擎消费 |
| R3 技能模块查看用户所有 skills（git 的、agent 创建的、手工装的） | 全量视图：三源归一清单 + 来源徽章 + 托管状态 |

场景验收（用 c385dc71 复演）：agent 在会话里建了 `ops-check-stock-analysis` → 技能模块能看到它（来源=agent 工作区）→ 一键「提升托管」进入个人技能仓库 push 到 gitee → 此后任何 agent 可从该仓库回装；若用户不需要托管，创建时选「装到本 agent」或「装到 user 级」。

---

## 1. 现状盘点（资产与链路）

### 1.1 技能资产的四种存在形态

| 形态 | 存储 | 平台可见 | 运行时消费 |
|---|---|---|---|
| **pack**（安装单元，四源：git/upload/paste/builtin） | `skill_packs`+`pack_skills`，目录 `<homeDir>/.skills/<slug>` | ✅ /api/skills/packs | claude=plugins 直挂；codex=物化到 CODEX_HOME/skills；**zcode=不消费** |
| **agent 工作区技能**（skill-creator 惯例落 `workspace/.agents/skills/<name>`） | 纯文件 | ❌ **零索引**（src 全目录无引用） | ❌ 平台不注入；CLI 是否原生读 cwd 未实证 |
| **个人技能仓库镜像**（push 单向） | `user_skill_repos` 配置 + `.skill-repo-cache` 工作副本（布局 `packs/<slug>/skills/<name>` + manifest.json） | 仅仓库配置行 | ❌ 不能作为安装来源 |
| **内置技能**（builtinSkillsDir） | 共享只读目录 | 仅 AgentEditor「系统内置」组，SkillsPage 不显示 | 随 pack 通道 |

### 1.2 已有的可复用机制（设计地基）

- **push 镜像通道完整存在**：`skill-repo-sync.ts`——onChanged 钩子（paste 安装/上传/启停/卸载/write_skill 后自动触发）+ 手动 `/api/skills/repo/sync`；每用户串行队列；`runGit`+`resolveCredential`（AskPass 注入，token 不进 env/DB）；空仓库 init 兜底；push 失败自动 `pull --rebase` 重试。**同步范围= paste/upload 非预装 pack**。
- **agent 造技能的正道已有**：平台工具 `write_skill/update_skill/read_skill/list_skills`（platform-tools.ts）→ `installFromPaste` 落 user pack → 自动触发镜像。**但只装配给内置作者 agent**（skill-forge 等），普通 agent（如 stock-analysis-ops）没有，于是走 skill-creator 写工作区 → 不可见。
- **布局适配器已有**：`ensureSdkPluginLayout`——非 `skills/<name>/SKILL.md` 标准布局的目录自动生成 `.donger-sdk-plugin/` 标准副本（agent 工作区技能消费可直接复用）。
- **白名单格式**：`<pluginName>:<skillName>`（`resolveActiveSkills` 派生；agent.skills 非空时整体覆盖默认）。
- **可用性对账**：`auditAgentSkillAvailability`（声明 vs 属主侧 enabled pack 实扫差集 → 系统提示注入「技能未就绪」）。

### 1.3 缺口清单

- **G1** 工作区技能零索引——R3 的直接障碍（c385dc71 根因）
- **G2** 镜像仓库单向（push only）——R1 的「托管管理」缺回装闭环
- **G3** 无 agent 级安装落点——R2 缺「装到 agent」选项
- **G4** 全量视图缺位（SkillsPage 只有 pack；builtin 也不在列表）——R3
- **G5** zcode 引擎不消费平台技能——既有遗留，独立 spike（本设计不重复解决，只保证不新增依赖）

---

## 2. 社区方案借鉴

### 2.1 Claude Code Plugin Marketplace（code.claude.com/docs/en/plugins）

仓库即分发目录：根级 `.claude-plugin/marketplace.json` 列出插件条目（含各自 subPath），`/plugin marketplace add <repo>` 即可消费。**donger 的 pack 格式本就是 Claude plugin 家族**（`.claude-plugin/plugin.json`）。
→ **借鉴**：个人技能仓库在现有 `packs/<slug>/skills/<name>` 布局上**派生生成根级 marketplace.json**——同一个仓库对外是标准 Claude Code marketplace（生态通用），对内是 donger 可逐 pack 反向安装的 git 源（`kind:git + subPath`）。一份资产、两种消费，零新格式。

### 2.2 skills.sh / vercel-labs/skills（npx skills）

开放 agent 技能生态的安装器：一个 SKILL.md 目录 → `npx skills add` 检测本机 agents 分发到各自目录；作用域分 project（随项目）与 personal（随用户）两级。
→ **借鉴**：「单一技能资产、多落点分发」与 **project/personal 两级作用域**——精确对应本设计的 agent 级/user 级；donger 的落点解析器按同样的语义建模，但分发由服务端完成（凭证与守卫不过 agent 手）。

### 2.3 Anthropic Agent Skills 开放标准（agentskills.io）

SKILL.md 目录格式 + 渐进披露（name/description 常驻、正文按需、脚本按需），已被 40+ 平台采用。
→ **借鉴**：坚持标准格式，不发明新格式。donger 的 scan（name/description/allowed-tools）已兼容；工作区技能、镜像仓库、pack 三处同格式，全量视图的归并才可能「无 adaptor」。

### 2.4 模式归纳

社区三者共同点 = **git 仓库是唯一事实源 + 目录布局即协议 + 分发是派生动作**。donger 已有 2/3（skill-repo-sync 的 git 通道、SKILL.md 协议），缺的是把「分发/回装/视图」补成派生闭环，而不是新建子系统。

---

## 3. 架构设计

### 3.1 资产模型：SkillRecord 三源归一（能力抽象）

平台只拥有**资产 + 通道 + 治理**。技能资产统一为一条 SkillRecord 视图，来源 provenance 三种：

```
SkillRecord {
  id: string            // pack: "<packName>:<skill>" | agent: "agent-skills:<skill>" | builtin: "system:<skill>"
  origin: "pack" | "agent" | "builtin"
  packSource?: "git" | "paste" | "upload" | "builtin"
  agentId?: string      // origin=agent 时
  hosted: boolean       // 是否已纳入个人技能仓库镜像
  enabled: boolean
  name/description/path/updatedAt...
}
```

- `origin=pack`：现有 skill_packs 四源，行为不变。
- `origin=agent`：`<agentDir>/workspace/.agents/skills/<name>`（**skill-creator 惯例即标准**，不另造目录约定）。
- `origin=builtin`：builtinSkillsDir 扫描。
- 「未托管」= origin∈{agent, paste/upload pack} 且未入镜像；「托管」= 已在个人技能仓库（hosted=true）。

**id 方案零破坏**：agent 级技能作为一个 plugin 暴露，plugin.json name 固定 `agent-skills`（布局适配器生成），白名单 id = `agent-skills:<skill>`——与现有 `packName:skill` 格式同构，AgentEditor 树、auditAgentSkillAvailability、运行时白名单链全部沿用。

### 3.2 托管通道：user_skill_repos 升级为「个人技能仓库」（复用，不新建）

现有 push 镜像 = 通道的地基。升级三件事：

1. **布局派生 marketplace.json**：`.skill-repo-cache` 提交前按 `packs/*` 生成根级 `.claude-plugin/marketplace.json`（每 pack 一个条目，source 指向 `packs/<slug>` subPath）。仓库由此获得双重身份：Claude Code 生态可直接 `marketplace add`；donger 可反向安装。
2. **回装（pull 方向）**：新动作 `POST /api/skills/repo/install` `{ slug }`——从仓库按 subPath 以 `kind:git` 安装为 user pack（URL=repoUrl，凭证=credentialCode，走现有 git 安装流：clone+扫描+入库）。**语义=仅补缺 + 显式替换**（不自动覆盖本地已有 pack，防镜像把本地新编辑冲掉；见 D3）。
3. **提升托管**：新动作「把技能纳入托管」——
   - 源=agent 级技能：服务端复制为 user paste pack（slug 冲突检测）→ 走现有 installFromPaste → **自动进入既有 onChanged 镜像队列 push 到 gitee**；
   - 源=paste/upload pack：已在镜像范围，标 hosted 即可；
   - 源=git pack：已有上游，提示「已由上游仓库托管」，不重复纳管。

推送时机、串行队列、凭证、审计**全部沿用** skill-repo-sync 现状（onChanged 即时 push，失败落 lastSyncStatus）。

### 3.3 安装落点：目标解析器（对应 skills.sh 的 project/personal）

| 落点 | 位置 | 运行时消费 |
|---|---|---|
| `user` 级 | 现有 `installFromPaste` → `.skills/<slug>` pack | 现状不变（claude/codex；zcode 待 spike） |
| `agent` 级 | `<agentDir>/workspace/.agents/skills/<name>` | **pluginPaths 增列**：对声明了 agent 级技能的 agent，`ensureSdkPluginLayout(workspace/.agents/skills)` 生成标准 plugin 目录后加入 opts.pluginPaths——**claude 原生直挂、codex 物化器自动覆盖**（两者都消费 pluginPaths，零引擎改动） |

选择面：
- 平台工具 `write_skill` 增参 `target: "user" | "agent"`（默认 user，兼容存量）；装配面从内置作者 agent **扩展为所有开启技能工作流的 agent**（或按 agent 勾选，见 D6）；
- SkillsPage 技能行的「安装到…」动作 + AgentEditor 的落点选择。

### 3.4 全量视图：无状态扫描归并

`GET /api/skills/inventory`（属主口径；admin 可带 userId）：

```
inventory = packs(DB 四源)
          ∪ builtin(builtinSkillsDir 扫描)
          ∪ agentWorkspaces(属主各 agent 的 workspace/.agents/skills 有界扫描，复用 scanSkillPack)
          ∪ repoManifest(.skill-repo-cache/manifest.json → hosted 标记)
```

- 有界扫描：maxdepth 与条目上限沿用 scanSkillPack 的防 DoS 参数；agent 数量 × 浅扫描在单用户规模下毫秒级。
- 每条带动作面：启停（pack）、安装到 agent（任意源）、提升托管（agent/paste 源）、回装（repo 源）、查看（详情含 SKILL.md 渲染）。
- SkillsPage 重构为 inventory 视图（来源徽章 + 托管状态列 + 仓库配置卡）；AgentEditor 技能树追加「本 agent 工作区」组（`agent-skills:*`）。
- 无新表（文件系统即事实源，扫描即视图）；若后续性能需要再加缓存索引（M3 可选项，见 D2）。

### 3.5 治理与安全

- **出网即审计**：所有 push/回装经 skill-repo-sync 串行队列，落 lastSync* + audit_events；「提升托管」为用户主动动作，warning 级提示 + 审计，**不设审批卡**（用户自己的仓库；与现 onChanged 自动 push 同级，见 D5）。
- **脱敏扫描**：入镜像前对 SKILL.md/scripts 做凭证值模式告警（检测疑似 token/密码字面量，warning 不阻断，走装备告警通道口径）——防「凭证随技能进 git」。
- **命名空间隔离**：pack slug（user 级）/ `agent-skills`（agent 级）/ `system`（builtin）/ 仓库 `packs/<slug>` 四界互斥；回装时 slug 占用检测走「显式替换」确认。
- **守卫不松**：agent 侧依然拿不到后端 .env/DB（敏感读守卫照旧）；技能来源信息经 API 显式暴露（sourceJson 本就在 /api/skills/packs 返回），agent 想知道「这包哪来的」应走 API/工具而非翻盘。
- **机器级技能混入问题**（本机 `.agents/skills` 的 skill-creator 等泄入 zcode 会话——生产冒烟实证）：属引擎治理问题，纳入 zcode 技能 spike 一并收口（平台技能白名单 vs 机器级发现的优先级声明）。

---

## 4. 数据模型改动（最小化）

| 对象 | 改动 |
|---|---|
| `user_skill_repos` | 无 schema 变化（回装是动作非配置；可选 `autoPush` 默认 true，见 D4） |
| `skill_packs` | 无变化（回装的包= kind:git + subPath 既有形态） |
| agent 级技能 | 无表（扫描即视图）。仅当 D2 裁定需要独立启停时，加 `agent_skills(userId,agentId,name,enabled)` 轻表 |
| `.claude-plugin/marketplace.json` | 纯派生文件，随镜像提交生成（生成器带版本号字段） |

---

## 5. 分期实施

- **M1 全量视图**（先让资产可见，纯读零风险）：inventory API + SkillsPage 重构（徽章/托管列/仓库卡）+ AgentEditor「本 agent 工作区」组。验收= c385dc71 的 ops-check-stock-analysis 出现在列表。
- **M2 双落点安装**：agent 级落点 + pluginPaths 消费（claude/codex 实证）+ write_skill target 参数 + 安装动作落点选择。验收= SkillsPage 把任一技能装到指定 agent，该 agent 会话可用（codex/claude 双引擎冒烟）。
- **M3 托管闭环**：提升托管 + marketplace.json 生成 + 回装 + 脱敏扫描。验收= c385dc71 全流程复演：工作区技能 → 提升托管 → gitee 可见（含 marketplace.json）→ 另一 agent 回装可用。
- **并行依赖**：zcode 引擎技能物化 spike（G5，独立轮——完成前 zcode 会话对平台技能的缺口维持现状注记）。

---

## 6. 拍板项

- **D1** 个人技能仓库=升级复用现有 user_skill_repos 单仓库（推荐：一份资产一处真相）vs 允许配置多仓库（pack 级路由）。
- **D2** agent 级技能是否需要独立启停/进白名单勾选？（推荐：默认对该 agent 全量可用、不占白名单开关——「自己的目录自己负责」；需要精细控制再建表）
- **D3** 回装语义（推荐：仅补缺 + 显式替换确认，不做自动覆盖）。
- **D4** push 时机（推荐：保持 onChanged 即时，现状即最优；批处理仅在仓库限流时启用）。
- **D5** 提升托管/回装是否要审批卡（推荐：不要卡——自有仓库+审计留痕即可，与自动 push 同级）。
- **D6** write_skill 装配面（推荐：所有 agent 默认可写 agent 级（写自己工作区），user 级安装维持内置作者 agent 限定——防止普通 agent 廉价制造全局资产）。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 工作区扫描性能（agent 多/目录大） | 有界扫描 + 属主过滤；必要时 M3 加缓存索引 |
| 镜像仓库被外部改动（push 冲突） | 现有 `pull --rebase --autostash` 重试已兜底；marketplace.json 派生文件幂等重写 |
| 技能内容夹带凭证入 git | 脱敏扫描 warning + 审计 |
| zcode 引擎消费缺口被误判为本设计失败 | 文档与注记显式声明 G5 独立；验收以 claude/codex 双引擎为准 |
| `agent-skills` plugin 名与用户 pack 撞名 | plugin name 保留字校验（安装器 slug 校验处加保留字表） |
