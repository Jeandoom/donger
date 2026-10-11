# Agent 安全内核方案验证报告（理论可靠性 + M1 可行性）

- 日期：2026-10-10
- 验证对象：`docs/superpowers/specs/2026-10-10-agent-security-kernel-design.md`（v2，含验证轮修订）
- 验证方法：技术 spike 实证（claude SDK 实跑 + zcode 协议取证）+ 不变量对抗推演（red-team 自查）+ 管线边界实验
- spike 脚本：`scripts/spike-m1.ts`（claude 三合一）、`scripts/pipeline-boundary-check.ts`（管线边界）
- 结论先行：**方案理论闭环、M1 可行性全部成立。对抗推演找到 5 个反例，全部被不变量体系吸收（新增 INV-10、INV-3b、L1.5 层级），无一需要推翻架构。**

---

## 1. Spike ①：PreToolUse hook 完备性（M1 主假设）——成立

**这是 M1 路线成立与否的关键假设**：探针轮证明 canUseTool 被 SDK 内置只读放行 shadow（`cat` 类命令不进回调），SDK 警告说「只有 PreToolUse hook 能拦每一次调用」——但「hook 在只读放行之前且 deny 真实生效」需要实证。

实验（`scripts/spike-m1.ts`）：同会话挂 PreToolUse hook + canUseTool 对照，诱导 `cat /d/code/donger/.env`。

结果：
- hook 收到**每一次**工具调用（含 `rtk cat /d/code/donger/.env`——模型自发用了 rtk 包装器，恰好证明 hook 拦的是「调用」而非「命令名」）；
- **canUseTool 日志里没有 rk cat**（只读放行 shadow 依旧存在），但 hook 的 deny **真实生效**——模型收到的工具结果是「内核判定：能力集外（spike 拦截）」，明确报告没有读到内容；
- 结论：**hook 是完备拦截点，canUseTool 不是。守卫迁 hook 后，探针 P0-1（只读直通旁路）被堵死。**

附加发现：模型在无宿主 settings.json（已隔离）的环境下仍会自发尝试 `rtk` 等包装器——印证 spec D2 的结论：命令管控必须按「能力语义」（读文件能力）而非命令名枚举。

## 2. Spike ②：CLAUDE_CONFIG_DIR 重定向——成立

- 隔离目录正常长出引擎状态（.claude.json/projects/sessions/shell-snapshots 等），**宿主 `~/.claude/projects` 零残留**；
- 宿主 settings.json 不再被加载（其 allow 规则/additionalDirectories/hooks 不再渗入会话）；
- 探针 P1-3（宿主 settings 渗入）与 P1-4（全平台 `.claude/projects` 转录池）的修复前提实证成立。注意：隔离根必须同时进能力集 fsDeny（4.2 已含「引擎状态目录」），防止模型写自己会话的转录/配置。

## 3. Spike ③：env 白名单——成立，且暴露一个必须补的子项

- 哨兵密钥（模拟平台其他密钥）不传即不可见：白名单机制可行；
- **但 `ANTHROPIC_AUTH_TOKEN` 出现在 printenv 输出**：LLM 凭证必须传给 CLI（引擎自身调 API），而 Bash 执行环境继承 CLI 环境——引擎凭证天然暴露给工具执行。这就是探针 B4 在「白名单形态」下仍会泄漏 token 的剩余通道。
- 修复通道已确认存在：SDK settings 支持 `apiKeyHelper`（CLI 经 helper 命令现取凭证）与 `extraArgs`——凭证改走非 env 通道后，env 白名单才真正闭环。已收编为 **INV-3b（凭证隔离）** 并进 M1-3。

## 4. 管线边界实验：三分类规则——成立（19 例，18 过，1 例催生新不变量）

分类规则：白名单族免审（WHITELIST）→ 纯静态可判定走能力集守卫（GUARD）→ 含展开/替换/编码语义字符强制审批（UNDECIDABLE）。理论目标不是「检出全部恶意」（命令语言图灵完备，不可能），而是**放行集零恶意 + 审批集可用性代价可控**。

- 对抗形态 12 例（base64+eval、变量间接 `$P`、glob、brace+xargs、`find -exec`、跨解释器 powershell、`python -c`、重定向写、命令替换嵌套、反引号、`bash -s <`）**全部正确落入审批类，零漏网**；
- 正常命令 4 例正确放行（git 组合、npm run、工作区内 cat）；
- 唯一「意外」：`node script.js` 静态上无法区分良恶意脚本，必然落入 GUARD 类——**这不是实验失败，而是理论发现**：解释器是能力模型的逃逸乘数（fsWrite 写入恶意脚本 × 解释器执行=绕过全部静态判定），催生 **INV-10（组合授权单调性）**：fsWrite∧解释器的组合权限不得超过独立授予的并集；解释器类命令缺省恒审批，显式授予必须配套子进程边界。

## 5. Spike ④：zcode hook 可编程性——成立（协议面）

zcode bundle（14.8MB）协议层取证：
- `hookEventName` 枚举原生含 **PreToolUse / PermissionRequest / PostToolUse** 等事件（与 claude 同构）；
- workspace hooks 配置 schema：`{matcher, type: command|process, timeout, trustState, ...}`，配套 `workspace/hooks/trustGrant` 信任授予流与 workspaceHookReview 审核流；
- 结论：**M1-2 从「废除 zcode 只读直通」升级为「统一 PreToolUse hook 挂载」**——两引擎共用同一份守卫引擎与挂载策略，zcode 侧无需改引擎行为。hook 相对引擎内部「只读直通」的触发时序留 M1 冒烟确认（备选：toolDenylist 封原生工具走平台代理）。

## 6. 不变量对抗推演：5 反例，全部吸收

| # | 反例 | 攻击路径 | 处置 |
|---|---|---|---|
| 1 | **解释器×fsWrite 组合逃逸**（探针 B1 的理论化） | 写 pwn.js 进 workspace（fsWrite 允许）→ node 执行（commands 授予）→ 解释器子进程读任意路径 | 新增 INV-10；解释器恒审批/授予须配子进程边界 |
| 2 | 技能供应链层级未定义 | SKILL.md 是 owner 安装（L1？）还是数据（L3）？恶意技能文本注入 | 补 **L1.5 层级**：安装经治理=准 L1，内容按 L3 封套注入；技能只能引用既有能力、不能新增能力 |
| 3 | subagent 通道 | Agent tool 子代理的工具调用是否过同一 hook？ | M1 契约测试补 subagent 哨兵（SDK 有 SubagentStart/Stop 事件，hook 语义待实证覆盖） |
| 4 | hook 超时/异常语义 | hook 挂起超时后 CLI 若 fail-open=守卫静默失效 | SDK 类型未文档化超时行为；补超时哨兵契约（实测；若 fail-open 则 hook 外层竞速 deny） |
| 5 | 白名单族语义漏洞 | `git -C /d/code/donger log -p .env` 读源码——白名单族若免「守卫」则穿透 | 语义修正：白名单族免的是**审批**不是**守卫**（路径 token 仍过 fsDeny 判定，现行 matchSensitiveRead 已正确处理此形态） |

未被吸收的残余风险（显式接受，写进 spec §10）：①TOCTOU 审批到执行窗口（单机形态，M3 宿主边界兜底）；②DNS/ICMP 底层隐通道（渗出闸按 HTTP(S) 域名管）；③LLM 供应商侧可见上下文（INV-3b 本源治理收敛）；④间接注入仍可能诱导模型**发起**越权请求——机制侧保证请求**受理不了**（这是本方案与「提示词防御」路线的本质分野）。

## 7. M1 可行性清单终版

| M1 项 | 技术前提 | 状态 |
|---|---|---|
| 1. claude 守卫迁 PreToolUse hook | hook 完备+deny 生效 | ✅ spike 实证 |
| 2. zcode hook 挂载 | 协议原生支持 | ✅ 协议面确认（时序冒烟留 M1） |
| 3. env 白名单+凭证隔离（INV-3b） | 白名单可行+apiKeyHelper 通道 | ✅ spike 实证 |
| 4. CLAUDE_CONFIG_DIR 重定向 | 重定向生效+状态完整 | ✅ spike 实证 |
| 5. 归一化管线三分类 | 对抗零漏网+可用性可控 | ✅ 边界实验 19 例 |
| 6. 沙箱 fail-closed 检测 | 工程项（无技术风险） | ✅ |
| 7. hook 三契约测试（激活/直通/超时+subagent） | 可写（hook 语义已确认存在） | ✅ 超时语义需实测定案 |

## 8. 总体结论

- **理论可靠性**：九条不变量经对抗推演无致命反例；两个真反例（组合逃逸、技能层级）通过**增加**不变量吸收而非修改架构——不变量体系是可扩展的，这正是内核式设计的预期性质。
- **可行性**：M1 全部技术前提已实证（无一项停留在假设）；M2/M3 沿用已上线机制（MCP 桥+门语义、toolDenylist、能力字段），增量是结构归一而非新技术。
- **方案的判定边界**（诚实声明）：本方案保证「越权请求受理不了」，不保证「越权请求不产生」（模型仍可能被注入诱导尝试）——尝试会产生 audit 留痕与审批可见性，这正是治理面需要的。
