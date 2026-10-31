# 工作流处理登记（幂等键）设计方案

> 2026-10-30 · 需求方：TB bug 自动分析「一次任务只分析一次」；交付待拍板（本文档未动码）

## 1. 需求与场景

TB 监听工作流按 **@、执行者、参与人** 三路条件扫任务，同一任务天然可能多次命中：

- 同一轮内多路条件同时命中（执行者+参与人+被 @）——已由路由合并去重解决；
- **跨轮命中**：任务本轮被分析后，下一轮因再次被 @、被改派、被拖入参与人而重新进入候选；
- **并发轮命中**：30 分钟定时轮 + 手动触发轮同时扫到同一任务。

要求的语义：**一次 TB 任务只分析一次**（严格一次），不因条件多次命中而重复分析/重复评论。

### 现状与缺口

当前幂等靠**提示词软约束**：prompt 指示 agent 查任务动态、发现已有【AI助理回复】开头的评论则跳过。生产验证两轮均正确，但存在四个结构性漏洞：

| # | 漏洞 | 后果 |
|---|---|---|
| 1 | LLM 非确定性：动态列表很长时可能漏查标记 | 同任务重复分析 |
| 2 | 并发轮竞态：两轮同时扫到同一任务、都未见标记 | 双写评论 |
| 3 | 多条件叠加：A 条件处理中、B 条件同轮再命中 | 提示词口径复杂易错 |
| 4 | 标记可被人为删除/改写 | 失去幂等真源 |

结论：幂等需要**机器强制的平台能力**，提示词只做人读交互。

## 2. 社区案例对照

| 案例 | 机制 | 对本设计的启示 |
|---|---|---|
| n8n「Remove Duplicates」节点（Remove Items Processed in Previous Executions 模式） | 平台内置节点：用户配置业务键字段，跨执行持久化已处理键 | **成品化幂等=平台能力+用户只配键**，不靠提示词 |
| 幂等键 + 条件写入（Idempotency Key + Conditional Insert） | check-and-write 对已处理项存储，副作用前判定 | 认领必须是**原子操作**（INSERT OR IGNORE），非查询后判断 |
| Inbox Pattern（幂等消费者） | 业务键与副作用**同事务登记** | 登记与处理结果的归属要明确（本设计见 §4.5 取舍） |
| Temporal 业务键即工作流 ID | 同 ID 重发=去重 | 键的粒度应是**业务键**（TB taskId），不是执行 id |
| 社区对 n8n static data 的批评 | 内存态/重置丢失，不宜做关键去重 | donger 直接用 **SQLite 持久表**，天然强于 static data |

## 3. 方案比选

| 方案 | 思路 | 评估 |
|---|---|---|
| A 运行级去重键 | 事件/触发载荷声明键字段，dispatcher 入队前查重 | 只适合「一次 firing=一个业务项」；监听是**单轮批量扫 N 任务**，键在轮内生成，运行级去重覆盖不到——否 |
| **B 处理登记工具（推荐）** | 平台表 + agent 轮内工具 `claim/query/release`，prompt 用工具判定 | 精确匹配批量扫描形态；原子认领防并发；DB 持久防丢失；对齐 n8n Remove Duplicates 的「平台能力+用户零脚本」理念——**采纳** |
| C 事件扇出拆分 | 扫描轮为每个候选拍子事件，每任务独立运行（运行级去重生效） | 架构最纯（Temporal 式），但需事件扇出/子运行编排，体量大；且每任务一运行的成本（LLM 起会话）高——后置演进方向，不阻塞 |

## 4. 详细设计（方案 B）

### 4.1 存储

新表 `workflow_dedup_keys`：

```sql
CREATE TABLE IF NOT EXISTS workflow_dedup_keys (
  workflowId TEXT NOT NULL,
  dedupKey   TEXT NOT NULL,              -- 业务键（如 TB taskId）
  runId      TEXT NOT NULL,              -- 认领归属轮
  status     TEXT NOT NULL DEFAULT 'claimed',  -- claimed | released
  note       TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  PRIMARY KEY (workflowId, dedupKey)
);
```

端口 `WorkflowDedupStore`：

```ts
claim(workflowId, dedupKey, runId, note?): Promise<{ claimed: boolean; existing?: DedupEntry }>;
// INSERT OR IGNORE 原子认领：true=首次（本轮应处理）；false=已被认领（返回既有条目）
get(workflowId, dedupKey): Promise<DedupEntry | undefined>;
release(workflowId, dedupKey, note?): Promise<boolean>;   // status→released（可再认领）
list(workflowId, opts?): Promise<DedupEntry[]>;           // 管理面/详情页
```

### 4.2 工作流配置与工具挂载

- `WorkflowSchema += dedup: z.object({ enabled: z.boolean() }).optional()`（缺省关闭，存量零迁移）；
- 挂载模式对齐反馈闭环 M1（feedbackCorrelation → donger-feedback 工具）：
  dispatcher `execute`/`executeNotifyRun` 在 `wf.dedup?.enabled` 时给 `IncomingMessage` 附 `dedupWorkflowId: wf.id` → orchestrator 轮内挂载内置工具 **`workflow-dedup`**（admin 式内置工具，非 MCP）：
  - `workflow_dedup_claim({ key, note? })` → `{ claimed, existing? }`
  - `workflow_dedup_query({ key })` → `{ claimed, status, runId, createdAt }`
  - `workflow_dedup_release({ key, note? })` → `{ ok }`
- 会话权限模式不隔离该工具（仅随 dedup.enabled 工作流轮挂载，作用域限定 workflowId，天然防跨工作流越权）。

### 4.3 语义与取舍（需拍板）

| 决策 | 选项 | 建议 |
|---|---|---|
| D-A 认领时点 | **处理前认领**（防并发双写）vs 处理后登记（防「认领后崩溃丢失分析」） | **处理前认领**：严格一次优先；崩溃卡键由 release 兜底 |
| D-B 失败语义 | 认领后轮失败：**保持 claimed**（严格一次）vs 自动释放（至少一次） | **保持 claimed**：符合「只分析一次」；工作流详情页提供人工释放 |
| D-C TTL | 无自动过期 vs N 天后可重认领 | 无自动过期（语义干净）；后续按需加 |
| D-D 与【AI助理回复】标记关系 | 替代 vs 并存 | **并存**：登记=机器幂等真源；标记=人可见回复标识（双保险，标记被删不影响幂等） |

### 4.4 监听工作流改造

prompt 从「查评论标记判定」改为：

```
对每个候选任务：
1. workflow_dedup_claim({ key: "<taskId>" }) —— claimed=false 说明已被处理/认领，跳过；
2. claimed=true → 查动态（@ 判定）→ bug 分析 → 写【AI助理回复】评论；
3. 分析失败（工具报错/信息不可得）→ workflow_dedup_release 释放，下轮可重试。
```

【AI助理回复】开头要求保留（人读标识不变）。

### 4.5 UI

- 工作流编辑页：「处理登记（幂等）」开关（dedup.enabled）；
- 工作流详情页：「登记」区块——键/状态/认领轮/时间列表 + 释放按钮（属主可见）。

### 4.6 与既有机制的关系

| 机制 | 关系 |
|---|---|
| EventFiring（触发记录） | 不变——firing 记「触发了」，dedup 记「业务项处理过」，正交 |
| 【AI助理回复】标记 | 并存（人读标识），非幂等真源 |
| Inbox Pattern 差距 | 登记与评论副作用非同事务；失败窗口=认领后崩溃，靠 release/管理面兜底（D-B 已拍板语义下可接受） |

## 5. 测试计划

- store 单测：原子认领（同键双 claim 仅一胜）、release 后可重认领、list 分页；
- 挂载单测：dedup.enabled 开/关 → 工具挂载与不挂载；非本工作流轮不可见；
- e2e：同一 TB 任务两条件两轮 → 仅一次分析；release 后重认领。

## 6. 分期

| 期 | 内容 |
|---|---|
| M1 | 存储+端口+工具+挂载+工作流开关（后端全链）+单测；监听工作流 prompt 切换 claim 语义 |
| M2 | 工作流详情「登记」管理面（列表/释放/检索）+编辑页开关 UI |
| M3（后置） | 事件扇出拆分（方案 C 演进）；TTL 过期策略 |

## 7. 验收清单

1. 同一 TB 任务先后命中执行者/参与人/@ 三条件、跨两轮 → 分析评论**仅一条**；
2. 并发两轮同任务 → claim 仅一轮获胜；
3. dedup.enabled=false 的工作流 → 工具不挂载、行为与现状一致；
4. 登记释放后 → 任务可重新分析；
5. 监听轮 prompt 不再依赖评论标记做幂等判定。
