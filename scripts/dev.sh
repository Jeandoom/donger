#!/usr/bin/env bash
# ============================================================
# dev.sh — 一键后台启动前后端，日志可查
# 用法：
#   bash scripts/dev.sh start              # 后台启动前后端
#   bash scripts/dev.sh stop               # 停止
#   bash scripts/dev.sh restart            # 重启
#   bash scripts/dev.sh status             # 查看状态
#   bash scripts/dev.sh logs [backend|web|all]  # 跟踪日志（默认 all）
# 注：Windows 下用 git bash 运行；stop 用 taskkill /T 终止进程树。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

BACKEND_PID="$LOG_DIR/backend.pid"
WEB_PID="$LOG_DIR/web.pid"
BACKEND_LOG="$LOG_DIR/backend.log"
WEB_LOG="$LOG_DIR/web.log"

# 启动单个进程：name pidfile logfile cmd...
start_proc() {
  local name="$1" pidfile="$2" logfile="$3"; shift 3
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[$name] 已在运行 PID=$(cat "$pidfile")"
    return 0
  fi
  : > "$logfile"
  (cd "$PROJECT_DIR" && exec "$@") >> "$logfile" 2>&1 &
  echo $! > "$pidfile"
  echo "[$name] 已启动 PID=$(cat "$pidfile")  日志: $logfile"
}

stop_proc() {
  local name="$1" pidfile="$2"
  if [ ! -f "$pidfile" ]; then echo "[$name] 未运行"; return 0; fi
  local pid; pid="$(cat "$pidfile")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[$name] 进程已退出"
    rm -f "$pidfile"; return 0
  fi
  # Windows 优先 taskkill /T 终止进程树（npm→tsx→node 子进程一并清掉）
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "$pid" //T //F >/dev/null 2>&1 || kill -9 "$pid" 2>/dev/null || true
  else
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.3
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  echo "[$name] 已停止 PID=$pid"
  rm -f "$pidfile"
}

status_proc() {
  local name="$1" pidfile="$2"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[$name] 运行中 PID=$(cat "$pidfile")"
  else
    echo "[$name] 未运行"
  fi
}

case "${1:-start}" in
  start)
    start_proc backend "$BACKEND_PID" "$BACKEND_LOG" npm run dev
    start_proc web     "$WEB_PID"     "$WEB_LOG"     npm run dev:web
    echo ""
    echo "查看日志：bash scripts/dev.sh logs"
    ;;
  stop)
    stop_proc web     "$WEB_PID"
    stop_proc backend "$BACKEND_PID"
    ;;
  restart)
    "$0" stop || true
    sleep 1
    "$0" start
    ;;
  status)
    status_proc backend "$BACKEND_PID"
    status_proc web     "$WEB_PID"
    ;;
  logs)
    target="${2:-all}"
    case "$target" in
      backend) tail -f "$BACKEND_LOG" ;;
      web)     tail -f "$WEB_LOG" ;;
      all)
        echo "=== 同时跟踪 backend + web，Ctrl+C 退出 ==="
        tail -f "$BACKEND_LOG" "$WEB_LOG"
        ;;
      *) echo "用法：$0 logs [backend|web|all]"; exit 1 ;;
    esac
    ;;
  *)
    echo "用法：$0 {start|stop|restart|status|logs [backend|web|all]}"
    exit 1
    ;;
esac
