# 贡献指南

感谢关注 donger！欢迎以任何形式参与：报 bug、提需求、改文档、交代码。

## 开发环境

```bash
npm install                  # 根 + web/ 子包一并安装
cp .env.example .env         # 至少填 LLM 接入（默认智谱 GLM 的 Anthropic 兼容端点）
npm run dev                  # 后端 tsx 热重载（默认 :3330）
npm run dev:web              # 前端 Vite dev（:3333，/api 反代后端）
```

国内网络建议先配 npm 镜像；better-sqlite3 有原生二进制，安装失败时设置
`npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3`。

## 提交前自测

CI 会在 push / PR 时跑完整链路，本地请先过一遍：

```bash
npm run lint                 # Biome（lint + format 二合一）
npm test                     # 后端全量测试
npm run build                # 后端构建
npm --prefix web run lint && npm --prefix web run test && npm --prefix web run build
npm --prefix cli run typecheck && npm --prefix cli run test
```

e2e 用例依赖真实运行环境，不进默认套件，需要时用 `npm run test:e2e` 单独跑。

## 分支与提交

- 从最新 `master` 切功能分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
- 提交信息用中文或英文均可，格式参考 `类型(范围): 描述`，如 `feat(web): ...`、`fix(git): ...`。
- 一个 PR 聚焦一件事；涉及行为的改动请附上测试。

## 报告问题

提交 issue 时请附上：复现步骤、期望/实际行为、环境（Node 版本、操作系统）、相关日志（**务必脱敏**，不要贴 token 与密钥）。

## 安全问题

安全漏洞**不要**走公开 issue，请参阅 [SECURITY.md](./SECURITY.md)。
