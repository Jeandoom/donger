# 发布 Webhook 事件驱动设计（gitee / GitHub / JihuLab）

> 2026-10-20 设计稿，待拍板。取代「Task Scheduler 每 5 分钟轮询」的触发层；执行层（host-release 管线）零改动。
> 前置讨论：同日弹窗诊断轮（`\donger-release-watcher` Interactive 弹 CMD）与 S4U 临时方案。

## 0. 一句话

三平台 push webhook 只做一件事——**唤醒** host 侧发布 agent；agent 醒来后自己 `git fetch origin master` 并沿用现有全部管线逻辑。webhook 是加速器，不是裁判。

## 1. 背景与动机

- 现状触发层：`\donger-release-watcher` 计划任务每 5 分钟 Interactive 跑 `donger-release-watcher.cmd` → Git Bash → `host-release-watcher.sh --once`。P50 触发延迟 ≈ 2.5 分钟，且 Interactive 档位产生 CMD 弹窗（当前问题的起点）。
- 仓库三远端实况（`git remote -v` 核实）：
  - `origin` = **github** `Jeandoom/donger` —— **生产真源**（watcher 现在就 fetch origin/master）
  - `gitee` = `renkee/donger` —— 镜像远端
  - `maycur` = jihulab `maycur-llm/maycur-agent-platform` —— 镜像远端
- 生产拓扑实况（compose.yaml 核实）：单服务 `app` 容器**进程内终结 HTTPS**（证书挂载，端口 3330），宿主无 nginx。app 即唯一公网面。
- 动机：push→发布从分钟级降到秒级；服务化结构性终结弹窗（S4U 临时补丁退役）；一次设计覆盖三个 git 平台。

## 2. 设计不变量存续核对

| 既有不变量（L2 spec §4.6） | 存续 | 说明 |
|---|---|---|
| master = 生产候选 | ✅ 保持 | 部署事实源仍是 agent 自行 fetch 的 `origin/master`，payload 的 SHA 仅作日志参考 |
| watcher 是唯一部署触发者 | ✅ **加强** | webhook 无法注入部署内容、无法指定 SHA、无法触发回滚——只能触发一次 fetch+比对 |
| 回滚不依赖 donger 存活 | ✅ 保持 | agent 是宿主独立进程；app 容器挂掉时轮询通道照常工作 |
| 零入站面（只出站 fetch+POST） | ⚠️ **修订** | 收窄为「**零新增主机监听面**」：唯一新增公网入口是 app 上一条签名校验路由；agent 本体零 socket（文件唤醒通道，见 D1）。该路由最大杀伤力 =「让生产立刻拉一次真 master」，而拉到的永远是仓库真内容——攻击者没有仓库写权限就永远无法借它注入代码 |
| 状态文件 + 连败 3 次放弃（防风暴） | ✅ 保持 | 幂等去重由 state 文件天然承担，三平台同 SHA 重复唤醒全部 no-op |

## 3. 核心原则：webhook 是加速器，不是裁判

三条推论：

1. **payload 只承载两个信息**：「我是合法来源」（签名）+「master 可能动了」（唤醒）。`after` SHA 只进日志不进决策。
2. **三平台 payload 差异被压缩为适配层**：每家约 20 行（验签方式 + 字段名），核心执行路径对三家完全一致。
3. **任何一环挂掉，系统退回今天的 5 分钟轮询形态**——不会更糟。轮询从「唯一触发方式」降级为「兜底对账」，这个降级正是整个设计的容错底座。

## 4. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ git 平台（gitee / github / jihulab）                        │
│   push master → POST webhook（各带平台签名）                 │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│ app 容器（唯一公网面，进程内 HTTPS，已有）                    │
│   POST /api/webhooks/release/:provider                      │
│   验签 → 限流 → 规范化 → 原子写唤醒文件                       │
└──────────────┬─────────────────────────────────────────────┘
               ▼  唤醒通道（推荐：bind mount 文件投递，零 socket）
┌────────────────────────────────────────────────────────────┐
│ host release-agent（宿主 session 0 服务，Node 常驻）         │
│   消费唤醒 ＋ 300s 兜底轮询 ──→ execute():                   │
│   spawn bash host-release-watcher.sh --once                 │
│     { windowsHide: true, timeout: 30min 硬顶 }              │
│   （mkdir 锁天然串行并发；state 文件幂等去重）                │
└──────────────┬─────────────────────────────────────────────┘
               ▼
      host-release.sh 管线（排水/演练槽/审批/回滚，零改动）
               ▼
      POST /api/internal/release-result 回报（零改动）
```

## 5. 组件设计

### 5.1 app 接收路由

- 新文件 `src/domain/release-webhook.ts`（三平台适配器 + 验签）；路由挂 `src/adapters/web-channel.ts`（与 `/api/internal/release-result` 同模式，`web-channel.ts:1394` 处分支），**必须登记 `src/adapters/web-route-guards.ts`**（新路由漏登记 = 404，既有铁律）。
- 路由：`POST /api/webhooks/release/:provider`，`provider ∈ gitee | github | jihulab`。

三平台验签与字段适配：

| 平台 | 签名头 | 校验方式 | 事件头 | 关键字段 | 备注 |
|---|---|---|---|---|---|
| gitee | `X-Gitee-Token` | 明文常量恒时比对（密码模式） | `X-Gitee-Event: Push Hook / Ping Hook` | `ref` / `after` | 签名模式（`X-Gitee-Signature` HMAC）作为加固项，算法按官方文档实现 |
| github | `X-Hub-Signature-256` | `HMAC-SHA256(secret, rawBody)` 恒时比对 | `X-GitHub-Event: push / ping` | `ref` / `after` / `deleted` | 无分支过滤能力 → 代码层过滤；`deleted=true` 或 `after` 全零丢弃 |
| jihulab | `X-Gitlab-Token` | 明文常量恒时比对 | `X-Gitlab-Event: Push Hook` | `ref` / `after` / `project.path_with_namespace` | 控制台原生支持 Push 事件 + Branch filter=master |

处理规则：

- 验签失败 → 403；ping/test 事件 → 200 不唤醒；非 `refs/heads/master` → 202 不唤醒。
- rawBody 先整体缓存（验签需要原始字节），上限 64KB，超限 413。
- 每 provider 限流（挂现有 `/hooks` 限流基础设施；**必须项**——秘钥泄露场景下限流是防 fetch 风暴的唯一闸门）。
- 验签通过后同步投递唤醒（2s 超时），投递失败仅记日志、照常返回 202（轮询兜底，不给平台制造重试风暴）。
- 配置：`DONGER_RELEASE_WEBHOOK_SECRET_GITEE / _GITHUB / _JIHULAB`（进 `src/config.ts` zod schema，与既有 `DONGER_RELEASE_HOOK_TOKEN` 同位同风格；空 = 该 provider 端点 503 关闭）。支持双密钥轮换窗口（OLD+NEW 同时接受，轮换期 403 归零）。

### 5.2 唤醒通道（D1，推荐文件投递）

**推荐方案：bind mount 文件投递。**

- compose 增挂载 `./release-wake:/release-wake`（rw）。
- app 原子写 `wake-<ts>-<provider>.json`：`{provider, event, ref, deliveryId, ts}`（temp+rename）。
- host agent `fs.watch` 目录 + 启动时扫描残留 + 消费即删 + 24h 兜底清理。

选它的理由（对回环 HTTP 的全面优势）：

1. **容器内 127.0.0.1 ≠ 宿主**——HTTP 方案必须引 `host.docker.internal` + agent 绑址 + Windows 防火墙规则 + 端口 + Bearer 令牌，五个新配置面；文件方案只有一个挂载目录。
2. **天然持久队列**：agent 忙碌或重启期间的唤醒不丢（文件还在），天然适配「部署中 app 重启导致 webhook 窗口丢失」。
3. **零新 socket、零新防火墙规则**——把「零入站面」精神保持到了回环层。
4. 内容只有唤醒信号，文件系统权限即访问控制。

备选：B2 = agent 绑 `0.0.0.0` 高位端口 + Windows 防火墙仅放行 Docker NAT 网段 + Bearer；B3 = `host.docker.internal` 直连（绑址坑同 B2）。

### 5.3 host release-agent

新文件 `scripts/release-agent.mjs`（宿主已装 Node，零新运行时依赖），由 Windows 服务常驻：

- **主循环**：`setInterval`（300s 兜底轮询）+ 唤醒监听，二者收敛到同一个 `execute()`：`spawn("C:\Program Files\Git\bin\bash.exe", [scripts/host-release-watcher.sh, --once], { windowsHide: true, timeout: 1_800_000 })`。
- **并发互斥不自建**：脚本内现有 `mkdir` 锁天然跨调用串行——唤醒撞上轮询进行中 = 锁跳过，免费获得。
- **必须补的缺口**：`--once` 形态的孤儿锁自愈依赖「下一轮」发现；常驻形态 `run_once` 卡死就没有下一轮——所以 spawn 必须带 30 分钟硬顶 kill（`timeout` 选项），kill 后下一轮触发时现有锁龄 >30min 自愈逻辑接管。**这一行是本轮设计对既有脚本体系的唯一补丁。**
- **可观测**：每次执行记录 `trigger=poll|wake:gitee|wake:github|wake:jihulab`，快速通道健康度直接可查。
- **自更新提醒**：agent 代码随部署更新但进程不换血——检测自身文件 mtime 变化打日志（M3 可升级为自动重启服务）。

服务宿主（D2）：

| 形态 | 优点 | 代价 |
|---|---|---|
| WinSW（单 exe + xml） | 完整重启策略（失败重试/延迟/日志轮转） | 引入一个外部依赖 |
| 计划任务「开机时启动」+ S4U | 零新依赖，复用既有运维心智 | 重启策略弱（失败重启次数有限） |

两种形态都跑在 session 0：**弹窗问题结构性终结，上轮 S4U 临时补丁与 `\donger-release-watcher` 计划任务、`donger-release-watcher.cmd` 一并退役。**

### 5.4 多远端语义（D4，推荐 origin 唯一真源）

- 维持 `origin`（github）master 为唯一生产真源；gitee/jihulab webhook 仅作唤醒。
- 三远端推同一 SHA 的常态下：先到的 webhook 先唤醒，fetch 后 state 命中即 no-op——**三平台重复推送的幂等去重是免费的**。
- 边界情形「只推了 gitee、origin 未推」：唤醒后 fetch 无前进 → 不部署——与今天轮询行为完全一致，语义零漂移。
- 否决 provider 感知 fetch（谁唤醒 fetch 谁）：会让「生产真源」变成竞速，破坏 master=生产候选不变量。

## 6. 三平台控制台接入配置

| 平台 | 路径 | 配置要点 | 自测手段 |
|---|---|---|---|
| gitee | 仓库管理 → WebHooks → 添加 | URL + 密码（密码模式起步）；事件勾选 Push | 「测试」按钮 |
| github | Settings → Webhooks → Add webhook | secret + `application/json`；仅 Push event（无分支过滤，代码层兜底） | Redeliver 重放 |
| jihulab | Settings → Webhooks | URL + Token；Push events + Branch filter `master` | Test → Push events |

每平台独立 secret；轮换 runbook = 上双密钥窗口 → 改平台 secret → 观察一个推送周期 → 摘旧密钥。

## 7. 安全分析

- 威胁面增量 = app 公开面上一条路由。其能力天花板：触发一次对真 origin/master 的 fetch。**不存在**「借 webhook 部署任意代码」的路径——代码内容永远来自仓库本身。
- 验签全部恒时比较；github 必须用 rawBody 做 HMAC（不能用再序列化的 JSON）。
- 重放攻击无害：state 文件幂等，重复唤醒 = no-op。
- 限流是必须项：秘钥泄露场景下，攻击面收敛为「制造 fetch 风暴」，mkdir 锁 + 每 provider 限流 + 连败 3 次放弃三层兜底。
- agent 无任何监听面（文件通道形态）；备选 HTTP 形态时 Bearer + 防火墙网段白名单双保险。
- 404 陷阱：路由必须登记 web-route-guards，e2e 覆盖。

## 8. 故障模式与兜底

| 故障 | 后果 | 兜底 | 发布延迟上限 |
|---|---|---|---|
| app 容器挂 / 正在重启 | webhook 丢失 | 平台重试 + 轮询兜底 + 唤醒文件持久队列 | 轮询间隔 |
| agent 挂 | 唤醒无人消费 | 服务重启策略 + 文件队列不丢 | 服务恢复时间 |
| git 平台 webhook 服务异常 | 无唤醒 | 轮询兜底 | 轮询间隔 |
| DDNS / NAT 断 | 轮询与 webhook 全断 | 与现状等价，无退化 | — |
| 三平台同 SHA 重复唤醒 | — | state 文件幂等 no-op | 0 |
| 发布进行中来唤醒 | — | mkdir 锁跳过 | 0 |
| 秘钥轮换错序 | 短时 403 | 双密钥窗口 + 平台重试 + 轮询兜底 | 轮询间隔 |

## 9. 分期落地

- **M0（可选）**：若 M1 未就绪而弹窗已不可忍，先打 S4U 临时补丁（前轮已给命令）；M1 落地后随计划任务一并退役。
- **M1 host agent 服务化**：`release-agent.mjs` + 文件唤醒通道骨架 + 服务安装 + 退役 `\donger-release-watcher` 计划任务与 cmd 包装。验收：手工投递唤醒文件 → 秒级触发一次 `--rehearsal-stack` 演练；轮询照常；服务重启后残留唤醒文件被消费；桌面无弹窗。
- **M2 app 路由 + 三平台接入**：路由 + 验签 + 限流 + `scripts/test-release-webhooks.mts`（三平台签名正反用例：错签 403 / 非 master 202 / ping 200 不唤醒 / 超限 413 / 路由守卫覆盖）。按 gitee → github → jihulab 顺序挂真实 webhook，观察一周 trigger 源分布。
- **M3 加固**：轮询间隔放宽拍板（D3）；wake→deploy 延迟指标；agent 自更新自动重启；秘钥轮换演练；kill-switch（`DONGER_RELEASE_WEBHOOK_DISABLED` → 路由 503）实测。

## 10. 决策点

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 唤醒通道 | 文件投递 / 回环 HTTP+防火墙 / host.docker.internal | **文件投递** |
| D2 | agent 服务宿主 | WinSW / 计划任务开机自启 S4U | WinSW（重启策略完整）；零依赖偏好则后者 |
| D3 | webhook 稳定后轮询间隔 | 保持 300s / 放宽 15-30min | 先保持 300s 一个季度再议 |
| D4 | 多远端语义 | origin 唯一真源其余仅唤醒 / provider 感知 fetch | **前者**（语义零漂移） |
| D5 | webhook 秘钥托管 | donger.env（与现有 RELEASE_HOOK_TOKEN 同位）/ module_configs DB 化 | donger.env（同生命周期同栈管理） |

## 11. e2e 验证

- `scripts/test-release-webhooks.mts`：本地起 app（dev 模式）构造三平台签名请求——github 正确 HMAC、gitee/jihulab token 头；正例断言唤醒文件落盘、反例断言 403/202/200-noop/413。
- 真机：各平台控制台测试按钮 → agent 日志出现 `trigger=wake:<provider>` → 演练槽全链路一次 → 生产推一个真实提交验证秒级发布。
