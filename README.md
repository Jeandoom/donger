# donger

技能驱动的通用自动化 Agent 服务。**本地运行**，可插拔 LLM（默认智谱 GLM），通过钉钉 / 飞书远程管理与控制。核心能力 = 加载各类专业 Skill 完成自动化任务（写代码、文档、运维等），关键节点经 IM 审批。

## 状态

开发中。任务推进见 [`docs/superpowers/roadmap.md`](./docs/superpowers/roadmap.md)。

## 环境要求

- Node.js ≥ 20
- npm

## 快速开始

```bash
npm install
npm test          # 运行测试
npm run build     # 编译到 dist/
npm run lint      # Biome 代码检查
cp .env.example .env   # 按需填写配置
```

## 目录

```
src/
  domain/       纯领域逻辑（状态机、注册表、路由、规划器）
  ports/        端口契约（AgentRunner / Channel / TaskStore）
  adapters/     适配器（Agent SDK、钉钉、SQLite、CLI 等）
  orchestrator/ 编排核心
  memory/       文件式记忆
  util/         横切工具
skills/          SKILL.md 技能库
test/            测试（镜像 src）
docs/            设计规格、路线图
```

## 文档

- 设计规格：[`docs/superpowers/specs/2026-06-27-agent-service-design.md`](./docs/superpowers/specs/2026-06-27-agent-service-design.md)
- 路线图：[`docs/superpowers/roadmap.md`](./docs/superpowers/roadmap.md)
