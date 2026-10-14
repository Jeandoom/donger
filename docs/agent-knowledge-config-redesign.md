# 知识体系（Skills/Memory/KB）配置化重构方案

> 2026-10-14。前置：docs/kb-memory-skills-lifecycle.md（机制梳理）、
> docs/skills-memory-kb-optimization-directions.md（方向调研）。本文给出结合当前
> agent 配置模型（AgentSchema / AgentEditor 分区）的完整落地设计：配置模型增量、
> UI 操作变更、系统行为规格、场景 case、分期与验收锚点。

## 0. 设计不变量

1. **复用既有抽象**：萃取器=kb-auto-learn 升级；晋升=skill-upgrade 流程服务化；治理=kb_revisions/audit/notifications 既有件。不新建子系统、不建新表。
2. **双轨兼容**：新字段全部 optional；存量 agent 行为逐字节不变（kbAutoLearn=false 的 agent 萃取照旧不跑）。
3. **人审关口**：任何写进技能（程序性资产）的动作必须过审批卡/通知确认；萃取器只产建议不落技能。
4. **频控内建**：萃取 5 次/会话/日、产出 ≤32KB、同会话串行（kb-auto-learn 既有约束沿用，不暴露配置）。

## 1. 配置模型增量

### 1.1 Agent 级（AgentSchema，编辑器「资源」分区）

| 字段 | 类型/缺省 | 说明 |
|---|---|---|
| `kbAutoLearn` | 既有 boolean，**语义升级** | 原「自动学习写库」→「对话收尾自动萃取沉淀」。字段名不变（零迁移），undefined 时回退读旧值。builder 新建缺省建议改 `true`（决策点 D1） |
| `learnRoutes` | `{memory?, kbRecord?, skillSuggestion?, platformNote?}` boolean ×4，缺省全开 | kbAutoLearn=true 时展示的四个路由子开关；任一路由可单独关 |
| `kbWriteTargetId` | 既有，语义微扩 | 仅作用于 `kbRecord` 路由目标收窄（既有 narrowAutoLearnTargets 逻辑不变）；`skillSuggestion`/`memory`/`platformNote` 不受它影响 |

校验通道沿用 agentEquipmentWarnings（保存时 inline 警示，不阻断）：
- 勾选技能 description >1024 字符 →「该技能会被引擎整体丢弃」；
- learnRoutes.memory=true 但用户个人库 memoryMode=off →「记忆路由不会生效」。

### 1.2 平台级（app_config，设置页 admin 区）

| key | 值 | 说明 |
|---|---|---|
| `memory.channel` | `curated`（缺省）/ `legacy` / `off` | 记忆通道全局模式。curated=索引常驻+萃取条目；legacy=旧倾倒+子串召回（兼容保留一个版本）；off=不注入不沉淀。决策点 D2（全局 vs 用户级，建议全局） |
| `platform.envNotes` | markdown 文本 | 平台环境约束（沙箱工具面、路径校验怪癖等），admin 编辑，orchestrator 组装默认提示词时注入「## 平台环境约束」节，替代各 agent 记忆里各自存一份 |

### 1.3 文件与数据约定（无需配置，萃取器写入规范）

```
<个人库>/memory/
  curated/                    # 萃取条目（精选层）
    INDEX.md                  # 索引：每条一行「- [标题](文件) — 一句话钩子」，≤200 行
    {ts}-{slug}.md            # frontmatter: type(user|feedback|project|reference)/created/scope/source
  archive/                    # 闲时整理归档（不注入）
KB ops/ 记录 frontmatter      # superseded-by: <path>（新记录写入时自动标注被取代的旧记录）
kb_revisions.actorKind        # 扩枚举：auto-learn（既有）/ memory-consolidation / skill-promotion / platform-note
```

## 2. UI 与用户操作变更清单

### 2.1 AgentEditor → 资源分区（KnowledgeSection）

现状：「自动学习与记忆」单 Switch + 可写目标单选行。
变更：
1. Switch 文案改「对话收尾自动萃取沉淀」，说明文字列四路去向（记忆/知识库/技能建议/平台约束）。
2. 开启后展开「沉淀路由」四个子开关（learnRoutes，缺省全开）：`记忆条目`、`知识库记录`、`技能修订建议`、`平台约束上报`。`知识库记录` 旁复用既有「可写目标（单选）」行，hint 更新为「仅作用于知识库记录路由」。
3. 技能树勾选行新增警示位：description 超 1024 字符的技能打红点+悬浮说明（equipment warning 通道）。

**用户操作流**：管理员打开 stock-analysis-ops 编辑页 → 打开「自动萃取」→ 保持四路全开 → 保存。此后该 agent 每轮收尾自动萃取。

### 2.2 KB 页 → 个人库新增「记忆」分区

现状：个人库与普通库同构（文件浏览/修订）。
变更（仅 personal 库展示）：
1. 顶部模式行：显示全局 memory.channel（admin 可改，普通用户只读提示）。
2. curated 条目列表：type 徽标（user/feedback/project/reference）、created、来源会话（source 链到审计）；行内操作：编辑（kb_write 复用）/删除/归档（移 archive/，记修订）。
3. 索引健康卡：INDEX.md 当前行数/200 上限，超 180 行黄色告警「将在下次整理时压缩」。
4. legacy 存量迁移卡（一次性）：「检测到 memory/ 顶层有 N 条旧格式自动记忆」→ 按钮「移入 archive/」（服务端一次性移动+记修订）。

**用户操作流**：升级后首次打开 → 看到迁移卡 → 点「移入 archive/」→ 184 条旧文件移走，curated/ 只剩萃取器此后写入的精选条目。

### 2.3 通知中心新增「技能修订建议」事件

NotificationEvent 注册 `skill_suggestion`（group=沉淀治理，severity=info，渠道 inapp）。
卡片内容：目标技能名、萃取给出的修订摘要与 diff 预览（≤50 行，全文折叠）、证据（来源会话链接+触发理由）、双动作：
- **采纳** → 跳技能编辑器预填 diff（paste/upload 源）或展示「上游回推指引」（git 源：出 patch 文件到工作区 + skills-push 提示）；
- **忽略** → 记 audit `skill_suggestion_dismissed`。

**用户操作流**：部署轮结束几分钟后收到通知 → 看 diff（把「uv+paramiko+缺失脚本」一节改写为「node ssh2 执行器 + npm --allow-remote=all」）→ 点采纳 → 编辑器确认 → update_skill 等价 API 落盘 → ops-check 技能下次部署直接生效。

### 2.4 设置页（admin）→ 平台约束

新增「平台环境约束」编辑框（platform.envNotes）：多行 markdown，保存即对全部新会话生效（orchestrator 组装默认提示词时注入）。占位示例文案预填沙箱工具面与路径校验怪癖（本轮取证的两条）。

### 2.5 技能工坊/技能包页

1. 安装/启停后的物化校验告警：SKILL.md 引用的 scripts/ 资产缺失 → 技能行黄标「引用缺失：scripts/homedb_ssh.py」+ 详情说明（不阻断，标记降级）。
2. 技能详情新增「晋升记录」节：来自 audit 的 skill_promoted / suggestion 列表（时间/来源会话/diff 摘要）。

## 3. 系统行为规格

### 3.1 萃取编排器（kb-auto-learn.ts 升级，M3 核心）

- 触发：会话 finish 且 agent.kbAutoLearn=true（不变）；频控/串行队列/≤32KB/wrapUntrusted（不变）。
- 输入新增：curated/INDEX.md 现内容（比对去重）+ agent 技能清单（name+description，供路由判断目标技能）+ memory.channel 当前值。
- 输出协议（LLM 单次调用，JSON）：
  ```json
  {"routes":[
    {"route":"memory","action":"add|update|supersede","title":"…","file":"homedb-npm-allow-remote.md",
     "content":"frontmatter+正文","indexLine":"- [标题](文件) — 钩子","rationale":"…"},
    {"route":"kbRecord","path":"ops/deploy-record-….md","content":"…","supersede":["ops/旧记录.md"]},
    {"route":"skillSuggestion","targetSkill":"ops-check-stock-analysis","diff":"…","rationale":"…","evidence":"会话 60475bae"},
    {"route":"platformNote","content":"路径校验对前导斜杠/斜杠星/正则\n误判，绕法…"}
  ]}
  ```
- 落点：memory→个人库 curated/ + 索引 upsert；kbRecord→既有候选库写入；skillSuggestion→notification+audit（不落库）；platformNote→写 `platform.envNotes.candidates`（app_config 草稿区，admin 在设置页看到「+N 条候选」合并或忽略）。
- 失败：沿用 `kb_auto_learn_error` 审计，静默。

### 3.2 记忆注入（orchestrator 组装层，M2）

- memory.channel=curated：读 `memory/curated/INDEX.md`（≤200 行截断+告警）注入「## 长期记忆索引」节，**替代**现 `memory.search` 注入；详情由 agent 按索引自行 kb_read（索引行就是文件名，零检索）。
- legacy：保留现 search 行为（一个版本的兼容窗口）。
- off：不注入。
- memory.append（每任务原文倾倒）：curated/off 模式下**退役**；legacy 模式保留但 detail 截断至 500 字。

### 3.3 技能晋升 API（S2，新增唯一服务端写入口）

- `POST /api/skills/{packId}/{skillName}/apply-suggestion`：body=修订后 SKILL.md 全文 + baseVersion。
- 守卫：属主本人；源=paste/upload（git 源 403+回推指引）；危险面 diff 检查——新增 Bash 命令/写盘路径/外发语句必须带确认标志（skill-upgrade 约束平移）；description ≤1024 校验；version+1；audit `skill_promoted`（actorKind=skill-promotion）+ kb_revisions 记 diff。

### 3.4 闲时整理（M4）

- 进程内定时（每日低峰=无 running task 时）：语义重复合并（LLM 一次调用，计入频控）、created 超 N 天且 type≠project 移 archive/、INDEX.md 重排压缩；动作逐条记 kb_revisions（actorKind=memory-consolidation）；索引仍超限则 warn 通知管理员。

### 3.5 物化校验（S1）

materializeWhitelistedSkills 增加两查：SKILL.md 正文中 `scripts/`、`assets/` 相对引用存在性（缺失→跳过该技能+warning 回显 agentEquipmentWarnings+技能页黄标）；description 字节 ≤1024（超限→同上）。安装器/update_skill 同步校验。

## 4. 场景 Case 覆盖

| # | 场景 | 配置前提 | 系统行为 | 用户操作 | 验收锚点 |
|---|---|---|---|---|---|
| A | **部署轮回放**（60475bae） | agent：kbAutoLearn=true，四路全开 | 收尾萃取四路分流：SSH 执行器/npm 策略两坑→skillSuggestion（目标 ops-check）；部署记录→ops/；路径怪癖→platformNote | 属主收通知→采纳 diff→审批落盘；admin 合并 envNotes 候选 | audit `learn_routed`×4 类；`skill_promoted` 记录；notification `skill_suggestion` 已读 |
| B | **builder 新建 agent** | 新建（D1 采纳后） | kbAutoLearn 缺省 true、routes 全开，「默认聪明」零配置 | 无（可关闭） | AgentSchema 缺省断言；新建页显示四路子开关 |
| C | **存量记忆污染**（184 条） | memory.channel=curated | 迁移器不自动动文件；KB 页迁移卡计数展示 | 用户点「移入 archive/」 | kb_revisions actorKind=memory-consolidation 1 条；curated/ 干净 |
| D | **第二轮部署零试错** | A 完成后同 agent 新会话 | 索引常驻注入「homedb 执行器/npm 策略」两行→agent 直接读详情复用，不再试 uv/paramiko、不再撞校验器 | 无 | 会话审计首 3 个 tool_use 无绕错；bundle 含「长期记忆索引」特征串 |
| E | **git 源技能晋升** | 目标技能属 git 源包 | 萃取仍产建议；通知「采纳」按钮变为「生成回推补丁」：patch 写入工作区 + skills-push 指引 | 用户在技能仓库侧合并回推 | patch 文件落 .tmp/；通知不含「应用」直写路径 |
| F | **共享 agent**（被分享者发起会话） | 被分享者非库管理者 | kbRecord 路由沿用 canManageKb 候选（既有）；skillSuggestion 通知发属主+发起者（D3），采纳按钮仅可管理者可见 | 属主采纳 | 通知 recipient 双人；非管理者无应用按钮 |
| G | **kbAutoLearn=false 的 agent** | 老配置不动 | 萃取不跑（行为不变）；memory.channel=curated 时仍享受索引注入（只读既有条目） | 无 | 该 agent 会话无 learn_routed；注入节存在 |
| H | **索引膨胀与整理** | curated 超 180 行 | 健康卡黄告警；闲时整理合并/归档、重排索引 | 无（或手动整理按钮） | kb_revisions consolidation 记录；INDEX.md ≤200 行 |
| I | **萃取关闭/频控耗尽** | off 或 5 次/日耗尽 | 静默降级：不沉淀、不弹扰；频控耗尽记 audit | 无 | `kb_auto_learn_error` 含限流文案 |

## 5. 守卫与治理

1. 萃取器输入输出全部 wrapUntrusted（既有）；技能建议 diff 过危险面检查（3.3）。
2. platformNote 候选仅 admin 可合并（设置页权限沿用 admin-only 惯例）。
3. 全链路审计：`learn_routed`（按路由计数）/`skill_suggestion_dismissed`/`skill_promoted`/`memory_consolidated`/`platform_note_merged`，均为 seq=-1 执行外事件（既有模式）。
4. 治理指标（K1）：库级「kb_read+kb_search 命中/条目数」比值入审计页会话栏折叠区，支撑晋升与清理。

## 6. 决策点（待拍板）

| # | 问题 | 建议 |
|---|---|---|
| D1 | 新建 agent 的 kbAutoLearn 缺省值 | **true**（默认聪明；存量不自动打开） |
| D2 | memory.channel 全局 or 用户级 | **全局 admin 档**（单机治理一致性；有真实需求再下沉） |
| D3 | skill_suggestion 通知收件人 | **属主+会话发起者**，操作权=可管理者 |
| D4 | platform.envNotes 存储 | **app_config 新 key**（纯 DB 单一真源惯例） |
| D5 | 记忆 lastHit 追踪 | **v1 不追踪**，整理按 created+type；避免写放大 |

## 7. 分期落地

| 期 | 内容 | 规模 | 验收 |
|---|---|---|---|
| P1 | memory.append 截断+legacy/curated 目录分离；S1 物化校验+1024 校验；envNotes 编辑框 | 小 | Case C 迁移卡；ops-check 缺脚本黄标 |
| P2 | curated 索引常驻注入（替换 search）；KB 页记忆分区 UI | 中 | Case D 特征串+零试错 |
| P3 | 萃取编排器四路协议；AgentEditor 路由子开关；platformNote 候选流 | 中 | Case A 四路审计齐全 |
| P4 | skill_suggestion 通知+晋升 API+技能页晋升记录 | 中 | Case A/E/F 采纳链路 |
| P5 | 闲时整理+治理指标 | 中 | Case H |

每期独立可上线（P1 与 P2 之间无硬依赖顺序约束，P3 依赖 P2 的索引文件存在）。
