#!/usr/bin/env bash
# donger L2 宿主发布管线（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.6）：
# 备份 → 构建 → 演练槽验证 → 生产切换 → 健康观察 → 失败自动回滚。
# 机制口径：master=生产候选（watcher 是唯一部署触发者）；本脚本无 git 语义，纯机制。
# 退出码：0=deployed；3=演练未过（生产未触碰）；4=切换后不健康已回滚；5=构建失败；6=回滚后仍不健康（人工介入）
# 用法:
#   scripts/host-release.sh --image donger:TAG [--sha <sha40>]
#     [--stack /d/deploy/donger-docker] [--port 3330]
#     [--rehearsal-stack /d/deploy/donger-rehearsal] [--rehearsal-port 3331]
#     [--skip-build] [--skip-backup] [--skip-rehearse]
# 首次启用：演练栈需一次性初始化（scripts/docker-migrate.sh --rehearse --image <tag>，
# 其含数据拷贝与自动解除武装）；本脚本的演练步=对既有演练栈换 tag + up -d + 健康等待。
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE=""; SHA=""; SKIP_BUILD=0; SKIP_BACKUP=0; SKIP_REHEARSE=0
STACK_DIR="/d/deploy/donger-docker"; PORT=3330
REHEARSAL_STACK="/d/deploy/donger-rehearsal"; REHEARSAL_PORT=3331
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# NO_PATHCONV 生效期间 docker 参数不做 MSYS 转换：构建上下文与 -f 须传 Windows 风格路径
WIN_REPO="D:/${REPO#/d/}"
LOCK_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2;;
    --sha) SHA="$2"; shift 2;;
    --stack) STACK_DIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --rehearsal-stack) REHEARSAL_STACK="$2"; shift 2;;
    --rehearsal-port) REHEARSAL_PORT="$2"; shift 2;;
    --skip-build) SKIP_BUILD=1; shift;;
    --skip-backup) SKIP_BACKUP=1; shift;;
    --skip-rehearse) SKIP_REHEARSE=1; shift;;
    --lock-dir) LOCK_DIR="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 2;;
  esac
done
[[ -n "$IMAGE" ]] || { echo "缺 --image"; exit 2; }
[[ -f "$STACK_DIR/.env" ]] || { echo "缺 $STACK_DIR/.env"; exit 2; }

log() { echo "[host-release $(date +%H:%M:%S)] $*"; }

cleanup_lock() { [[ -n "$LOCK_DIR" ]] && rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup_lock EXIT
# 锁由调用方（watcher）获取后传入；直接手动调用时不获取（互斥由 watcher 保证）
if [[ -n "$LOCK_DIR" ]]; then mkdir -p "$LOCK_DIR" 2>/dev/null || true; fi

health_ok() { # $1=port
  [[ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:$1/api/health" || true)" == "200" ]]
}

wait_health() { # $1=port $2=timeout_s
  local deadline=$((SECONDS + $2))
  until health_ok "$1"; do
    (( SECONDS >= deadline )) && return 1
    sleep 5
  done
  return 0
}

current_tag() { grep -E '^DONGER_IMAGE_TAG=' "$1/.env" | head -1 | cut -d= -f2- | tr -d '"'; }
# .env 的 DONGER_IMAGE_TAG 是纯 tag（compose 拼 donger: 前缀）；入参兼容完整镜像引用
set_tag() { # $1=stack $2=image-or-tag
  local tag="${2#donger:}"
  sed -i "s|^DONGER_IMAGE_TAG=.*|DONGER_IMAGE_TAG=$tag|" "$1/.env"
}

log "== 开始发布 image=$IMAGE sha=${SHA:0:8} 生产=$STACK_DIR:$PORT"

# 1) 备份（切流前最后一致快照）。卷时代（donger-db named volume）优先走栈内
#    db-backup.ps1（docker exec 热备）；旧 bind mount 布局回退 docker-backup.sh
if [[ $SKIP_BACKUP -eq 0 ]]; then
  log "== 步骤1 备份"
  WIN_STACK_DIR="D:/${STACK_DIR#/d/}"
  if [[ -f "$STACK_DIR/db-backup.ps1" ]]; then
    powershell -NoProfile -ExecutionPolicy Bypass -File "$WIN_STACK_DIR/db-backup.ps1" \
      || { log "!! 备份失败，中止（生产未触碰）"; exit 5; }
  else
    bash "$REPO/scripts/docker-backup.sh" "$STACK_DIR" || { log "!! 备份失败，中止（生产未触碰）"; exit 5; }
  fi
else
  log "== 步骤1 备份跳过"
fi

# 2) 构建（watcher 已确保镜像存在时自动跳过）
if [[ $SKIP_BUILD -eq 0 ]]; then
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "== 步骤2 镜像已存在，跳过构建：$IMAGE"
  else
    log "== 步骤2 构建 $IMAGE（可能数分钟）"
    if ! docker build -f "$WIN_REPO/deploy/Dockerfile" -t "$IMAGE" "$WIN_REPO"; then
      log "!! 构建失败（生产未触碰）"
      exit 5
    fi
  fi
else
  log "== 步骤2 构建跳过"
fi

# 3) 演练槽验证（生产未触碰）
if [[ $SKIP_REHEARSE -eq 0 ]]; then
  log "== 步骤3 演练槽 $REHEARSAL_STACK:$REHEARSAL_PORT"
  if [[ ! -f "$REHEARSAL_STACK/compose.yaml" ]]; then
    log "!! 演练栈未初始化（先跑 scripts/docker-migrate.sh --rehearse），中止（生产未触碰）"
    exit 3
  fi
  set_tag "$REHEARSAL_STACK" "$IMAGE"
  if ! (cd "$REHEARSAL_STACK" && docker compose up -d); then
    log "!! 演练槽启动失败（生产未触碰）"
    exit 3
  fi
  if ! wait_health "$REHEARSAL_PORT" 180; then
    log "!! 演练槽健康检查未通过（生产未触碰）"
    exit 3
  fi
  log "== 演练槽健康"
else
  log "== 步骤3 演练跳过"
fi

# 4) 生产切换（记录回滚点）
PREV_TAG="$(current_tag "$STACK_DIR")"
[[ -n "$PREV_TAG" ]] || { log "!! 栈 .env 缺 DONGER_IMAGE_TAG，无法确定回滚点"; exit 2; }
log "== 步骤4 切换：$PREV_TAG → $IMAGE"
set_tag "$STACK_DIR" "$IMAGE"
if ! (cd "$STACK_DIR" && docker compose up -d); then
  log "!! compose up 失败，回滚到 $PREV_TAG"
  set_tag "$STACK_DIR" "$PREV_TAG"
  (cd "$STACK_DIR" && docker compose up -d) || true
  wait_health "$PORT" 180 || { log "!!! 回滚后仍不健康，人工介入"; exit 6; }
  exit 4
fi

# 5) 健康观察（compose start_period 90s + 轮询至 180s）
if wait_health "$PORT" 180; then
  log "== 发布成功：$IMAGE（回滚点 $PREV_TAG 保留在本机）"
  exit 0
fi

log "!! 切换后健康检查未通过，自动回滚到 $PREV_TAG"
set_tag "$STACK_DIR" "$PREV_TAG"
(cd "$STACK_DIR" && docker compose up -d) || true
if wait_health "$PORT" 180; then
  log "== 已回滚并恢复健康（旧镜像 $PREV_TAG 服务中）"
  exit 4
fi
log "!!! 回滚后仍不健康，人工介入（栈 $STACK_DIR）"
exit 6
