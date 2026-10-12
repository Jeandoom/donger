# 主机 SSH 执行权限策略化设计（host exec policy）

- 日期：2026-10-12
- 状态：已拍板（A①迁移合并 / B 默认 ask / C inherit / D 旁门 ask / E logs_clean 入策略）；**M1 已实施**（实施记录见 §11）
- 范围：donger-host 工具通道（正门）+ 本地 Bash ssh/scp 通道（旁门）的可配置权限治理
- 关联：2026-09-30-deploy-ops-loop-design §6（主机=凭证）、2026-10-10 host_exec 只读白名单轮、2026-10-11 插件系统（host-exec 模块）、2026-10-10 agent 安全内核 M1（双引擎守卫表）

---

## 1. 背景与生产实况（2026-10-12 核验）

生产真库（D:\deploy\donger\data\donger.db）核验数据：

| 项 | 值 |
|---|---|
| 主机凭证（kind=host） | 1 台：`ssh-homedb`（stock-analysis 部署机），1 用户（admin）已填值 |
| agent 白名单 | 9 个 agent 中仅 `stock-analysis-ops` 配置，25 条前缀（systemctl/journalctl/curl/ss/docker ps/cat/tail…） |
| donger-host 审计事件 | 108 条：host_exec 71、hosts_list 19、host_status 17、host_logs_tail 1 |
| 最近形态 | 2026-10-11 stock-analysis 部署运维：`git pull`、`sudo chown`、`mv`、`ls`、`cat`、`grep` 混合，非白名单命令连续弹审批卡人工逐条点 |

审批卡决策本身不落 audit_events（只有 tool_use/tool_result），治理面无集中视图。

## 2. 现状链路（双通道）

### 2.1 正门：donger-host MCP 工具集（src/orchestrator/host-tools.ts）

- 挂载：全局插件 `host-exec` 启用 ∧（viewer=admin ∨ 名下有已填值 host 凭证）。
- 只读诊断四工具（hosts_list/host_status/host_disk_usage/host_process_top/host_logs_tail）：固定命令模板+参数 regex 收口 → 免审批。
- 写操作两工具（host_exec/host_logs_clean）：`host-ops` force 门（default-gates.ts:47）→ 一律审批卡；full_access 不豁免；无人值守轮恒 ask_before_change（orchestrator.ts:1785）→ 审批无人处理=永久挂起。
- 唯一免审批通道：agent 级 `hostExecAllowlist` 前缀白名单（domain/host-exec-allowlist.ts 防逃逸纯函数）经 `gateAllowCheck` 钩子旁路（claude/zcode 双引擎已接线，runner 不解释语义）。
- 白名单前缀清单注入系统提示（orchestrator.ts:517-540），引导 LLM 在清单内组命令。

### 2.2 旁门：本地 Bash 通道的 ssh/scp（无治理）

`ssh user@host cmd`（无变量展开/替换/解释器特征）走 `classifyShellDecision` = `static-guard`；静态守卫表（shell-git/KB 写/要害路径读/写边界）均不识别 ssh；GateRouter 的 Bash 规则仅 deploy 关键词 → **无门命中 → 直接放行**（ask/full_access/无人值守三模式同样，因无门即免审）。唯一相关先例是 shell-git 守卫（恒拒非 https git 远程）。

即：donger-host 的全部治理，可被一条本地 Bash `ssh` 命令绕过（前提是平台宿主机 OS 层有可达凭证）。

## 3. 问题清单

| # | 问题 | 级别 |
|---|---|---|
| P1 | 粒度错位：白名单是 agent 属性，主机无策略。无法表达「同一条命令：测试机自动跑、生产机审批」 | 高 |
| P2 | 配置面错位：运维策略由 agent 属主在编辑器 textarea 手工维护，admin 无集中治理视图；审批中暴露的合理命令无法沉淀为策略 | 高 |
| P3 | 表达力不足：纯前缀限定不了参数域（如 `git pull` 限定 `/var/www/stock-analysis`）；写操作只能「全审批」或「全主机开放」两档 | 高 |
| P4 | 无人值守二值化：白名单外命令=审批卡永久挂起；无「跳过该步+通知」的降级档 | 高 |
| P5 | host_logs_clean（磁盘自愈）无任何免审配置通道，无人值守磁盘打满场景必然卡死 | 中 |
| P6 | Bash ssh/scp 旁门零治理，正门治理可被绕过 | P0 |
| P7 | 审批可解释性：命中策略与否、谁批的、按哪条规则放行，审计不可见 | 中 |

## 4. 设计目标与原则

1. **架构优先**：主机凭证已是资产（kind=host），门+审计已有骨架；缺的只是把「主机执行策略」立为平台资产层的可配置对象，而不是再造一个子系统（复用既有抽象反馈）。
2. **fail-closed**：策略查询异常/无命中 → 回审批门（=现状），引擎侧永不 fail-open。
3. **决策即时生效**：策略每次调用现取（对齐 permissionMode getter 先例），改策略不重启。
4. **值不进 prompt**：策略只含命令形态与决策，不含密钥/主机值（对齐 host-tools v3 不变量）。
5. **门不动**：host-ops force 门保留，作为 ask 决策的执行体与审批卡载体；策略引擎只负责「免审放行 / 显式拒绝」的判定。

## 5. 核心抽象：主机执行策略（host_exec_policies）

### 5.1 数据模型（新表）

```
host_exec_policies
  id          TEXT PK
  hostCode    TEXT NOT NULL        -- 凭证 code（kind=host）；'*' = 全部主机
  scopeKind   TEXT NOT NULL        -- 'global' | 'agent' | 'user' | 'role'
  scopeRef    TEXT                 -- agent id / user id / role；global 为 NULL
  matchKind   TEXT NOT NULL        -- 'prefix' | 'pattern'（'class' 预留）
  matchValue  TEXT NOT NULL        -- prefix: 换行分隔前缀集；pattern: 受控正则
  decision    TEXT NOT NULL        -- 'allow' | 'ask' | 'deny'
  unattended  TEXT NOT NULL DEFAULT 'inherit'   -- 'inherit' | 'allow' | 'skip'
  note        TEXT
  enabled     INTEGER NOT NULL DEFAULT 1
  createdBy / createdAt / updatedAt
```

- `matchKind=prefix`：复用现防逃逸判定口径（命令替换/进程替换/输出重定向全拒，`>/dev/null` 豁免，组合段逐段命中）——把「agent 级单清单」泛化为「按规则集判定」。
- `matchKind=pattern`：admin 高级项；受控正则（长度上限+编译失败拒收+锚定建议），用于 `git -C /var/www/stock-analysis pull --ff-only` 这类参数域收窄。
- `unattended`：仅无人值守轮（unattended=true）生效；`inherit`=与 decision 一致；`skip`=记审计后跳过该工具调用（返回明确提示），防工作流永久挂起。
- `host_logs_clean` 入同一策略：按 hostCode+工具名粒度 allow（它已是固定模板，无自由命令面），磁盘自愈可全自动。

### 5.2 决策引擎（纯函数+查询器）

解析顺序（首条命中生效）：

1. **deny 黑名单先行**：enabled 的 deny 规则（pattern：`mkfs`、`dd if=`、`shutdown`、`reboot`、`rm -rf /` 等）→ deny，先于一切 allow（含 global scope 的 allow）。
2. host 维度：`hostCode` 精确 > `'*'`。
3. scope 维度（同主机内）：`user` > `agent` > `role` > `global`。
4. 无命中 → **ask**（=现状 force 门默认，零迁移风险，默认档收紧与否见决策点 B）。
5. allow 命中 ∧ 无人值守轮 → 按条目 `unattended` 字段裁决。

查询器签名（orchestrator 装配处消费）：

```ts
checkHostExec(input: { hostCode: string; command: string; toolName: string },
              ctx: { agentId?: string; user: { id: string; role: string }; unattended: boolean },
            ): Promise<{ decision: "allow" | "skip"; policyId: string } | undefined>
```

返回 undefined = 回审批门。引擎侧异常按 undefined 处理（fail-closed）。

## 6. 接线与改动面

| 位置 | 改动 |
|---|---|
| `orchestrator.ts:556` gateAllowCheck 闭包 | 从「agent 白名单纯函数」换芯为策略查询器（hostCode 取 `input.hostCode`）；钩子签名不变 → **双引擎（claude/zcode）零改动** |
| `orchestrator.ts:517-540` 系统提示注入 | 白名单节改为按 host 分组注入生效 allow 前缀（现取策略引擎），文案模板不变 |
| `tool-call-guards.ts`（双引擎共享守卫表） | 新增 deny 通道：deny 命中 → 工具调用直接拒绝，报错文案含策略 id（M2） |
| `default-gates.ts` | 不动（host-ops 门保留为 ask 执行体） |
| `domain/host-exec-allowlist.ts` | 纯函数保留，被策略判定器复用；判定范围从单清单扩展为规则集遍历 |
| 审计 | tool_use 行附加策略裁决标记（`policy:allow:<id>` / `policy:ask` / `policy:deny:<id>`），落点实现时定（text 前缀或 toolOutput 元数据） |
| 插件 manifest | host-exec 的 `contributes.agentConfigFields` 视决策点 A 调整 |

## 7. 旁门治理（Bash ssh/scp 出站，P6）

- 新静态守卫 `ssh-egress`（tool-call-guards.ts，双引擎共享）：识别命令位的 `ssh`/`scp`/`sftp`/`sshpass`。
- 决策档位可配置（app_config 平台级）：
  - `ask`（**默认**）：ssh 系命令强制进审批链（合成 gateId `ssh-egress`，审批卡展示完整命令）——零风险起步；
  - `registered-hosts-align`：远端 ∈ 已登记主机凭证端点（按当前用户已填值解析）且该主机策略 allow 时放行，否则审批——与正门同源治理；
  - `deny`：恒拒（最严租户可用）。
- 与 shell-git 守卫同构（守卫先行的字符串判定，不依赖门规则）；agent 级豁免开关暂不开放（先例：gitAllowShellGit），留 M3 再议。

## 8. UI 与迁移

### 8.1 UI

- **凭证页 host 行卡**：展开「执行策略」区块——规则列表（匹配/决策/生效域/无人值守/备注/启停）+ 增删改；admin-only 编辑，普通用户只读展示（agent 行为透明）。
- **agent 编辑器**：原白名单 textarea 按决策点 A 处理（推荐：只读展示「已迁移至主机策略」+凭证页跳转）。
- **审批卡增强（M2）**：卡面显示未命中原因；「以后此类命令自动执行」按钮——按本条命令首 token 生成前缀规则草稿（hostCode+当前 agent scope 预填），确认后写策略表。审批卡从「放行/拒绝」升级为策略学习入口，是运维体验闭环的关键。

### 8.2 迁移

1. 存量：`stock-analysis-ops` 的 25 条前缀 → 一条规则（scopeKind=agent, scopeRef=该 agent, hostCode=ssh-homedb, matchKind=prefix, decision=allow）；幂等迁移脚本。
2. `hostExecAllowlist` 字段读兼容一个版本（策略表优先，字段兜底），下版移除；host-exec manifest contributes 同步退役。

### 8.3 里程碑

- **M1（引擎面）**：策略表+判定器+gateAllowCheck 换芯+提示注入换源+审计打标+存量迁移；UI 免（API/DB 可管）。验收：判定器单测（防逃逸全型）+ 双引擎 e2e（allow 免审/无命中审批/无人值守）。
- **M2（治理面）**：凭证页策略 UI+审批卡成策略按钮+deny 黑名单默认集+ssh-egress 守卫。
- **M3（体验面）**：无人值守 skip+通知降级、策略模板（「标准只读诊断集」一键套用）、审批决策落审计、agent 级豁免开关再议。

## 9. 决策点（待拍板）

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| A | agent 白名单与主机策略关系 | ① 迁移合并，策略表单一真源；② 双轨并存取更严 | ① |
| B | 无命中默认档 | ask（=现状）；deny（收紧） | ask（零迁移风险，deny 黑名单已覆盖最险命令） |
| C | allow 条目无人值守语义 | inherit（跟随 decision）；一律 ask | inherit（运维轮全自动是既成事实） |
| D | Bash ssh 旁门默认档 | ask；deny；registered-hosts-align | ask |
| E | host_logs_clean 是否入策略 | 入；维持恒审批 | 入（磁盘自愈无人值守场景的硬需求） |

## 10. 安全不变量（复核清单）

- prefix 判定保留全部防逃逸结构检查（替换/进程替换/重定向），规则化不放松口径；
- deny 先于 allow，global allow 不能覆盖主机级 deny；
- 策略编辑 admin-only；审计含 policyId 可追溯；
- 策略引擎异常 = 回审批门（fail-closed）；判定即时现取，改策略无需重启；
- 命令/凭证值不进 prompt 与审计明文（对齐既有不变量）。

## 11. M1 实施记录（2026-10-12）

落点：`src/domain/host-exec-policy.ts`（判定器+Schema）、`src/ports/host-exec-policy-store.ts`、
`src/adapters/sqlite-host-exec-policy-store.ts`（host_exec_policies 表）、
`src/adapters/host-exec-policy-migration.ts`（存量迁移，app_config 标记位 `host_exec_policy.legacy_allowlist_migrated_at`
幂等防复活）、orchestrator `runTurn`（gateAllowCheck 换芯+提示注入按主机分组+`policy_decision` 审计打标）、
admin API 五条（web-channel+守卫表登记）、agent 编辑器白名单 textarea 换迁移说明、host-exec manifest 1.1.0（contributes 退役）。

与设计稿的差异（实施裁决）：

1. **deny/skip M1 未接线**：管理面 Schema 收窄为 decision∈{allow,ask}、unattended∈{inherit,allow}，
   配置面与实际行为严格一致（deny 守卫 M2、skip 接线 M3 后放开枚举）；判定器已实现全语义，放开即生效。
2. **策略读取为轮级快照**（runTurn 起取一次）：与 agent 配置同语义，策略改动下一轮生效；
   严格逐调用现取与 deny 守卫（M2）一起做。
3. **数据模型加 `tool` 列**（'*' | host_exec | host_logs_clean）：§5.1 未列，E 拍板（logs_clean 入策略）
   需要工具维度；logs_clean 规则不判定命令内容，按主机×生效域粒度生效。
4. **store 未装配=回落 agent 白名单旧行为**（合成等价规则），部署过渡期安全网；生产 index.ts 已装配。
5. 审计打标=新事件类型 `policy_decision`（seq=-1 执行外事件，fire-and-forget，ask/deny 不打标）。

测试：判定器 12 用例（deny 先行/主机×scope 特异度/tool 过滤/无人值守档/防逃逸复用/Schema 收窄）、
store+迁移 5 用例（幂等/防复活/等价性）；全量后端 1583 绿 + tsc + web build 绿。
