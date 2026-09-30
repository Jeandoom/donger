---
name: deploy-operator
description: 对登记主机上的服务做部署与运维：发布新版本（拉代码→跑部署脚本→健康检查→失败排障）、诊断异常（磁盘/日志/CPU）、自愈动作（日志截断/服务重启）。当用户要求"部署/发布/上线某服务"、"看下那台机器的日志/磁盘/CPU"、"重启服务"时使用。
---

# 部署运维操作规程（deploy-operator）

你（agent）通过 `donger-host` 工具集操作**已登记的主机**。核心原则：

- **部署逻辑在仓库里，不在平台里**——先读仓库的部署方式（deploy.sh / Makefile / docker-compose.yml / README），再经 `host_exec` 执行，不凭空构造部署命令。
- **写操作一律走审批**：`host_exec` / `host_logs_clean` 每次都会弹审批卡，命令内容会完整展示给审批人——**构造命令时保持一行、可读、完整展示意图**（如 `cd /srv/app && git pull origin master && sudo systemctl restart stock`）。
- 只读诊断（`host_status` / `host_disk_usage` / `host_process_top` / `host_logs_tail`）免审批，可自由使用。

## 标准部署流程（SOP）

1. **定位资产**：`hosts_list` 找到目标主机；仓库信息从用户给的仓库 URL / 绑定的 git 仓库获取。
2. **了解部署方式**（按优先级）：
   - 仓库根的 `deploy.sh` / `Makefile`（看 `deploy` target）→ 首选执行入口；
   - `docker-compose.yml` → `docker compose up -d --build`；
   - 都没有 → 从服务进程形态推断（systemd unit / pm2 / 裸进程），先 `host_exec` 跑 `systemctl status <svc>` 确认再操作。
3. **确认当前状态**（部署前基线）：`host_status` + 服务的健康端点（curl）。
4. **执行部署**：`host_exec` 一行命令完成"拉代码→构建/重启"（或分步执行，重大变更分步更稳）。
5. **健康检查**：`host_exec` curl 健康端点（或 `host_status` 看进程）；服务日志 `host_logs_tail` 确认无异常。
6. **失败排障**（这是你区别于传统 CD 的价值）：看服务日志 tail → 定位报错 → 能修则修（回滚 `git checkout <上一个 tag>` 重启 / 改回配置）→ 不能修则**带着诊断结论报告**（错误摘要+根因分析+建议），不要盲目重试。
7. **汇报**：部署了什么（ref/sha）、执行了哪些命令、健康检查结果、遗留风险。

## 运维场景

- **磁盘告警**：`host_disk_usage` → 找大文件（`host_exec`: `du -sh /var/log/* | sort -rh | head`）→ 日志类先 `host_logs_clean` 截断（审批）→ 报告根因（是否缺轮转配置，给出 logrotate/journald 限额建议）。
- **CPU 打满**：`host_process_top` → 定位进程 → tail 其日志判断（正常高峰/死循环/重查询）→ 建议（限流/重启/扩容），重启前确认。
- **服务异常**：`host_logs_tail` 看最近日志 → `host_exec` 查服务状态 → 重启（审批）→ 验证恢复。

## 红线

- 不执行破坏数据的命令（rm 数据目录 / drop database / 格式化）；磁盘清理只截断日志文件。
- 不修改防火墙/SSH 配置/用户权限。
- 重启数据库类服务（ClickHouse/MySQL）前必须向用户说明影响并确认。
- 数据库服务器上的清理动作：只动日志与临时文件。
- 命令需要 root 时要求主机已配受限 sudoers（NOPASSWD 具体命令）；不支持交互式命令（无 tty）。

## 定制指南（agent 协助创建变体）

本技能是通用 SOP。为特定服务定制时，把以下信息固化进技能变体（在对话中让工坊/创作型智能体以本技能为模板创建，或让用户在技能页编辑）：

- `部署入口`：该服务仓库的部署命令（如 `cd /var/www/stock-analysis && git pull origin master && sudo systemctl restart stock`）
- `健康检查`：端点与期望输出（如 `curl -sf http://127.0.0.1:8200/docs`）
- `日志位置`：服务日志与相关组件日志路径（如 `/var/www/stock-analysis/logs/app.log`、`/var/log/clickhouse-server/`）
- `依赖组件`：数据库/缓存等及其启动方式、已知坑（如"ClickHouse 日志级别必须 warning，曾因 trace 级打满磁盘"）
- `回滚方式`：上一个 tag/分支与恢复命令

定制后把变体技能挂到对应智能体上，部署对话会自然引用其 SOP。
