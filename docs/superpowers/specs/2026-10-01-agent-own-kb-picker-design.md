# 智能体「独立知识库」勾选化设计

- 日期：2026-10-01
- 状态：待拍板（未动码）
- 触发：用户反馈——智能体编辑页「独立知识库」不应让用户输入名称，应改为勾选

## 1. 现状读码结论

| 事实 | 位置 |
| --- | --- |
| agent 侧唯一绑定字段 `knowledgeBaseIds: string[]` + `kbAutoLearn` | `src/domain/agent.ts:159` |
| 「独立知识库」**不是数据字段**，是前端快捷建库流：保存时 `kbNewName` 非空 → `POST /api/kb {name, description, sourceAgentId}` → 新库 id 并入 `knowledgeBaseIds` | `web/src/pages/AgentEditorPage.tsx:211` |
| 「可写」判定已存在：`canManageKb`（属主/admin）；绑定库中本人库即可写 | `src/domain/kb-policy.ts` |
| 自动学习候选 = 绑定库 ∩ canManageKb，LLM 从候选集选一个写入 | `src/orchestrator/orchestrator.ts:1040`、`src/orchestrator/kb-auto-learn.ts:105-133` |
| KB 列表接口已下发 `_role: "manage" \| "use"`，前端绑定列表已用它标「（只读）」 | `src/adapters/web-channel.ts:6921`、`KnowledgeSection.tsx:73` |

**架构判断**：「独立知识库」要回答的问题从来不是「新建的库叫什么名字」，而是「这个智能体的可写库是哪个」。文本框把「新建」这一个特例当成了主路径，既不能指定已有库，又诱导产生重名/孤儿库。改法不是换一种输入，而是把「可写目标」显式化为一次选择，建库降级为选择列表里的一个选项。

## 2. 方案（推荐）：独立知识库 = 可写库单选勾选

### 2.1 交互

- 「独立知识库」的 `Input` 替换为**单选勾选列表**：视觉与「绑定的知识库」同款（Checkbox 行 + hover），但选中互斥（点选新行自动取消旧行）。
- 候选集 = `fetchKnowledgeBases()` 过滤 `!builtin && _role === "manage"`。共享只读库（`role==="use"`）与内置库不出现——它们不可写，语义上不可能是「独立库」，无需灰显。
- 列表尾部固定一行伪选项「＋ 新建独立知识库」：勾选后展开内联命名输入，占位 `<agent名>-知识库`。现建库流（含 `sourceAgentId` 溯源）原样后移到这里，是唯一保留的输入面，且有默认名兜底。
- **独立蕴含绑定**：勾选已有库或新建 ⇒ 该库 id 幂等并入 `knowledgeBaseIds`；绑定列表中对应行显示「可写·独立」徽标（Badge），与普通绑定区分。
- 不勾任何项 = 无显式可写库，行为与今天一致（见 2.3 回退）。
- 列表超过约 8 项时限高滚动（复用 `ConversationScopePicker` 的 `max-h-44` 手法），移动端友好。

### 2.2 数据模型

- agent 增可选字段 **`kbWriteTargetId?: string`**（`src/domain/agent.ts` AgentSchema）。KB 侧不动：`KbLibrary.sourceAgentId` 保持「创建溯源弱引用」语义不变（agent-own-kb-picker 与溯源解耦，避免多 agent 共用一库时溯源字段打架）。
- 命名取行为义（写目标）而非 UI 名（独立库），字段含义即实现。
- 后端保存校验（web-channel agent create/update handler）：`kbWriteTargetId` 有值时——
  1. 库必须存在且 `canManageKb(lib, actor)`（共享只读库 / 不存在的库 → 400）；
  2. 通过则幂等并入 `knowledgeBaseIds`（不满足时前端同源校验先行禁用保存）。

### 2.3 自动学习写入目标（唯一的行为变化点）

- `kbWriteTargetId` 有值 ⇒ 候选集收窄为该库（`libs.get` miss 时回退全量候选，悬空容忍）；
- 无值 ⇒ **现行为不变**（全部可管理绑定库，LLM 挑选）。存量 agent 无此字段，行为零变化。
- 范围外（明确不动）：对话中 `kb_write` 工具仍按「绑定 + canManageKb」写任意可写库（`orchestrator.ts:408`）——独立库只收窄**自动学习**的沉淀目标，不收窄对话期写作能力，避免误伤合法用法。

### 2.4 兼容与迁移

- 存量数据零迁移：无字段的 agent 走回退分支。
- 旧版 bundle（PWA SW 缓存未刷新的客户端）提交的表单不含新字段，后端按可选字段容忍，无破坏。
- 库被删除：agent 字段悬空，读路径已 miss-tolerant（`lib && …`）；编辑页候选列表不含悬空 id，展示「原独立库已删除」内联提示并在保存时归一清空（与绑定列表悬空 id 同法，无需级联清理）。

## 3. 边界情况

1. **被分享 agent 的编辑**：候选集与「新建」均按**发起保存的操作者**身份取（`_role` 已按 actor 计算）；独立库归操作者所有——与现建库流（createKb 以操作者身份）一致。
2. **复制 agent**：字段随表单复制，副本与原 agent 共用同一可写库；不自动新建库（与现「命名才建库」一致）。
3. **自动学习开启但未勾独立库**：hint 文案显式说明回退语义「写入绑定的可写库（多个本人库时由模型选择）」，让回退行为可见而非隐性。
4. **新建名称重名**：沿用现建库流的重名约束（有则同现状，无则不新增），靠 id 区分。

## 4. 备选方案 A（更轻，不推荐但列出）

删除「独立知识库」文本框，绑定列表每行加「可写 / 只读」徽标，尾部加「＋ 新建知识库并绑定」按钮。零 schema、零行为变化、概念从三个收敛为一个。代价：「本智能体的可写库」仍是隐式推导，绑定多个本人库时自动学习写入分散；用户「勾选指定可写库」的诉求没有被正面回答。若用户本意只是「不要让我起名」，这是最小改法。

## 5. 拍板点

| # | 决策 | 推荐 |
| --- | --- | --- |
| 1 | 单选 or 多选 | **单选**。读=多（绑定）、写=一（独立）的心智模型；多选会让「独立」退化为「绑定的本人库子集」，无独立行为含义 |
| 2 | 自动学习写入目标是否收窄到独立库 | **是**（有值收窄、无值回退现行为）。否则新字段只是 UI 装饰，违背「字段必须有行为含义」 |
| 3 | 「个人知识库」是否进独立库候选 | **不进**。个人库是跨智能体的个人记忆面（禁分享、每用户一个），语义与 agent 专属库重叠；它已在绑定列表且天然可写 |
| 4 | 「新建独立知识库」伪行是否保留 | **保留**。懒建库是现存价值（不必先去知识库页创建）；但降级为选择列表的末位选项，不再是主路径 |

## 6. 改动清单（预估）

- `web/src/pages/agent-editor/KnowledgeSection.tsx`：Input → 单选列表 + 「＋ 新建」伪行（复用 Checkbox / Badge / max-h 滚动）。
- `web/src/pages/AgentEditorPage.tsx`：`kbNewName` 状态改为 `kbTarget: {mode: "none"|"existing"|"create", id?, name?}`；`handleSave` 建库分支仅在 create 模式触发。
- `web/src/pages/agent-editor/model.ts` + `src/domain/agent.ts`：增 `kbWriteTargetId`。
- `src/adapters/web-channel.ts`：agent save 校验 + 幂等并入绑定。
- `src/orchestrator/orchestrator.ts`：自动学习候选集收窄（约两行）。
- 测试：save 校验（400 面）、收窄/回退分支、悬空库归一、并发淘汰等存量用例回归。
