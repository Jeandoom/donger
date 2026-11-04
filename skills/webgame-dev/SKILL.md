---
name: webgame-dev
description: 在 donger 平台内做网站/游戏开发的闭环方法论：脚手架 → 平台托管 dev server（dev_start）→ playwright 浏览器 e2e 截图留证 → git 提交推送 → 交付平台内预览地址。适用于绑定了 git 仓库且开启「会话预览」的智能体开发网页/Web 游戏项目。
---

# 网站/游戏开发闭环（webgame-dev）

> 前置：本智能体已开启 devPreviewEnabled（会话挂 dev_start/dev_status/dev_logs/dev_stop 工具）
> 与 playwright MCP 浏览器工具。缺任一，先如实告知用户并停止，不要假装工具存在。

## 闭环步骤

### 1. 脚手架与开发
- 新项目用 vite（vanilla/react 按需求）：`npm create vite@latest <name> -- --template <t>`，依赖装在项目根。
- 既有项目先 `git status` / 读 README 摸清结构再动码。

### 2. 启动预览（平台托管）
- 调 `dev_start` 起开发服务器。缺省命令为 vite 约定 `npm run dev -- --port {port} --strictPort --host 127.0.0.1`；
  **next 等其它框架必须传 cmd 且保留 `{port}` 占位**（如 `npm run dev -- -p {port}`）。
- 已启动时再调 `dev_start` 幂等返回既有地址；状态用 `dev_status`，启动失败用 `dev_logs` 诊断。
- 返回的预览地址形如 `/preview/<会话id>/`：**这是用户在平台内的预览入口，必须写进你的回复**；
  playwright e2e 也直接访问它。

### 3. e2e 验证留证（每轮变更必做）
- playwright 工具打开预览地址 → `browser_snapshot`（无障碍树断言结构）→ `browser_take_screenshot`
  截图，**文件名放 `.shots/` 子目录**（如 `.shots/round-1-home.png`；截图落在会话工作区，
  用户可在文件面板直接查看）。
- 断言三板斧：a11y 树（结构/文案）、`browser_console_messages`（无报错）、截图（用户视角）。
- 游戏（canvas/WebGL）a11y 树信息少：以截图对比 + console 无错为主，逐轮迭代。
- 发现问题 → 修码 → 刷新复验 → 再截图，直到通过才允许进入第 4 步。

### 4. 提交与推送
- 变更通过 e2e 后提交：`git add <明确文件>` + 规范 commit message（中文一句话讲清变更）。
- 推送用 `donger-git` 的 git_push（或 shell git push）；push 会触发审批门，属正常流程，
  如实说明等待审批即可，不要绕行。

### 5. 收尾
- 把「预览地址 + 截图清单 + 变更摘要」写进回复，提醒用户在左侧文件面板「预览」标签页打开站点。
- 会话收尾调 `dev_stop` 释放并发额度（平台全局上限 4、单用户 2；闲置 30 分钟也会自动回收）。

## 注意事项
- 预览走平台同源反代，项目用**默认根路径配置**即可，不要设 base/子路径。
- 首轮冷启动（npm install）较慢属正常；dev server 崩溃平台会自动落账，重新 `dev_start` 即可。
- 端口一律交给平台注入（`{port}` 占位），**禁止写死端口**，否则多会话互相冲撞。
- 临时验证页不想落盘时可用 data: URL 做冒烟，但正式验证必须走预览地址。
