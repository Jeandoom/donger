#!/usr/bin/env bash
# donger Docker 迁移脚本（D1 bind mount 口径）
# 用法：
#   演练（不停生产，端口 3331，栈目录 D:\deploy\donger-rehearsal）：
#     scripts/docker-migrate.sh --rehearse --image donger:TAG
#   真切换（先停 3330 旧进程，端口 3330，栈目录 D:\deploy\donger-docker）：
#     scripts/docker-migrate.sh --execute --image donger:TAG
# 步骤：停旧(仅 execute) → staging 拷贝(活数据=db三件套+workspace) → 清 donger.lock →
#       路径改写(容器内跑 rewrite-db-paths.cjs) → certs/env/gitconfig/compose 装配 → compose up → 健康等待
set -euo pipefail
# Git Bash 对 docker.exe 参数做 MSYS 路径改写会把容器内路径 /rewrite.cjs 翻成宿主路径（M0 实锤），必须禁用
export MSYS_NO_PATHCONV=1

MODE=rehearse; IMAGE=""; PORT=3331; SLOT="-rehearsal"
PROD_DIR="/d/deploy/donger"; STACK_DIR="/d/deploy/donger-rehearsal"; REPO="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) MODE=execute; PORT=3330; SLOT=""; STACK_DIR="/d/deploy/donger-docker"; shift;;
    --rehearse) MODE=rehearse; shift;;
    --image) IMAGE="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --stack) STACK_DIR="$2"; shift 2;;
    --prod) PROD_DIR="$2"; shift 2;;
    *) echo "未知参数 $1"; exit 2;;
  esac
done
[[ -n "$IMAGE" ]] || { echo "必须 --image donger:TAG"; exit 2; }
WIN_STACK="D:/${STACK_DIR#/d/}"; WIN_REPO="D:/${REPO#/d/}"; WIN_PROD="D:/${PROD_DIR#/d/}"
echo "== 模式=$MODE 生产=$PROD_DIR 栈=$STACK_DIR 端口=$PORT 镜像=$IMAGE"

port_pid() { netstat -ano | grep ":$1 " | grep -i LISTENING | awk '{print $5}' | head -1 || true; }

if [[ "$MODE" == "execute" ]]; then
  pid=$(port_pid "$PORT")
  if [[ -n "${pid:-}" ]]; then
    echo "== 停止占用 $PORT 的旧生产进程 PID=$pid"
    taskkill //F //PID "$pid"; sleep 2
  else
    echo "== $PORT 无监听进程，跳过停止"
  fi
else
  echo "== 演练模式：不停生产"
  pid=$(port_pid "$PORT")
  [[ -z "${pid:-}" ]] || { echo "!! 演练端口 $PORT 被占用 PID=$pid，先清理"; exit 1; }
fi

echo "== staging 拷贝（DB 三件套 + workspace，不含 backups/ 与历史手工备份）"
mkdir -p "$STACK_DIR/data"
for f in donger.db donger.db-wal donger.db-shm; do
  [[ -f "$PROD_DIR/data/$f" ]] && cp -f "$PROD_DIR/data/$f" "$STACK_DIR/data/$f"
done
# robocopy 退出码 1=有文件拷贝（成功），>=8 才是真失败；不能用裸 set -e 语义
# robocopy 是原生 exe：喂 Windows 风格路径；本脚本已 export MSYS_NO_PATHCONV=1，旗标必须单斜杠
rc=0
robocopy "${WIN_PROD}/data/workspace" "${WIN_STACK}/data/workspace" /E /R:1 /W:1 /NFL /NDL /NJH /NJS > /dev/null || rc=$?
[[ $rc -lt 8 ]] || { echo "!! workspace 拷贝失败 robocopy=$rc"; exit 1; }

echo "== 清理陈旧单实例锁（staging 内，防 rehearsal 期间生产 PID 活跃导致容器拒启）"
rm -f "$STACK_DIR/data/donger.lock"

echo "== 路径改写（容器内执行，事务改写 users.data.homeDir）"
docker run --rm \
  -v "${WIN_REPO}/scripts/rewrite-db-paths.cjs:/rewrite.cjs:ro" \
  -v "${WIN_STACK}/data:/work" \
  "$IMAGE" node /rewrite.cjs /work/donger.db --apply

if [[ "$MODE" == "rehearse" ]]; then
  echo "== 演练解除武装：staging 内停用全部工作流 + 作废在途触发/通知（防 rehearsal 对外网真实副作用）"
  docker run --rm -v "${WIN_STACK}/data:/work" "$IMAGE" node -e '
    const D = require("/app/node_modules/better-sqlite3");
    const db = new D("/work/donger.db");
    const tx = db.transaction(() => {
      try { const r = db.prepare("UPDATE workflows SET enabled=0").run(); console.log("  workflows 停用:", r.changes); } catch (e) { console.log("  workflows:", e.message); }
      try { const r = db.prepare("UPDATE event_firings SET status=? WHERE status IN (?,?)").run("cancelled", "pending", "queued"); console.log("  event_firings 作废:", r.changes); } catch (e) { console.log("  event_firings:", e.message); }
      try { const r = db.prepare("UPDATE notification_deliveries SET status=? WHERE status IN (?,?)").run("failed", "pending", "retrying"); console.log("  通知在途作废:", r.changes); } catch (e) { console.log("  notifications:", e.message); }
    });
    tx(); db.close();
  '
fi

echo "== 装配栈目录：certs / zcode provider 配置 / donger.env / .env / gitconfig / compose.yaml"
rm -rf "$STACK_DIR/certs"; cp -a "$PROD_DIR/.certs" "$STACK_DIR/certs"

# zcode 内置 provider 配置（含凭证，不烘镜像）：从 ZCode 桌面安装目录拷入栈目录，compose 只读挂载
ZPROV_SRC="/c/Program Files/ZCode/resources/config/provider/zcode-builtin.json"
if [[ -f "$ZPROV_SRC" ]]; then
  mkdir -p "$STACK_DIR/zcode-provider"
  cp -f "$ZPROV_SRC" "$STACK_DIR/zcode-provider/zcode-builtin.json"
else
  echo "!! 未找到 zcode-builtin.json（zcode 引擎内置 provider 将缺位）：$ZPROV_SRC"
fi

# donger.env：生产 .env 剔除路径与遗留键，其余逐字保留；路径键在文件尾追加容器值
DROP='^(PORT|WEB_PORT|HOST|WORKSPACE_DIR|DB_PATH|MEMORY_DIR|REPO_ROOT|HTTPS_CERT_PATH|HTTPS_KEY_PATH|HTTPS_CHAIN_PATH|SUPERPOWERS_PLUGIN_PATH|PUBLIC_BASE_URL)='
grep -vE "$DROP" "$PROD_DIR/.env" > "$STACK_DIR/donger.env"
cat >> "$STACK_DIR/donger.env" <<'EOF'

# —— 由 scripts/docker-migrate.sh 追加：路径键改容器值 ——
WORKSPACE_DIR=/data/workspace
DB_PATH=/data/donger.db
HTTPS_CERT_PATH=/certs/cert.pem
HTTPS_KEY_PATH=/certs/privkey.pem
HTTPS_CHAIN_PATH=/certs/chain.pem
EOF

cat > "$STACK_DIR/.env" <<EOF
DONGER_IMAGE_TAG=${IMAGE#donger:}
DONGER_PORT=${PORT}
DONGER_SLOT_SUFFIX=${SLOT}
EOF

# gitconfig 最小集：user 身份 + github 代理（127.0.0.1 在容器内不可达 → host.docker.internal）+ safe.directory
{
  name=$(git config --global user.name || true)
  email=$(git config --global user.email || true)
  if [[ -n "$name" ]]; then
    echo "[user]"
    printf '\tname = %s\n\temail = %s\n' "$name" "$email"
  fi
  for scope in http https; do
    v=$(git config --global --get "${scope}.https://github.com.proxy" || true)
    [[ -z "$v" ]] && continue
    v=${v//127.0.0.1/host.docker.internal}
    echo "[$scope \"https://github.com\"]"
    printf '\tproxy = %s\n' "$v"
  done
  echo "[safe]"
  printf '\tdirectory = *\n'
} > "$STACK_DIR/gitconfig"

cp "$REPO/deploy/compose.yaml" "$STACK_DIR/compose.yaml"

echo "== compose up（等健康，最长 120s）"
(cd "$STACK_DIR" && docker compose up -d)
ok=0
for i in $(seq 1 24); do
  sleep 5
  code=$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:${PORT}/api/health" || true)
  if [[ "$code" == "200" ]]; then
    ok=1; echo "== 健康检查通过（$((i*5))s）：https://localhost:${PORT}/api/health"; break
  fi
done
[[ $ok -eq 1 ]] || { echo "!! 健康检查超时，查日志：docker logs donger-app${SLOT}"; exit 1; }

echo "== 完成（$MODE）。回滚：cd $STACK_DIR && docker compose down；旧目录未动。"
