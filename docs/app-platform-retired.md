# 应用平台方案永久作废

**状态：永久作废（2026-10-08 拍板），不再重启。**

平台内应用托管（含沙箱运行时、应用分享、应用管家、app-proxy 凭证通道）已整体移除。
「服务端应用」的交付形态改走 **方案 B：GitOps 外接** —— 应用即外部 Git 仓库，部署由
部署运维闭环（donger-host 主机资产 + SSH 受限工具集 + git 触发器）承载；平台只拥有
资产、通道与治理，不托管应用运行时。

## 时间线

- 2026-09-25 可行性分析与架构设计（原始 spec `docs/superpowers/specs/2026-09-25-app-platform-architecture.md`，
  开源清洗时已移出公开仓，全文备份于 `D:\code\donger-oss-backup\docs-superpowers\`）。
- 2026-09-25 ~ 09-28 M1 内核（Manifest + AppGateway + RT-A~E 运行时）+ M2 开发链路 +
  闭环收敛 + 应用分享四档 + 应用管家 + app-proxy 凭证通道化，先后上线
  （git 区间 a540654…2bddd67）。
- 2026-09-30 **整体移除**（187f4f7）：33 文件删除、四表休眠、bundle tar 归档。
- 2026-10-08 拍板：方案**永久作废**。

## 历史回捞

- 代码：git 历史 `a540654…dfe9a54`（应用内核/分享）、`2bddd67`（app-proxy 凭证通道绑定）。
- 数据库：`apps` 等四表处于休眠（保留未删）；**不得复用这些表名建新表**。
- 设计稿：见上方备份目录与 `docs/superpowers/specs/` 内两份已标注作废的 spec
  （2026-09-28-agent-app-stewardship-design、2026-09-29-app-proxy-credential-binding-design）。
- `src/config.ts` 中「历史 app-proxy 已随应用模块移除」注释为有意保留的口径说明。

## 相关原则（仍然有效）

- 容器化红线「容器化前不跑用户代码」随本方案一并关闭——平台不再承载用户代码执行面。
- 新需求先问能否实例化已有抽象（资产 / 技能 / 触发器 / Loop / 审计），勿在平台内平行造应用子系统。
