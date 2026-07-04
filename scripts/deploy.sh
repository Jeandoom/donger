#!/usr/bin/env bash
# ============================================================
# deploy.sh — donger 部署脚本
# 用法：bash scripts/deploy.sh [--port 3330] [--web-port 3333]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="$PROJECT_DIR/.deploy"

BACKEND_PORT="${1:-3330}"
WEB_PORT="${2:-3333}"

# 解析命名参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) BACKEND_PORT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "=== donger 部署脚本 ==="
echo "源目录:     $PROJECT_DIR"
echo "部署目录:   $DEPLOY_DIR"
echo "后端端口:   $BACKEND_PORT"
echo "前端端口:   $WEB_PORT"

# 1. 检查 git 状态（只允许从 master 分支部署）
BRANCH="$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "master" ]; then
  echo "❌ 错误：只能在 master 分支部署，当前分支为 $BRANCH"
  echo "   请先合并到 master 后再试"
  exit 1
fi

if [ -n "$(cd "$PROJECT_DIR" && git status --porcelain)" ]; then
  echo "⚠️  警告：工作区有未提交的更改"
  echo "   建议先提交或 stash 后再部署"
fi

# 2. 清空并创建部署目录
echo ""
echo ">>> 清理部署目录..."
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# 3. 复制项目文件（排除 node_modules、.git、data 等）
echo ">>> 复制项目文件..."
cd "$PROJECT_DIR"
git archive HEAD | tar -x -C "$DEPLOY_DIR"

# 4. 安装依赖
echo ">>> 安装后端依赖..."
cd "$DEPLOY_DIR"
npm install --production

echo ">>> 安装前端依赖..."
npm --prefix web install

# 5. 构建前端
echo ">>> 构建前端..."
npm --prefix web run build

# 6. 构建后端
echo ">>> 构建后端..."
npm run build

# 7. 创建 .env 部署配置
echo ">>> 创建部署配置..."
cat > "$DEPLOY_DIR/.env" << ENVEOF
# === donger 部署配置（自动生成）===
# 后端端口
PORT=$BACKEND_PORT
# 前端 dev 端口（仅开发期，生产期由后端托管 web/dist）
WEB_PORT=$WEB_PORT

# 数据目录（部署专用，与开发目录隔离）
WORKSPACE_DIR=$DEPLOY_DIR/data/workspace
DB_PATH=$DEPLOY_DIR/data/donger.db
MEMORY_DIR=$DEPLOY_DIR/data/memory
REPO_ROOT=$DEPLOY_DIR/data/repos

# 日志级别
LOG_LEVEL=info
ENVEOF

# 8. 复制 .env 中关键配置（LLM、钉钉等）
echo ">>> 继承关键配置..."
for key in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN LLM_MODEL DINGTALK_APP_KEY DINGTALK_APP_SECRET DINGTALK_ROBOT_CODE DINGTALK_CARD_TEMPLATE_ID ADMIN_STAFF_IDS SUPERPOWERS_PLUGIN_PATH JWT_SECRET JWT_TTL_DAYS; do
  val="$(cd "$PROJECT_DIR" && grep "^${key}=" .env 2>/dev/null || true)"
  if [ -n "$val" ]; then
    echo "$val" >> "$DEPLOY_DIR/.env"
  fi
done

echo ""
echo "=== ✅ 部署完成 ==="
echo "部署目录: $DEPLOY_DIR"
echo ""
echo "启动命令："
echo "  cd $DEPLOY_DIR && npm start"
echo ""
echo "Web 访问：http://localhost:$BACKEND_PORT"