# donger 生产镜像（单机 Docker Desktop，linux/amd64）
# 骨架复用 docs/deploy-k8s-jenkins.md §3.1 已实证设计；基线 node:24 对齐生产宿主 v24.20。
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
# 本机网络现实（对齐宿主 .npmrc 与 runner.ps1）：npmmirror registry + better-sqlite3 预编译二进制镜像
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3
# 根 lock 含 "donger-web": "file:web"——先装 web 依赖再装根，否则 npm ci 解析失败（顺序敏感，实证坑）
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web && npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
# git：agent 技能安装/仓库物化；bash+tzdata+ca-certs：见下
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# SHELL=/bin/bash：Claude CLI Bash 工具的 shell 发现依赖，缺失报 "No suitable shell found"（09-22 实证坑）
ENV SHELL=/bin/bash TZ=Asia/Shanghai LANG=C.UTF-8 NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package.json ./package.json
COPY skills ./skills
# 非 git 资产：deploy/stage.ps1 备料（zcode CLI 纯 JS；.superpowers 为遗留插件目录）
COPY deploy/assets/zcode-cli /opt/zcode-cli
COPY deploy/assets/superpowers ./.superpowers
ENV DONGER_ZCODE_CLI_PATH=/opt/zcode-cli/zcode.cjs BUILTIN_SKILLS_DIR=/app/skills
# 官方 node 镜像自带 uid 1000 的 node 用户（HOME=/home/node），不再自建
# skills/.superpowers 须可写：引擎会把 .donger-sdk-plugin 物化进技能目录（演练实锤 EACCES）
RUN mkdir -p /data && chown node:node /data && chown -R node:node /app/skills /app/.superpowers
USER node
# 构建期自检：better-sqlite3 预编译二进制在 linux/amd64 必须可用，失败即断构建（风险 R3）
RUN node -e "new (require('better-sqlite3'))(':memory:').exec('select 1')"
EXPOSE 3330
# exec 形式：node 为 PID1，直接接收 compose 的 SIGTERM 走优雅退出（停调度→冲审计→exit 0）
CMD ["node", "dist/index.js"]
