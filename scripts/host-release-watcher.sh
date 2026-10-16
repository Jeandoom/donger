#!/usr/bin/env bash
# donger L2 发布 watcher（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.6）：
# 轮询远端 master → SHA 前进即触发 host-release 管线 → 结果回报 /api/internal/release-result。
# 不变量：master=生产候选；watcher 是唯一部署触发者；回滚不依赖 donger 存活。
# 零入站面（只出站 fetch+POST）；状态文件记录已发布 SHA；连续失败 3 次放弃该 SHA（防风暴）。
# 例行化（管理员 PowerShell 一次，每 5 分钟）：
#   schtasks /create /tn "donger-release-watcher" /tr "C:\Program Files\Git\bin\bash.exe -c 'cd /d/code/donger && scripts/host-release-watcher.sh --once'" /sc minute /mo 5
# 环境配置（可写入栈目录 host-release.env 并 source）：
#   RELEASE_HOOK_URL=https://<域名>/api/internal/release-result
#   RELEASE_HOOK_TOKEN=<DONGER_RELEASE_HOOK_TOKEN 同值>
#   RELEASE_REPOSITORY_PATH=owner/repo（平台 API 口径）
# 用法: scripts/host-release-watcher.sh [--repo /d/code/donger] [--stack /d/deploy/donger-docker]
#         [--state FILE] [--once]
set -euo pipefail
# 注意：本脚本不做全局 MSYS_NO_PATHCONV——git.exe 的 -C 路径需要 MSYS 转换；
# docker 容器路径参数都在 host-release.sh 内部处理（其自行导出）

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STACK_DIR="/d/deploy/donger-docker"
ONCE=0
STATE_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --stack) STACK_DIR="$2"; shift 2;;
    --state) STATE_FILE="$2"; shift 2;;
    --once) ONCE=1; shift;;
    *) echo "未知参数: $1"; exit 2;;
  esac
done
STATE_FILE="${STATE_FILE:-$STACK_DIR/.release-state}"
# 可选配置文件（钩子地址/令牌/仓库路径）
[[ -f "$STACK_DIR/host-release.env" ]] && . "$STACK_DIR/host-release.env"
RELEASE_REPOSITORY_PATH="${RELEASE_REPOSITORY_PATH:-}"

log() { echo "[release-watcher $(date '+%m-%d %H:%M:%S')] $*"; }

run_once() {
  git -C "$REPO" fetch origin master --quiet || { log "fetch 失败"; return 0; }
  local remote
  remote="$(git -C "$REPO" rev-parse origin/master)"
  local state
  state="$(cat "$STATE_FILE" 2>/dev/null || echo init)"
  [[ "$remote" == "$state" ]] && return 0

  local sha8="${remote:0:8}"
  local image="donger:auto-$sha8"
  local fail_file="$STACK_DIR/.release-fails-$sha8"
  local fails=0
  [[ -f "$fail_file" ]] && fails="$(cat "$fail_file")"
  if (( fails >= 3 )); then
    log "SHA $sha8 连续失败 $fails 次，放弃（已回报，人工跟进）"
    echo "$remote" > "$STATE_FILE"
    return 0
  fi

  log "发现新 master $remote（当前状态 $state），触发发布"
  local lock="$STACK_DIR/.release-lock"
  mkdir "$lock" 2>/dev/null || { log "另一发布进行中，跳过"; return 0; }
  local rc=0
  # RELEASE_HOST_RELEASE_ARGS：部署环境扩展参数（如 --port/--rehearsal-stack 覆盖，故意词分割）
  bash "$REPO/scripts/host-release.sh" --image "$image" --sha "$remote" --stack "$STACK_DIR" \
    --lock-dir "$lock" $RELEASE_HOST_RELEASE_ARGS || rc=$?
  # 锁由 host-release 的 trap 释放；此处防御性再清一次
  rmdir "$lock" 2>/dev/null || true

  local status="deployed" reason=""
  case $rc in
    0) status="deployed";;
    3) status="build_failed"; reason="演练槽健康检查未通过（生产未触碰）";;
    5) status="build_failed"; reason="镜像构建失败或备份失败（生产未触碰）";;
    4) status="rolled_back"; reason="切换后健康检查未通过，已自动回滚";;
    6) status="rolled_back"; reason="回滚后仍不健康，需人工介入";;
    *) status="build_failed"; reason="host-release 退出码 $rc";;
  esac
  log "管线结束 rc=$rc → $status"

  # 结果回报（ReleaseResultSchema；repositoryPath 缺失时跳过回报仅记日志）
  if [[ -n "${RELEASE_HOOK_URL:-}" && -n "${RELEASE_HOOK_TOKEN:-}" && -n "$RELEASE_REPOSITORY_PATH" ]]; then
    # -k：IP 直连/自签名部署形态（生产域名+有效证书时 -k 无额外风险面）
    curl -skf -m 15 -X POST "$RELEASE_HOOK_URL" \
      -H "Authorization: Bearer $RELEASE_HOOK_TOKEN" \
      -H "content-type: application/json" \
      -d "{\"repositoryPath\":\"$RELEASE_REPOSITORY_PATH\",\"headSha\":\"$remote\",\"status\":\"$status\",\"imageTag\":\"$image\",\"reason\":\"$reason\",\"slot\":\"prod\"}" \
      || log "!! 回报失败（donger 不可达；状态机下次对账幂等）"
  else
    log "未配置 RELEASE_HOOK_URL/TOKEN/REPOSITORY_PATH，跳过回报"
  fi

  if [[ "$status" == "deployed" ]]; then
    echo "$remote" > "$STATE_FILE"
    rm -f "$fail_file"
    log "状态推进：$STATE_FILE = $remote"
  else
    echo $((fails + 1)) > "$fail_file"
    log "失败计数 $((fails + 1))/3（SHA $sha8）"
  fi
}

if [[ $ONCE -eq 1 ]]; then
  run_once
else
  log "watcher 启动（栈=$STACK_DIR 状态=$STATE_FILE）"
  while true; do
    run_once || true
    sleep 300
  done
fi
