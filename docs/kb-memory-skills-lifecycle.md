# KB / Memory / Skills 在 Agent 对话生命周期中的作用与系统化管理

> 2026-10-14。基于生产会话 `60475bae`（「帮我部署最新代码」，stock-analysis-ops）全链路取证
> + 平台代码实证（orchestrator / kb-auto-learn / memory-store / zcode-agent-runner / kb-tools）。

## 0. 一句话结论

三者是三条不同性质的通道：**Skills 是推送通道（触发面，程序性知识）**，**KB 是拉取通道（检索面，状态与历史知识）**，**Memory 是上下文恢复通道（注入面，会话连续性线索）**。KB 不能替代 Skills——生产实证：同一份部署知识在 KB 里存有一份（10-13 沉淀），次日在真正要用的那轮对话中一次都没被读，驱动执行的是技能。当前平台最痛的不是缺机制，而是 Memory 通道「写满、读死」与「沉淀→技能」晋升链路缺失。

## 1. 三通道的机制实证（代码事实）

### 1.1 Skills（技能）

| 层 | 实现 |
|---|---|
| 存储 | `skill_packs`（包，三源：paste / git / builtin）+ `pack_skills`（技能行）；builtin 包在仓库 `skills/`（deploy-operator、skill-create、skill-upgrade、task-dispatch、task-optimize、web-ui-iterate） |
| 选择 | `agents.data.skillGroups` 技能树形勾选 → 白名单 |
| 物化 | G5 收口：每轮整根重建 `<重定向HOME>/.zcode/skills`（zcode 引擎原生发现根）；codex 走 CODEX_HOME 同一物化器。**description >1024 字符的技能被 CLI 整体丢弃**（官方硬约束） |
| 触发 | 引擎原生技能发现：名称+描述每轮常驻上下文 → 模型调 Skill 工具 → SKILL.md 全文注入。**零检索、零回合、按需加载** |
| 治理 | `update_skill` 落盘弹审批卡；`skill-upgrade` 内置技能定义了证据驱动修订流程：仅 paste/upload 源可写，git 源只读（给上游修改建议），builtin 报平台管理员；修订不得扩大危险面 |

关键性质：SKILL.md 可携带可执行资产（scripts/）。本轮实证的缺陷面：`ops-check-stock-analysis` 引用的 `scripts/homedb_ssh.py` 从未随包物化，且文档指路 `uv + paramiko` 而沙箱无 python/uv/curl/ssh —— 技能半失效，agent 被迫现场用 node ssh2 手写执行器（约 7 分钟、8 回合的试错代价）。

### 1.2 KB（知识库）

| 层 | 实现 |
|---|---|
| 存储 | `kb_libraries`（库）+ 文件系统 markdown（`kbRootDir`）+ `kb_revisions`（每次变更自动记修订：action / actorKind=conversation\|auto-learn / summary / diff / hash）+ `kb_fts`（FTS5 影子索引，中文逐字切分已修 0 命中问题） |
| 库型 | 个人库（每用户恒挂载，`ensurePersonalLibrary` 系统自动创建，目录规范 `agents/ knowledges/ memory/ skills/ workflows/`）；agent 独立库（sourceAgentId）；共享库（kb_shares / kb_share_grants） |
| 挂载 | `agents.data.knowledgeBaseIds` 绑定 + 个人库兜底恒挂载；每轮系统提示词注入「可用知识库」清单：kbId / 名称 / 可维护性 / 描述 / 库提示词（他人库 wrapUntrusted）/ 顶层目录，约 200 字/库 |
| 工具面 | `donger-kb` MCP：kb_list / kb_read / kb_search / kb_write / kb_delete；写路径有 tool-call-guards + bash-kb-guard（防 Bash 绕过写库） |
| 自动学习 | `kbAutoLearn=true` 且绑库时，会话成功收尾**异步 LLM 梳理**沉淀为 markdown 写入候选库（`kbWriteTargetId` 收窄目标）；频控 5 次/会话/日；产出 ≤32KB；wrapUntrusted 防注入；同会话串行队列；失败静默落 `kb_auto_learn_error` 审计 |
| 检索 | **agentic 模式**：模型主动 kb_search（FTS5）或浏览 index.md；无自动 RAG 注入 |

关键性质：KB 内容**不主动出现**在上下文里——系统提示词只给目录骨架，内容要不要读取决于模型自觉。这是它与技能的本质差异。本轮实证：kbAutoLearn=false，全靠模型自觉沉淀（5 次 kb_write，规范且有修订留痕），但只读了 index.md 一次、kb_search 一次没用。

### 1.3 Memory（记忆）

| 层 | 实现 |
|---|---|
| 存储 | `MemoryStore` = **个人库 `memory/` 子目录**（spec §5.4 D5：记忆统一进标准知识库架构，旧 `knowledge_base/user` 已迁移退役）。文件格式 `# {summary}\n\n{detail}`，文件名 `{timestamp}-{slug}.md` |
| 写入 | **每成功一轮自动追加**（orchestrator 两处 `memory.append`：summary=prompt 前 40 字，detail=prompt+结果**原文**）。无 LLM 梳理、无去重、无上限、无清理 |
| 读取 | 每轮开场 `memory.search(task.prompt)` 取前 5 条注入「## 相关记忆」——但检索实现是**整句 prompt 作为子串**匹配 summary+detail，多词长 prompt 几乎恒不命中 |
| 引擎原生记忆 | zcode 引擎自身记忆功能落在重定向 HOME（`.zcode-home`），在沙箱写边界外 → **不可写**（本轮 agent 实证：写不进，自行 fallback 到个人库 `memory/`，客观上撞对了平台正道） |

生产现状实证：个人库 `memory/` 已积 **184 个自动倾倒文件**（`hi.md`、`同意.md`、`继续.md`、`冒烟锚点-菠萝披萨-请原样复述这句话.md`……），与 2 篇人工精选的坑沉淀混在同一目录，且经 kb_list 的顶层目录暴露给所有会话。**记忆通道当前写满、读死**：写入是无差别倾倒，召回是几乎失效的子串匹配，精选知识混在噪声里无法浮出。

## 2. 生命周期映射：三通道在何时起作用

```
轮次开始（session_init）
 ├─ 技能物化：白名单 → <HOME>/.zcode/skills（每轮整根重建）
 ├─ 提示词组装：身份层/AGENTS.md + 知识库清单（kbId+顶层目录+库提示词）
 ├─ 记忆召回：memory.search(prompt) →「## 相关记忆」≤5 条（当前近乎失效）
 └─ 引擎原生技能发现：名称+描述常驻（触发面就绪）

轮内执行（turn loop）
 ├─ Skill 工具触发 → SKILL.md 全文注入（推送通道：架构事实/流程/脚本）
 ├─ kb_list / kb_read / kb_search 按需拉取（拉取通道：历史记录/状态）
 ├─ kb_write 落库（守卫+自动修订）；
 └─ Bash/Write 过守卫（含 bash-kb-guard 防绕库写）

任务收尾（task end）
 ├─ memory.append 自动倾倒一条原始 prompt+结果（无梳理）
 └─ 会话 finish → kbAutoLearn? → 异步 LLM 梳理 → 候选库（5/日、≤32KB、修订留痕）

跨轮沉淀（人工/自动）
 ├─ KB：kb_write + kb_revisions 修订 + kb_fts 索引
 ├─ 技能：skill-upgrade 证据驱动修订（审批卡）/ git 源回推上游
 └─ 下一轮受益：技能描述常驻 + 记忆注入 + KB 清单
```

各阶段的主角：**开场靠技能描述与记忆注入（被动面）**，**轮内靠技能推送 + KB 拉取（主动面）**，**收尾靠 memory 倾倒与 auto-learn（沉淀面）**，**跨轮靠 KB 修订与技能修订（治理面）**。

## 3. 核心矛盾的解法：不是二选一，是分流 + 晋升

「对话后 LLM 梳理的知识存 KB 还是存 Skills」的答案按知识类型分流：

| 知识类型 | 判据 | 落位 | 理由 |
|---|---|---|---|
| 程序性/操作性（How-to） | 下次还要**照着做**（流程、排障表、环境约束、执行器方案） | **Skills**（SKILL.md 唯一真源） | 需要触发面：技能描述常驻+触发即注入，不依赖模型想起去查 |
| 状态/历史（What/When） | 只是**记录发生了什么**（部署记录、巡检、已知问题、版本轨迹） | **KB**（ops/ + index 索引） | 追加型、易腐、需要修订审计；写进技能会立即腐烂 |
| 平台环境约束 | 所有 agent 共享的事实（沙箱工具面、路径校验怪癖、代理坑） | **平台层**（AGENTS.md / 系统提示词） | 单个 agent 的 memory 各存一份 = 每个 agent 重踩一遍（本轮 `fromCharCode(47)` 绕法就是 9-21 旧账重踩） |
| 会话连续性线索 | 恢复上下文用（上次做到哪、用户偏好） | **Memory** | 短生命周期，允许陈旧，代价敏感 |

效率对比（实证数据）：

- **读路径技能完胜**：本轮技能触发是第一动作、零检索成本（一次性注入约 3k tokens，摊在 77 次 LLM 调用上可忽略）；KB 贡献发生在部署完成之后（index.md 一次），且 10-13 存的 KB 部署文档全程没被读——**发现（常驻）胜过检索（自觉）**。
- **写路径 KB 完胜**：kb_write 一步落库+自动修订；技能修订链路重（定位→编辑→审批/git 回推）且无「对话后自动沉淀到技能」的默认行为（kbAutoLearn 只产 markdown 到库）。
- **结论**：默认落 KB 是对的（低成本、可治理），但必须配晋升机制，否则 KB 变成只写不读的档案堆，而技能带着过期文档继续把每一轮引向死路。

## 4. 系统化管理建议（全部复用既有抽象，不新建子系统）

### A. 通道职责入宪（写进库提示词与 agent 提示词模板）
在个人库/agent 库的库提示词（`kb_libraries.systemPrompt`，平台已有「目录结构由库提示词规范」机制）与 AGENTS.md 交付层，固化三分流判据：How-to → 技能修订建议；记录 → 库 ops/；平台约束 → 上收 AGENTS.md。

### B. 修复 Memory 通道（优先级最高，三件事）
1. **召回修复**：`MemoryStore.search` 的整句子串匹配改为分词交集或直接挂 `kbFts`（中文逐字切分思路已在 KB 侧验证）；否则「## 相关记忆」注入永远是摆设。
2. **写入降噪**：自动 `memory.append` 截断 resultText（如 ≤500 字）只存「任务+一句话结果」；或加开关默认关闭，只留显式记忆与 auto-learn；加每 agent LRU 上限（如 100 条）。
3. **隔离**：`memory/auto/`（机器倾倒）与 `memory/curated/`（人工/auto-learn 精选）分目录，kb_list 顶层目录展示时区分，防 184 个噪声文件淹没 2 篇精选。

### C. 打通「沉淀→技能」晋升闭环（本次矛盾点的正解）
1. **auto-learn 双问句**：`kb-auto-learn.ts` 的学习 prompt 增加分类输出——状态/历史类落库（现状不变）；程序性类**不直接落库**，产出「技能修订建议」diff 事件通知用户，走 `skill-upgrade` 审批落盘。链路三件套（auto-learn、skill-upgrade、审批卡）全部已存在，只加一步分类与转介。
2. **晋升触发**：库提示词写明约定——KB 里的 How-to 条目被第二次实战使用后应晋升进技能；`kb_revisions`/audit 的 kb_read 记录已可支撑人工判断，暂不需要新机制。
3. **skill-upgrade 放宽**：git 源技能允许「本地修订+回推建议」二段式（统一托管轮的回装/提升托管机制可承接），避免 git 源技能永远只读、永远过期。

### D. 技能包完整性校验
1. 物化器顺手校验 SKILL.md 引用的 scripts/ 资产存在性，缺失告警（本轮 `ops-check` 实锤：引用脚本从未随包）。
2. 编辑器/`update_skill` 保存时校验 description ≤1024 字符（G5 实证丢弃线）。

### E. 治理留痕
1. `kb_revisions.actorKind` 扩 `skill-promotion`，晋升动作入库可审计。
2. auto-learn 增加「产出被采纳/被回滚」事件（现状只有 `kb_auto_learn_error`，正常成功路径静默，无法复盘学习质量）。

## 5. 本轮会话（60475bae）作为验收样板

按上述方案回放本轮：技能触发正常（✅ 保留）；技能半失效应在 D1 物化校验时暴露；约 7 分钟的工具面试错与路径校验对抗，靠 E 之外的「平台约束上收 AGENTS.md」消除；收尾 5 次 kb_write 中，两篇坑按 C1 应产出技能修订建议（`ops-check` 的沙箱执行器节 + npm 策略节）走审批卡，而非落进个人库 memory/ 与 184 个噪声为伍；部署记录与索引照旧落 agent 库 ops/（✅ 现状正确，保留）。
