# Skills / Memory / KB 优化与重构方向

> 2026-10-14。基于社区方案调研（Anthropic Agent Skills、Mem0、Letta/MemGPT、Zep/Graphiti、
> Claude Code auto memory、Cursor/Windsurf Memories、Voyager 技能库）+ 平台代码实证
> （memory-store / kb-auto-learn / zcode-agent-runner / orchestrator）+ 生产会话 60475bae 取证。
> 前置阅读：docs/kb-memory-skills-lifecycle.md（三通道机制与生命周期梳理）。

## 1. 社区方案全景

### 1.1 Skills（程序性知识）

| 方案 | 核心机制 | 对 donger 的启示 |
|---|---|---|
| Anthropic Agent Skills（agentskills.io 开放标准，MS Agent Framework 等已采纳） | 渐进披露三层：启动只载 name+description → 触发载 SKILL.md 正文 → 按需读附带资源。**description 质量决定触发准确率**；可携带 scripts/templates | donger 的 G5 物化+原生发现已经是这个模型；差距在 description 治理（>1024 字符丢弃线无校验）与包完整性（引用脚本不随包） |
| Voyager 技能库（arXiv:2305.16291） | 经验 → 生成可执行技能 → **自验证通过才入库** → embedding 检索复用与组合；技能可迁移新环境 | 「验证门」思想：未经实战验证的知识不进技能库——晋升机制缺的就是这道门 |

### 1.2 Memory（会话/个性化记忆）

| 方案 | 核心机制 | 对 donger 的启示 |
|---|---|---|
| Claude Code auto memory | **MEMORY.md 索引常驻**（前 200 行自动进系统提示，是唯一自动加载的记忆文件）+ 类型化主题文件（user/feedback/project/reference）按需读；索引超限即截断告警 | 索引换检索：常驻一份小索引，比运行时检索可靠得多——正是 donger 记忆召回（整句子串匹配）需要的替代方案 |
| Mem0（arXiv:2504.19413） | 两阶段管线：LLM 从对话**萃取原子事实** → 检索相似记忆 → LLM 决策 ADD/UPDATE/DELETE/NOOP（v3 简化为单趟 ADD-only 萃取，整理独立） | donger 的 memory.append 是无萃取原文倾倒（184 条垃圾的根因）；kb-auto-learn 已是萃取管线，缺的是「与现有记忆比对去重」和分类路由 |
| Letta/MemGPT | 分层：core memory blocks（小、常驻、模型自编辑）/ recall（会话史）/ archival（归档检索）+ **sleep-time compute**（闲时异步整理重组记忆） | 分层对应 donger 的 memory/KB/audit 三层已天然存在；闲时整理可直接复用平台常驻进程+任务队列 |
| Zep/Graphiti（arXiv:2501.13956） | 时序知识图谱，bi-temporal（事实有生效/失效区间），旧事实失效而非堆积 | 重方案不引入（单机 SQLite），但「状态类知识要失效」的思想可用 frontmatter 惯例低成本承接 |
| ChatGPT saved memories | 萃取事实列表，用户可见可管理 | 治理透明性：记忆条目应可列出、可删（donger MemoryStore 已有 list/remove，缺 UI 入口） |
| Cursor / Windsurf Memories | 从对话自动生成项目级记忆，**生成即规则化**（与 rules/skills 体系衔接） | 「记忆→规则/技能」的晋升不是 donger 独有难题，业界做法就是把记忆产出直接接入规则体系 |

### 1.3 KB（知识库）

社区主流是向量 RAG / GraphRAG / 时序图谱，但 donger 单机 SQLite + 已验证的 FTS5 中文逐字切分 + agentic 检索（kb_search）组合，在当前规模下够用且已被先前调研轮确认（向量 RAG 预留、sqlite-vec 否决）。本轮调研无推翻该结论的新证据；可借鉴的只有 Zep 的时间失效思想（frontmatter 惯例）。

## 2. Gap 映射（社区共识 vs donger 现状）

| 维度 | 社区共识 | donger 现状 | 判定 |
|---|---|---|---|
| 记忆写入 | LLM 萃取原子事实 + 去重决策 | 每任务原文倾倒，已积 184 条（hi/同意/继续…） | ❌ 根本性缺口 |
| 记忆召回 | 索引常驻 or 语义检索 | 整句子串匹配，几乎恒不命中 | ❌ 通道死亡 |
| 记忆整理 | 异步闲时整理 + TTL/失效 | 无整理、无上限、无清理 | ❌ 单向膨胀 |
| 技能触发 | 渐进披露，description 即触发面 | G5 物化+原生发现已实现 | ✅ 保持 |
| 技能入库 | 验证门（验证通过才入库） | 无校验：引用脚本可不随包 | ⚠️ 缺校验 |
| 经验→技能晋升 | Voyager 验证门 / Cursor 记忆→规则 | 完全缺失（坑沉淀进 memory/ 而非技能） | ❌ 关键链路 |
| 状态知识时间性 | bi-temporal 失效语义 | kb_revisions 有时间轴，无失效惯例 | ⚠️ 惯例缺失 |
| 知识检索 | agentic + 混合 | agentic + FTS5 | ✅ 保持（先前调研结论） |
| 生态兼容 | agentskills.io 开放标准 | SKILL.md 基本兼容 + 自家 pack 扩展 | ✅ 基本对齐 |

## 3. 重构方向

### 3.0 核心收敛点：一个萃取出口，四个落位

把「对话收尾的知识沉淀」从两条并行且互不相知的链路（memory.append 原文倾倒 + kb-auto-learn 可选开关）收敛为**一个默认编排器**：

```
会话 finish
  └─ 一次 LLM 萃取调用（复用 kb-auto-learn 管线：频控/串行队列/wrapUntrusted/审计）
      ├─ ① 个性化事实/偏好（type: user/feedback/project）
      │      → memory/curated/ 原子条目，先检索现有条目比对：命中→UPDATE，过时→标 superseded
      ├─ ② 状态/历史（部署记录、巡检、已知问题）→ agent 库 ops/ + index（现状正确，保留）
      ├─ ③ 程序性 How-to → 产出「技能修订建议」diff 事件 → 转介 skill-upgrade 审批落盘
      └─ ④ 平台环境约束（沙箱工具面/校验器怪癖）→ 上报 AGENTS.md 层的候选条目
```

这就是 Mem0 管线（萃取+决策）、Claude Code 类型化记忆（分类落位）、Cursor memories→rules（晋升衔接）三个社区方案的合流，且全部构件（auto-learn 队列与频控、skill-upgrade 审批、AGENTS.md 交付、kb_revisions）平台已拥有。**memory.append 的无脑倾倒退役**（或降级为萃取不可用时的降级通道，且只存「任务+一句话摘要」）。

### 3.1 Memory 通道重构（P0，最痛）

1. **索引常驻替代检索**（Claude Code 模式）：`memory/curated/` 维护一份 MEMORY.md 式索引（每条一行、≤200 行），**整份注入系统提示词**；详情文件按需 Read。运行时 `memory.search` 子串匹配退役——索引常驻后不再依赖召回质量，这绕开了单机无向量的根本限制。
2. **条目结构化**：frontmatter 带 `type`（user/feedback/project/reference）、`created`、`lastHit`、`scope`；正文 Why/How to apply（本轮 agent 自发写出的格式恰是社区共识，升为规范）。
3. **生命周期管理**（Letta sleep-time + Zep 失效思想）：平台常驻进程闲时任务做整理——合并语义重复条目（Mem0 UPDATE）、`lastHit` 超 N 天且非 project 类移入 `archive/`；整理动作记 `kb_revisions`（actorKind=memory-consolidation）。索引行数超限即触发强制整理。
4. **auto/curated 分目录**：机器倾倒（若保留降级通道）与精选隔离，kb_list 顶层目录区分展示。

### 3.2 Skills 通道强化（P1）

1. **包完整性验证门**（Voyager verify-before-promote）：物化器校验 SKILL.md 引用的 scripts/ 资产存在性，缺失即告警拒绝物化（本轮 ops-check 实锤）；`update_skill`/安装器做引用 lint（skill-upgrade 流程已有「引用工具名逐一核对」，下沉为自动校验）。
2. **description 治理**：编辑器与物化器校验 ≤1024 字符丢弃线；skill-upgrade 增加触发面审查步骤（用 donger-audit 检索「该触发而未触发」的会话证据——流程已有）。
3. **晋升门常态化**：3.0 的 ③ 路由落地后，技能修订从「用户灵感驱动」变为「萃取器证据驱动 + 审批卡把关」；git 源技能放开「本地修订+回推建议」二段式。
4. **生态对齐**（P2）：frontmatter 保持 agentskills.io 标准字段超集，为直接消费社区技能市场留门；pack 体系不动。

### 3.3 KB 通道增强（P1/P2，小步）

1. **状态条目失效惯例**（Zep bi-temporal 的低成本形态）：新记录写入时自动把被取代的旧记录 frontmatter 标 `superseded-by`，index.md 惯例已有「更正旧记录」实践（本轮 agent 手工做了），升为 auto-learn 的写入规范。不引入图谱。
2. **检索保持 agentic+FTS5**：先前调研结论不变；kb_search 工具描述补充中文逐字切分的查询写法提示。
3. **只写不读可视化**（治理面）：审计已有 kb_read/kb_search 记录，加一个库级「被读次数/条目数」比值指标，支撑晋升与清理决策。

### 3.4 明确否决项

- **向量库 / sqlite-vec / GraphRAG**：先前调研已否决，索引常驻方案落地后规模上限更高，维持。
- **引入外部记忆服务（Mem0/Zep SaaS 或自托管）**：多一个有状态服务违背单机轻量定位；萃取管线平台内一次 LLM 调用即可。
- **时序知识图谱（Graphiti/Neo4j）**：部署形态冲突，bi-temporal 思想用 frontmatter 惯例承接。
- **把 memory 并回 KB 全文检索**：memory 的价值在常驻索引与快通道，不在检索。

## 4. 落地路径（对应平台迭代节奏）

| 步骤 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| M1 | memory.append 降噪（截断/开关）+ auto/curated 分目录 | 小（memory-store + orchestrator 两处） | 无 |
| M2 | curated 索引常驻注入 + 索引生成/超限告警 | 中 | M1 |
| S1 | 物化器引用校验 + description 1024 校验 | 小 | 无 |
| M3 | auto-learn 扩为四路萃取编排器（默认开，memory 退役为降级通道） | 中 | M2 |
| S2 | ③ 路由转介 skill-upgrade（修订建议 diff 事件 + 审批） | 中 | M3 |
| M4 | 闲时整理任务（合并/归档/lastHit 淘汰，复用任务队列） | 中 | M2 |
| K1 | superseded 写入规范 + 库级被读指标 | 小 | M3 |

验收样板：以生产会话 60475bae 回放——技能触发保留；物化校验在 S1 拦下 ops-check 缺脚本；收尾萃取按四路分流：两篇坑（SSH 执行器/npm 策略）走 ③ 生成 ops-check 修订建议进审批（而非落入 184 条噪声），部署记录照旧落 ops/，路径校验怪癖走 ④ 上收 AGENTS.md；下一轮部署会话由常驻索引直接命中执行器方案，零试错。
