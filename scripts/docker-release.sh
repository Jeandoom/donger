#!/usr/bin/env bash
# donger 热发布脚本（spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md M1.5）
#
# 语义：build 新镜像（线上无感）→ compose up -d 重建容器（SIGTERM 触发应用侧排水，
# 在途轮自然完成/超时标 interrupted）→ 健康等待 → 失败自动回滚旧 tag。
# 前置条件（一次性）：栈目录 compose.yaml 的 stop_grace_period 用 ${DONGER_STOP_GRACE:-660s}
# 且 > DONGER_DRAIN_TIMEOUT_MS（应用默认 600000ms）+60s 缓冲。
#
# 用法：
#   scripts/docker-release.sh --image donger:20261019-1200 [--stack /d/deploy/donger-docker]
set -euo pipefail
# Git Bash 对 docker.exe 参数做 MSYS 路径改写会把容器内路径翻译成宿主路径（migrate 实锤），必须禁用
export MSYS_NO_PATHCONV=1

IMAGE=""; STACK_DIR="/d/deploy/donger-docker"; PORT=3330
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2;;
    --stack) STACK_DIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    *) echo "未知参数 $1"; exit 2;;
  esac
done
[[ -n "$IMAGE" ]] || { echo "必须 --image donger:TAG（如 donger:20261019-1200）"; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PREV_TAG=$(grep '^DONGER_IMAGE_TAG=' "$STACK_DIR/.env" 2>/dev/null | cut -d= -f2 || true)
echo "== 热发布开始 image=$IMAGE 栈=$STACK_DIR 端口=$PORT 上一版本=${PREV_TAG:-<无>}"

health() { curl -sk -o /dev/null -w '%{http_code}' -m 10 "https://localhost:${PORT}/api/health" || true; }

echo "== [1/6] 前置检查：当前实例健康"
code=$(health)
[[ "$code" == "200" ]] || { echo "!! 当前实例不健康（health=$code），拒绝在故障态上发布；先排查再发布"; exit 1; }

echo "== [2/6] 构建新镜像（线上无感）"
(cd "$REPO" && docker build -t "$IMAGE" .)

echo "== [3/6] 切换栈目录镜像 tag（旧 tag 已记录：${PREV_TAG:-无}，回滚用）"
sed -i.bak-release "s|^DONGER_IMAGE_TAG=.*|DONGER_IMAGE_TAG=${IMAGE#donger:}|" "$STACK_DIR/.env"

echo "== [4/6] compose 重建（SIGTERM 排水：在途轮自然完成，排水观察跟 docker logs）"
(cd "$STACK_DIR" && docker compose up -d)
echo "   排水中（可在另一终端 docker logs -f donger-app 看 [drain] 行；上限 DONGER_DRAIN_TIMEOUT_MS）"

echo "== [5/6] 健康等待（最长 150s）"
ok=0
for i in $(seq 1 30); do
  sleep 5
  code=$(health)
  if [[ "$code" == "200" ]]; then
    ok=1; echo "   健康检查通过（$((i*5))s）"; break
  fi
done
if [[ $ok -ne 1 ]]; then
  echo "!! 新实例健康超时（health=$code），自动回滚到 ${PREV_TAG:-<无>}"
  if [[ -n "${PREV_TAG:-}" ]]; then
    sed -i "s|^DONGER_IMAGE_TAG=.*|DONGER_IMAGE_TAG=${PREV_TAG}|" "$STACK_DIR/.env"
    (cd "$STACK_DIR" && docker compose up -d)
    for i in $(seq 1 30); do
      sleep 5
      [[ "$(health)" == "200" ]] && { echo "== 回滚完成，旧版本已恢复"; exit 1; }
    done
  fi
  echo "!! 回滚后仍未健康，人工介入：docker logs donger-app"; exit 1
fi

echo "== [6/6] 清理旧镜像（保留最近 2 个 donger 镜像）"
docker images donger --format '{{.Tag}} {{.ID}}' | tail -n +3 | awk '{print $2}' | while read -r id; do
  docker rmi "$id" >/dev/null 2>&1 || true
done
echo "== 发布完成：$IMAGE（排水零中断； interrupted 轮已由新实例自动续跑）"
echo "   回滚：sed -i 's/^DONGER_IMAGE_TAG=.*/DONGER_IMAGE_TAG=${PREV_TAG}/' $STACK_DIR/.env && cd $STACK_DIR && docker compose up -d"
