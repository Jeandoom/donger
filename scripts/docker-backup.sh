#!/usr/bin/env bash
# donger Docker 栈备份：DB 一致性快照（better-sqlite3 .backup）+ workspace 归档 → D:\deploy\backups\<ts>\
# 用法：scripts/docker-backup.sh [栈目录]   （默认 D:\deploy\donger-docker）
# 保留 14 份；例行化=任务计划程序每日 03:30，见 docs/deploy-docker.md
set -euo pipefail
# Git Bash 对 docker.exe 参数做 MSYS 路径改写会把容器内路径翻成宿主路径（M0 实锤），必须禁用
export MSYS_NO_PATHCONV=1

STACK_DIR="${1:-/d/deploy/donger-docker}"
OUT="/d/deploy/backups"; KEEP=14
[[ -f "$STACK_DIR/.env" ]] || { echo "缺 $STACK_DIR/.env"; exit 2; }
. "$STACK_DIR/.env"
TAG="donger:${DONGER_IMAGE_TAG:?}"
WIN_STACK="D:/${STACK_DIR#/d/}"; WIN_OUT="D:/${OUT#/d/}"
ts=$(date +%Y%m%d-%H%M%S)
dest="$OUT/$ts"; wdest="$WIN_OUT/$ts"
mkdir -p "$dest"

echo "== DB 一致性备份 -> $dest/donger.db"
docker run --rm -v "${WIN_STACK}/data:/data:ro" -v "${wdest}:/backup" "$TAG" \
  node -e "require('/app/node_modules/better-sqlite3')('/data/donger.db').backup('/backup/donger.db').then(()=>{console.log('db ok');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"

echo "== workspace 归档 -> $dest/workspace.tgz"
docker run --rm -v "${WIN_STACK}/data:/data:ro" -v "${wdest}:/backup" "$TAG" \
  tar czf /backup/workspace.tgz -C /data workspace

echo "== 清理（保留 $KEEP 份）"
ls -1d "$OUT"/*/ 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do rm -rf "$old"; done
echo "== 完成：$dest"
