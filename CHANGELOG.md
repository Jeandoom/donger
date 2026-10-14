# Changelog

本文件记录面向使用者的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

- **会话级 git worktree 隔离**：智能体绑定的仓库物化为每会话独立 worktree（分支 `donger-session/<会话ID>`，基于最新主分支），同智能体并行会话不再共享工作树，互不踩踏分支与未提交改动；主克隆降级为同步基座，由平台负责 fetch/快进。归档或闲置超 7 天的会话 worktree 由后台清道夫回收（有未提交工作/未合并分支时自动保留）。`GIT_SESSION_WORKTREE=false` 回退旧的共享目录模式。

## [0.1.0] - 2026-09-28

首个开源公开版本。核心能力：

- **三端接入**：钉钉通道（Stream 模式 + AI 卡片流式回复）、Web 控制台（HTTP + SSE，PWA）、CLI。
- **具名智能体（Agent）**：技能白名单、权限模式（含 Full access）、LLM 与仓库绑定，可视化编辑器。
- **审批门**：高危操作推卡人工确认（IM / Web），durable gate 持久化、重启不丢。
- **技能系统**：SKILL.md 技能包管理与安装、内置技能、技能仓库 Git 同步。
- **自动化**：触发器、多步工作流、循环、定时调度。
- **LLM 多供应商**：供应商/模型管理，Agent 级与会话级选模型（默认智谱 GLM）。
- **知识库（KB）**：多库管理、FTS5 检索、会话内按需挂载。
- **Git 平台集成**：GitHub / Gitee / GitLab 凭证绑定与工具化 git 操作、worktree 隔离。
- **连接器与凭证集**：外部系统集成、凭证加密存储与共享解析。
- **多用户与账号**：邮箱邀请注册、钉钉扫码 / GitHub OAuth / 邮箱登录。
- **可观测**：审计事件、LLM 观测、用量统计、文件浏览器。
- **MCP**：系统能力以 Streamable HTTP MCP 端点暴露，支持个人接入令牌。
