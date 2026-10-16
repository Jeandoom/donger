# donger L2 宿主发布管线运维手册

> 设计：`docs/superpowers/specs/2026-10-16-feedback-auto-dev-deploy-l2-design.md`（D1-D8 已拍板）
> 不变量：**master = 生产候选**——watcher 是唯一部署触发者；回滚不依赖 donger 存活；零入站面（只出站 fetch+POST）。

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| watcher | `scripts/host-release-watcher.sh` | 轮询 origin/master，SHA 前进触发管线，结果回报平台 |
| 发布管线 | `scripts/host-release.sh` | 备份→构建→演练槽验证→切换→健康观察→失败自动回滚 |
| 回报端点 | `POST /api/internal/release-result` | Bearer 令牌鉴权；推进 release_runs/反馈状态机 |
| 平台侧 | ReleaseService（进程内） | 轮询 [autofix] MR→策略评估→自动合并；回报回收 |

## 退出码（host-release.sh）

0=deployed；3=演练未过（生产未触碰）；4=切换后不健康已自动回滚；5=构建/备份失败（生产未触碰）；6=回滚后仍不健康（**人工介入**）。

## 启用步骤（管理员一次性）

1. **平台侧**：生产 `donger.env` 追加 `DONGER_RELEASE_HOOK_TOKEN=<随机值>`，重启生效（空=回报端点关闭）。
2. **演练栈初始化**（一次性，含数据拷贝与自动解除武装）：
   `scripts/docker-migrate.sh --rehearse --image donger:<tag>`
3. **宿主配置**：写 `D:\deploy\donger-docker\host-release.env`：
   ```bash
   RELEASE_HOOK_URL=https://<域名>/api/internal/release-result
   RELEASE_HOOK_TOKEN=<与平台同值>
   RELEASE_REPOSITORY_PATH=<owner>/<repo>   # 平台 API 口径（gitee=owner/repo）
   # 可选覆盖（默认 3330/donger-rehearsal 栈）：
   # RELEASE_HOST_RELEASE_ARGS="--port 3330 --rehearsal-stack /d/deploy/donger-rehearsal --rehearsal-port 3331"
   ```
4. **例行化**（管理员 PowerShell 一次，每 5 分钟）：
   ```powershell
   schtasks /create /tn "donger-release-watcher" /tr "C:\Program Files\Git\bin\bash.exe -c 'cd /d/code/donger && scripts/host-release-watcher.sh --once'" /sc minute /mo 5
   ```
5. **总闸**：`DONGER_AUTODEV_DISABLED=true`（.env 后重启）→ ReleaseService 空转 + autoDev git 放行白名单全拒。

## 平台侧工作流配置

workflow 编辑页「自动发布（L2）」区：启用 + 三个上限（文件数/行数/每日合并）；Agent 须绑定仓库且其首个仓库即发布对象仓库；Agent 用「自动修复工程师」（builtin-auto-fix，仅管理员）或等效模板（MR 标题 `[autofix]`、描述含 ```donger-proposal 提案块、分支 `fix-YYYYMMDD-*`）。

## 状态机与幂等

- release_runs：`needs_human → merged → deployed / rolled_back`（`merge_failed` 终态等人工）；同 MR 终身一行，按 (repositoryPath, mrNumber) 唯一。
- 回报幂等：重复 deployed/rolled_back 上报直接 200；`build_failed` 维持 merged 仅记 detail（watcher 下轮对同一 SHA 重试，连续 3 次失败放弃并推进状态）。
- 回滚冷却：rolled_back 后该 workflow 冷却 24h（策略可配）不再自动合并。
- HEAD 未命中的回报返回 404（如平台侧从未记录该提案）——**基础设施提交（非 autofix MR）的发布回报 404 属设计内**，watcher 记「回报未命中」即止。

## 安全边界（恒转人工，策略硬 deny）

default-gates / gate-router / approval-flow / permission-mode / web-route-guards / *agent-runner* / deploy/** / scripts/(docker|host)-* / .env* / Dockerfile / credential* / migrations / package(-lock).json / release-*（L2 自身）；修改既有测试文件；新增依赖。kill-switch 与审批卡兜底（策略未命中的任何 git 写照旧弹卡）。

## 实测记录（2026-10-17，隔离槽 donger-l2e2e/e2e-rh，端口 3332/3333，不触生产槽）

- 绿路（演练→切换→健康）：EXIT=0，槽 tag 切换、健康 200；
- 演练门（坏镜像）：EXIT=3，生产槽未触碰（tag 不变、健康 200）；
- 切后回滚（坏镜像直切）：EXIT=4，自动回滚旧 tag、恢复健康 200；
- watcher 全闭环（含新代码镜像 donger:l2e2e-20261017-0050）：fetch→触发→演练→切换→回报 `{"status":"deployed"}`→release_runs 行 `merged→deployed`（detail 记录 imageTag/slot）。

## 已知坑

- `MSYS_NO_PATHCONV=1` 不可全局套在 git 命令前（git.exe 收到未转换的 `/d/...` 路径报 not a git repository）——watcher 不设全局，docker 容器路径参数由 host-release.sh 内部处理（构建上下文用 `WIN_REPO` Windows 风格）。
- 栈 `.env` 的 `DONGER_IMAGE_TAG` 是纯 tag（compose 拼 `donger:` 前缀）；set_tag 已兼容完整镜像引用入参。
- 演练槽日常验证=对既有演练栈换 tag + up -d + 健康等待（数据沿用上次初始化拷贝）；全量数据重拷仅在 `docker-migrate.sh --rehearse`。
