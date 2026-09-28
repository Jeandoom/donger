# donger 云端部署手册（Jenkins + K8s + Rancher）

> 适用版本：master（2026-09-20，基于 e0bf52d 代码核实）。
> 读者：负责上线的 DevOps / 后端。
> 关系：本文档是**云端 K8s 正式部署**的完整操作手册；单机/内网穿透部署见 [deploy-remote-access.md](./deploy-remote-access.md)，两者互不依赖。
> 所有代码引用均已对齐当前源码（`config.ts` 全量环境变量、`/api/health` 公开探针、`/api/auth/exchange` 请求格式、单实例锁与自动建表行为）。

---

## 1. 架构总览

```
git push → Jenkins 流水线（lint/test → docker build → push Harbor → kubectl set image）
        → K8s（namespace donger：单副本 Recreate Deployment + PVC + Ingress）
        → Ingress（公司 CA 证书终止 TLS）→ Service → Pod:3330（容器内纯 HTTP）
持久化：PVC /app/data（donger.db + workspace + repos + memory + 锁文件）
备份：CronJob 每日整库 .backup 到独立 PVC
```

### 四条硬约束（先理解再操作）

| # | 约束 | 原因（代码依据） |
|---|---|---|
| 1 | **`replicas: 1` + `strategy: Recreate`，禁止扩副本与滚动更新** | SQLite 单文件数据库 + db 同目录单实例锁 `donger.lock`（`src/index.ts:57`）。双 Pod 并存会抢锁/双写库文件。崩溃残留锁有 pid 存活探测自动接管，Recreate 策略下正常工作 |
| 2 | **TLS 终止在 Ingress，容器内纯 HTTP** | 证书统一由 Ingress Secret 管理，换证书不重构建镜像。回调地址靠显式 `PUBLIC_BASE_URL`——不配会推导出 `https://0.0.0.0:3330` 这种废地址（`web-channel.ts:4116`） |
| 3 | **`JWT_SECRET` / `SECRET_KEY` 显式固定在 Secret，绝不轮换** | `SECRET_KEY` 换值 = 库内加密的 git 凭证 / 模型 key 全部解不开（`app_config.skill_secret_key` 派生链）；`JWT_SECRET` 换值 = 全员 JWT 失效重登 |
| 4 | **全部状态落在 PVC，镜像无状态** | `DB_PATH/WORKSPACE_DIR/MEMORY_DIR/REPO_ROOT` 四件套相对 cwd（部署目录 `/app`），挂 `/app/data` 一处 PVC |

---

## 2. 前置条件

### 2.1 基础设施待确认清单（部署前填齐）

| # | 事项 | 示例 | 用在哪 |
|---|---|---|---|
| 1 | 内网正式域名 | `donger.corp.example.com` | DNS、Ingress、PUBLIC_BASE_URL、钉钉/GitHub 回调登记 |
| 2 | 公司 CA 签发的该域名证书（cert + key） | — | `donger-tls` Secret |
| 3 | Harbor 地址与项目名 | `harbor.corp.example.com/infra/donger` | 镜像 push/pull |
| 4 | StorageClass 名称（数据盘 + 备份盘两块 PVC） | `longhorn` / NFS 等 | PVC 定义 |
| 5 | Ingress 控制器类型（下文按 nginx-ingress 写） | `nginx` | Ingress annotations |
| 6 | Jenkins agent 形态（宿主 docker / K8s agent / kaniko） | 宿主 docker | Jenkinsfile Build 阶段 |

### 2.2 出网要求（Pod egress，缺一项对应功能不可用）

- `open.bigmodel.cn:443` —— **硬前提**：LLM 端点，且 `ANTHROPIC_AUTH_TOKEN` 缺失时进程**启动即失败**（zod 必填），不是降级。
- `*.dingtalk.com:443/wss` —— 启用钉钉通道时（`dingtalk-stream` 长连接）。
- `github.com / api.github.com` —— 启用 GitHub OAuth 登录时（也可配 `GITHUB_OAUTH_PROXY` 走代理）。
- 公司 Git 仓库域名 —— agent 绑定仓库 git 操作（协议层 git+https，走 PAT AskPass，无需 ssh）。

### 2.3 平台侧登记（域名与旧环境不一致，必须同步改）

| 平台 | 登记内容 |
|---|---|
| 公司内部 DNS | 域名 → Ingress LB IP |
| 钉钉开发者后台（如启用） | 登录回调 `https://<域名>/api/auth/dingtalk/callback`，与 Secret 中 `DINGTALK_LOGIN_REDIRECT_URI` **一字不差** |
| GitHub OAuth App（如启用） | callback `https://<域名>/api/auth/github/callback`，与 `GITHUB_LOGIN_REDIRECT_URI` 一致 |

> 扫码/OAuth 回调走浏览器重定向，纯内网域名可用，不要求平台服务器反向可达内网。

---

## 3. 仓库新增文件（一次提交，共 9 个文件）

> 以下文件均为**新增**，当前仓库（master e0bf52d）尚无 `deploy/` 目录、`.dockerignore` 与 `Jenkinsfile`。

### 3.1 `deploy/Dockerfile`

> 注意 COPY 顺序：根 `package.json` 声明了 `"donger-web": "file:web"` 嵌套依赖，**必须先放 web 清单再 `npm ci`**，否则根依赖解析失败。

```dockerfile
# ---------- 构建阶段 ----------
FROM node:20-slim AS builder
WORKDIR /app
# 内网 npm 镜像（按公司 Nexus 实际地址替换；若代理含 GitHub Releases 二进制可去掉下行 mirror）
RUN npm config set registry https://nexus.corp.example.com/repository/npm-group/ \
 && npm config set better_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3
# 顺序敏感：web 清单先行（根依赖 file:web 依赖它）
COPY web/package.json web/package-lock.json ./web/
COPY package.json package-lock.json ./
RUN npm ci && cd web && npm ci
COPY . .
RUN npm run build:web && npm run build && npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:20-slim
# git 必装（git 工具守卫与仓库物化走 git CLI）；bash 供 Claude CLI 的 Bash 工具（Debian 自带，显式声明防换基础镜像）；ca-certificates 供出网 https
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web ./web
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/package.json ./package.json
# SHELL 必须显式设置：Docker 不会为容器进程设置 SHELL（只有登录 shell 才会设），而本镜像主进程
# 直接是 node（CMD ["node","dist/index.js"]），无 bash 在进程链上——Claude CLI 在 Linux 靠 SHELL
# 定位 POSIX shell，缺失时 agent 执行任何 Bash 命令报 "No suitable shell found"。
# （Windows 单机部署不受影响：CLI 在 Windows 按已知路径找 Git Bash，不读 SHELL）
ENV SHELL=/bin/bash
ENV NODE_ENV=production TZ=Asia/Shanghai
EXPOSE 3330
CMD ["node", "dist/index.js"]
```

说明：
- **`ENV SHELL=/bin/bash` 不能省**：Docker 不会为容器进程设置 `SHELL`（该变量由登录 shell 设置），主进程直接是 node 时进程链上没有 bash，Claude CLI 的 Bash 工具报 `No suitable shell found`。`node:20-slim` 本身带 bash，装 `bash` 到 apt 行是为防将来换基础镜像时静默坏掉。**注意 alpine 基础镜像（node:*-alpine）不预装 bash**，必须 `apk add bash`（外部 GitLab CI 即此形态：`apk add git bash ca-certificates` + `ENV SHELL=/bin/bash`，2026-09-22 实证修复）。
- 镜像内**没有 python**（slim 基础镜像）：agent 若要跑 python 需求，在 apt 行追加 `python3`（或按需制作带 python 的变体镜像）。
- `better-sqlite3` 在 `node:20-slim`（linux/amd64 glibc）有预编译二进制，`npm ci` 直接拉取，无需编译工具链；**镜像必须在目标架构上构建**（跨机拷贝 node_modules 会 `Could not locate bindings file`）。
- `npm run build:web` = `web: tsc && vite build`；`npm run build` = `tsc -p tsconfig.build.json` → `dist/index.js`。生产 `vite build` 不读证书（只有 dev server 读 `HTTPS_CERT_PATH`），容器构建无证书依赖。
- 运行时 `web/` 整目录带入（含 dist 与 file: 依赖解析所需清单），`skills/` 为预装技能根（task-dispatch / task-optimize / web-ui-iterate 三个 Pack）。

### 3.2 `.dockerignore`（仓库根，docker build 上下文按根目录）

```text
.git
.deploy
.data
.certs
data
node_modules
web/node_modules
web/dist
dist
.env
.env.*
*.md
docs
test
.claude
.claude-worktrees
```

### 3.3 `deploy/k8s/00-namespace.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: donger }
```

### 3.4 `deploy/k8s/01-configmap.yaml`（非敏感配置，改后需重启 Pod）

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: donger-config, namespace: donger }
data:
  PORT: "3330"
  HOST: "0.0.0.0"
  ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic"
  LLM_MODEL: "glm-4.6"
  PUBLIC_BASE_URL: "https://donger.corp.example.com"    # ← 改为实际内网域名（必配，勿删）
  DB_PATH: "./data/donger.db"
  WORKSPACE_DIR: "./data/workspace"
  MEMORY_DIR: "./data/memory"
  REPO_ROOT: "./data/repos"
  BUILTIN_SKILLS_DIR: "/app/skills"                     # 容器必配：默认值会指到 PVC 的 data/repos/skills（不存在）
  LOG_LEVEL: "info"
  EMAIL_SIGNUP_ALLOWED_DOMAINS: "corp.example.com"      # 公司邮箱域名；留空=仅邀请链接注册
  ADMIN_EXTERNAL_IDS: "admin@corp.example.com,cli-admin"  # 首管理员邮箱 + CLI 身份（冷启动用，见 §4 步骤 8）
  GIT_ALLOW_PRIVATE_HOSTS: "true"                       # 公司 Git 仓库在内网，必须放行
  TRUST_PROXY: "true"                                   # Ingress 后取真实客户端 IP 限流（前提见下注）
  TURN_STALL_TIMEOUT_MS: "0"                            # 与生产现状一致：审批门无限等待，停摆看门狗关闭
  AGENT_LLM_PRESETS: ""                                 # 可选：name|model|baseUrl;name2|model2|baseUrl2
```

> `TRUST_PROXY=true` 的前提：nginx-ingress 默认 `use-forwarded-headers=false` 会**用真实客户端 IP 覆盖** X-Forwarded-For，此时取首段安全。上线后验证一次：`curl -H "X-Forwarded-For: 1.1.1.1" .../api/auth/register` 连打 6 次，若第 6 次 429 说明限流键未被伪造；若始终 200，说明公司 Ingress 透传客户端 XFF，应将 `TRUST_PROXY` 改回 `"false"`（代价：限流按 Ingress Pod IP 计，全站共享注册限流桶）。

### 3.5 `deploy/k8s/02-secret.yaml`（敏感配置；真值不入 git，首次手工 kubectl apply 或 sealed-secrets）

```yaml
apiVersion: v1
kind: Secret
metadata: { name: donger-secret, namespace: donger }
stringData:
  ANTHROPIC_AUTH_TOKEN: "<智谱 API Key>"
  JWT_SECRET: "<openssl rand -hex 32，一次固定，永不轮换>"
  SECRET_KEY: "<openssl rand -hex 32，一次固定，永不轮换>"
  CLI_TOKEN: "<openssl rand -hex 32，首管理员冷启动用，可事后清掉>"
  DINGTALK_APP_KEY: ""
  DINGTALK_APP_SECRET: ""
  DINGTALK_ROBOT_CODE: ""
  DINGTALK_CARD_TEMPLATE_ID: ""
  DINGTALK_LOGIN_REDIRECT_URI: "https://donger.corp.example.com/api/auth/dingtalk/callback"
  GITHUB_CLIENT_ID: ""
  GITHUB_CLIENT_SECRET: ""
  GITHUB_LOGIN_REDIRECT_URI: "https://donger.corp.example.com/api/auth/github/callback"
```

### 3.6 `deploy/k8s/03-pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: donger-data, namespace: donger }
spec:
  accessModes: [ReadWriteOnce]        # SQLite 单写
  resources: { requests: { storage: 50Gi } }   # workspace/repos 随使用增长，按需调
  storageClassName: <公司 StorageClass>
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: donger-backup, namespace: donger }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 20Gi } }
  storageClassName: <公司 StorageClass>
```

### 3.7 `deploy/k8s/04-deployment.yaml`（核心）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: donger, namespace: donger }
spec:
  replicas: 1                          # 硬约束：SQLite + 单实例锁，禁止扩副本
  strategy:
    type: Recreate                     # 硬约束：滚动更新会双实例并存抢锁
  selector: { matchLabels: { app: donger } }
  template:
    metadata: { labels: { app: donger } }
    spec:
      terminationGracePeriodSeconds: 300   # 审批门等待 / 任务收尾宽限
      containers:
        - name: donger
          image: harbor.corp.example.com/infra/donger:PLACEHOLDER   # 由 Jenkins set image 覆盖
          ports: [ { containerPort: 3330 } ]
          envFrom:
            - configMapRef: { name: donger-config }
            - secretRef: { name: donger-secret }
          resources:
            requests: { cpu: "500m", memory: 1Gi }
            limits:   { cpu: "2",    memory: 4Gi }   # agent 并发任务内存波动大
          readinessProbe:
            httpGet: { path: /api/health, port: 3330 }   # 公开路由，无需鉴权
            initialDelaySeconds: 15
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /api/health, port: 3330 }
            initialDelaySeconds: 40
            periodSeconds: 30
          volumeMounts:
            - { name: data, mountPath: /app/data }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: donger-data }
```

> `/api/health` 是公开 GET（`web-route-guards.ts:67`），启动会自动建全部表（各 store `migrate()`，31 处 `CREATE TABLE IF NOT EXISTS`），readiness 通过即代表服务可用。

### 3.8 `deploy/k8s/05-service-ingress.yaml`

```yaml
apiVersion: v1
kind: Service
metadata: { name: donger, namespace: donger }
spec:
  selector: { app: donger }
  ports: [ { port: 3330, targetPort: 3330 } ]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: donger
  namespace: donger
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # SSE 长连接防掐（必配）
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"       # SSE 必须关缓冲（必配）
spec:
  ingressClassName: nginx            # ← 按公司 Ingress 控制器改
  tls:
    - hosts: [ donger.corp.example.com ]
      secretName: donger-tls
  rules:
    - host: donger.corp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: donger, port: { number: 3330 } } }
```

> SSE 是对话流式回复与审批推送的命脉，`proxy-buffering: off` 与超时拉长**不能省**，否则流式输出卡顿、长审批流断连。

### 3.9 `deploy/k8s/06-backup-cronjob.yaml`（每日整库备份）

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: donger-backup, namespace: donger }
spec:
  schedule: "0 18 * * *"            # UTC 18:00 = 北京时间 02:00
  successfulJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: harbor.corp.example.com/infra/donger:PLACEHOLDER   # 复用业务镜像（内含 better-sqlite3）
              command: ["node", "-e"]
              args:
                - |
                  const db=require('better-sqlite3')('/app/data/donger.db');
                  const d=new Date().toISOString().slice(0,10);
                  db.backup('/app/backup/donger-'+d+'.db').then(()=>console.log('backup ok '+d));
              volumeMounts:
                - { name: data, mountPath: /app/data, readOnly: true }
                - { name: backup, mountPath: /app/backup }
          volumes:
            - name: data
              persistentVolumeClaim: { claimName: donger-data }
            - name: backup
              persistentVolumeClaim: { claimName: donger-backup }
```

### 3.10 `Jenkinsfile`（仓库根）

```groovy
pipeline {
  options { timestamps(); disableConcurrentBuilds() }   // 部署串行，防双发抢锁
  environment {
    IMAGE      = 'harbor.corp.example.com/infra/donger'
    TAG        = "1.0.${BUILD_NUMBER}-${GIT_COMMIT.take(8)}"
    NS         = 'donger'
    KUBECONFIG = credentials('rancher-prod-kubeconfig')   // Jenkins 凭证：Rancher 下载的集群 kubeconfig
  }
  stages {
    stage('CI') {
      agent { docker { image 'node:20' args '-u 0:0' } }
      steps {
        sh 'npm config set registry https://nexus.corp.example.com/repository/npm-group/'
        sh 'npm ci'
        sh 'npm run lint && npm test'          // biome + vitest（后端全量）
        sh 'cd web && npm ci && npm run lint && npm test && npm run build'   // web 构建产物供镜像阶段复用缓存可加，此处以镜像内构建为准
      }
    }
    stage('Build & Push') {
      steps {
        sh 'docker build -f deploy/Dockerfile -t $IMAGE:$TAG -t $IMAGE:latest .'
        withCredentials([usernamePassword(credentialsId: 'harbor-creds',
                          usernameVariable: 'H_USER', passwordVariable: 'H_PASS')]) {
          sh 'echo $H_PASS | docker login harbor.corp.example.com -u $H_USER --password-stdin'
          sh 'docker push $IMAGE:$TAG && docker push $IMAGE:latest'
        }
      }
    }
    stage('Deploy') {
      steps {
        sh 'kubectl -n $NS apply -f deploy/k8s/'                      // 首次全量 / 后续幂等
        sh 'kubectl -n $NS set image deployment/donger donger=$IMAGE:$TAG'
        sh 'kubectl -n $NS rollout status deployment/donger --timeout=300s'
      }
    }
    stage('Verify') {
      steps {
        sh 'curl -fsS https://donger.corp.example.com/api/health'     // 出口端到端验证
      }
    }
  }
  post {
    failure {
      sh 'kubectl -n $NS rollout undo deployment/donger || true'      // 失败自动回滚上一版本
      mail to: 'ops@corp.example.com', subject: "donger deploy failed #${BUILD_NUMBER}", body: 'See Jenkins console'
    }
  }
}
```

> Jenkins agent 需具备 docker（构建/推送）与 kubectl（部署）；若公司 Jenkins 为 K8s agent，Build & Push 阶段可换 kaniko/skopeo 无特权构建，其余不变。

---

## 4. 首次上线步骤（按序执行，可勾选）

- [ ] **步骤 1 · DNS 与证书**：内部 DNS 将域名解析到 Ingress LB；向公司 CA 申请该域名证书，创建 TLS Secret：
  ```bash
  kubectl -n donger create secret tls donger-tls \
    --cert=./donger.corp.example.com.crt --key=./donger.corp.example.com.key
  ```
  （namespace 不存在时先 `kubectl create ns donger`，或直接 apply §3.3）
- [ ] **步骤 2 · Harbor**：建项目 `infra`（或按公司规范），确认 Jenkins 凭证 `harbor-creds` 可推。
- [ ] **步骤 3 · Jenkins 凭证**：Rancher → 集群 → 下载 kubeconfig → 存为 Jenkins Secret text 凭证 `rancher-prod-kubeconfig`。
- [ ] **步骤 4 · 生成固定密钥**（一次生成、永久保存、同步进密码管理器与灾备记录）：
  ```bash
  openssl rand -hex 32   # JWT_SECRET
  openssl rand -hex 32   # SECRET_KEY（换值=库内加密凭证全部解不开）
  openssl rand -hex 32   # CLI_TOKEN（冷启动后可清）
  ```
- [ ] **步骤 5 · 填真值**：按 §3.4 / §3.5 修改 ConfigMap（域名、邮箱域名、管理员邮箱）与 Secret（智谱 Key、三个密钥），首次用 `kubectl apply -f` 手工入集群（此后文件中的密钥占位不提交 git）。
- [ ] **步骤 6 · 提交并触发流水线**：将 §3 全部文件提交 master，Jenkins 构建（首跑约 10~15 分钟，含依赖安装与前后端构建）。
- [ ] **步骤 7 · 部署验证**：
  ```bash
  kubectl -n donger rollout status deployment/donger --timeout=300s
  kubectl -n donger logs deploy/donger --tail=50        # 应看到「donger 启动」且无 LLM 配置报错
  curl -fsS https://donger.corp.example.com/api/health  # 出口验证
  ```
- [ ] **步骤 8 · LLM 连通验证**（内网上云最常见失败点——Pod 出网到智谱）：
  ```bash
  kubectl -n donger exec deploy/donger -- node -e \
    "fetch('https://open.bigmodel.cn').then(r=>console.log('LLM reachable:',r.status)).catch(e=>console.log('BLOCKED:',e.message))"
  ```
  也可做一次真实调用验证（等价于 scripts/probe-llm.ts 的最小请求）：
  ```bash
  kubectl -n donger exec deploy/donger -- node -e \
    "fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_AUTH_TOKEN,'content-type':'application/json'},body:JSON.stringify({model:process.env.LLM_MODEL,max_tokens:8,messages:[{role:'user',content:'回复:可用'}]})}).then(r=>r.text()).then(t=>console.log(t.slice(0,200)))"
  ```
- [ ] **步骤 9 · 首管理员冷启动**（系统无 SMTP，验证链接由管理员线下转交，首人需用 CLI 身份破局）：
  1. ConfigMap 的 `ADMIN_EXTERNAL_IDS` 已含 `<管理员邮箱>` 与 `cli-admin`；
  2. 浏览器打开 `https://<域名>` → 注册管理员邮箱（返回"注册已受理"即为 pending 态，24h 内有效）；
  3. 用 CLI_TOKEN 换 JWT（身份 internal/cli-admin，具备 admin 权限）：
     ```bash
     JWT=$(curl -fs -X POST https://donger.corp.example.com/api/auth/exchange \
       -H 'Content-Type: application/json' -d '{"token":"<CLI_TOKEN>"}' | jq -r .token)
     curl -fs https://donger.corp.example.com/api/admin/email-verifications \
       -H "Authorization: Bearer $JWT" | jq -r '.verifications[] | select(.verified==false) | .verifyPath'
     ```
  4. 浏览器打开输出的 `/api/auth/verify?token=...` → 核销即自动登录，该账号即 admin（`ADMIN_EXTERNAL_IDS` 中邮箱与 externalId 精确匹配才生效）；
  5. （可选）冷启动完成后将 `CLI_TOKEN` 置空并重启 Pod，关闭交换端点缩小攻击面。
- [ ] **步骤 10 · 开放同事注册**：admin 登录 → 设置 → 邀请，生成邀请链接分发（月配额 30）；或直接依赖 `EMAIL_SIGNUP_ALLOWED_DOMAINS` 公司域名自助注册（仍需 admin 转验证链接）。钉钉/GitHub 登录按 §2.3 登记后随 Secret 启用。
- [ ] **步骤 11 · 功能冒烟**：网页登录 → 新建会话发一条消息（验证 SSE 流式）→ 建一个绑定 git 仓库的 agent 跑一次小任务（验证 workspace/git 守卫/审批门）。

---

## 5. 日常运维

### 5.1 版本发布与回滚

- **发布**：合并 master → Jenkins 自动全流程。镜像 tag 含 git sha，不可变。
- **回滚**：`kubectl -n donger rollout undo deployment/donger`（或 Rancher UI）。秒级。
- **跨版本回滚注意**：`migrate()` 只前向（建表/加列），旧镜像读新 schema 通常无感（按列名读写），但发布说明中应记录 schema 变更项，跨多版本回滚前先核对 `sqlite-*-store.ts` 的 migrate 增量。

### 5.2 配置变更

| 变更类型 | 操作 | 生效方式 |
|---|---|---|
| ConfigMap（域名、白名单、预置模型等） | `kubectl -n donger edit configmap donger-config` | `kubectl -n donger rollout restart deployment/donger` |
| Secret（平台 key、密钥——**三大密钥除外**） | edit secret 同上 | rollout restart |
| 仅改镜像 | 流水线自动 / `kubectl set image` | 自动（Recreate：先杀旧再起新） |

### 5.3 备份与恢复

- 备份 CronJob 每日 02:00 整库 `.backup`（**含 `app_config` 密钥表**——恢复时整库还原，凭证/模型 key 才能解开）到 `donger-backup` PVC。
- **恢复**：停写 → 用备份文件覆盖 `donger-data` PVC 中的 `donger.db` → 重启 Pod：
  ```bash
  kubectl -n donger scale deployment/donger --replicas=0
  # 通过工具 Pod 挂载 donger-data，将 donger-YYYY-MM-DD.db 覆盖 /app/data/donger.db（连同 donger.lock 删除）
  kubectl -n donger scale deployment/donger --replicas=1
  ```
- 备份 PVC 数据应定期同步到集群外（NFS 快照 / 对象存储 / Rancher PV 备份），单一 PVC 不构成灾备。

### 5.4 日志与监控

- 日志：`kubectl -n donger logs deploy/donger -f`（pino 结构化 JSON）或 Rancher UI；审计明细在 Web 管理面「LLM 观测/审计」页（落 `audit_events` 表）。
- 观察 Pod 内存：agent 并发任务波动大，接近 4Gi limit 会 OOMKill（liveness 会拉起，进行中任务由重启清扫 `sweepInterruptedTasks` 标记收尾）——频繁 OOM 则调高 limit。

---

## 6. 故障排查速查

| 症状 | 根因 | 处置 |
|---|---|---|
| Pod 起不来，日志无「donger 启动」 | `ANTHROPIC_BASE_URL/AUTH_TOKEN` 缺失（zod 必填，启动即退） | 检查 `donger-secret` 两键 |
| CrashLoop：`Could not locate bindings file` | better-sqlite3 二进制与节点架构不符（跨架构拷镜像） | 在目标架构上重新构建镜像 |
| 起第二个副本失败/锁等待 | 违反单实例约束（误扩副本） | `replicas` 回 1；确认 `strategy: Recreate` |
| 对话流式输出卡顿/整段一起出 | Ingress 未关缓冲 | 确认 `proxy-buffering: "off"` |
| 长审批/长任务中途断流 | Ingress 读写超时默认 60s | 确认两个 timeout=3600 |
| 钉钉/GitHub 回调 404 或 redirect_uri 报错 | env 值与平台后台登记不一致，或 `PUBLIC_BASE_URL` 未配 | 两侧逐字比对；确认 PUBLIC_BASE_URL |
| 全站注册/登录偶发 429 | `TRUST_PROXY=false` 时限流按 Ingress IP 全站共享 | 内网人少可接受；否则确认 XFF 行为后开 true |
| 库内 git 凭证/模型 key 解密失败 | `SECRET_KEY` 被改动 | 恢复原值（或整库从备份恢复） |
| agent 执行 Bash 工具报 `No suitable shell found` | 镜像未设 `SHELL`：Docker 不为容器进程设该变量，主进程直接是 node 时 CLI 定位不到 POSIX shell | Dockerfile 运行阶段加 `ENV SHELL=/bin/bash`（§3.1 已含）；本地可复现验证：`docker run --rm --entrypoint node node:20-slim -e 'console.log(process.env.SHELL)'` 输出 undefined |
| 登录态全失效 | `JWT_SECRET` 被改动 | 恢复原值；全员重登 |
| LLM 调用超时/连接失败 | Pod 出网到 open.bigmodel.cn 被拦 | §4 步骤 8 探测；检查集群 egress/NAT |
| 新 Pod 起不来报锁 | 旧 Pod 残留 `donger.lock`（罕见 pid 复用误判） | 确认旧 Pod 已终止；锁有 pid 存活探测会自动接管，等待一个探测周期 |

---

## 附录 A：环境变量速查（`src/config.ts` 全量对齐）

### 必配（缺失启动失败）
| 变量 | 说明 |
|---|---|
| `ANTHROPIC_BASE_URL` | 智谱 Anthropic 兼容端点（`https://open.bigmodel.cn/api/anthropic`） |
| `ANTHROPIC_AUTH_TOKEN` | 智谱 API Key |

### 强烈建议显式配置
| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | 空（推导 host:port，0.0.0.0 下不可用） | 对外正式地址，OAuth 回调基准 |
| `JWT_SECRET` / `SECRET_KEY` | 首启随机生成并落 `app_config` | K8s 场景显式固定，永不轮换 |
| `ADMIN_EXTERNAL_IDS` | 空 | 管理员白名单：裸 externalId 或 `provider:externalId`；邮箱用户 externalId=邮箱原文 |
| `BUILTIN_SKILLS_DIR` | `<REPO_ROOT>/skills` | 容器内必须显式 `/app/skills`（默认落在 PVC 内不存在的路径） |
| `DB_PATH` / `WORKSPACE_DIR` / `MEMORY_DIR` / `REPO_ROOT` | `~/.donger/...` | 部署统一 `./data/*`（挂 PVC） |
| `EMAIL_SIGNUP_ALLOWED_DOMAINS` | 空=仅邀请注册 | 公司邮箱域名，子域通配（`.corp.cn`） |
| `TRUST_PROXY` | false | Ingress 后取真实 IP 限流（§3.4 注） |

### 可选功能
| 变量 | 启用条件 |
|---|---|
| `DINGTALK_APP_KEY/APP_SECRET/ROBOT_CODE` | 三者齐全启用钉钉；`DINGTALK_CARD_TEMPLATE_ID` 选配流式卡片；`DINGTALK_LOGIN_REDIRECT_URI` 回调覆盖 |
| `GITHUB_CLIENT_ID/CLIENT_SECRET` | 两者齐全启用 GitHub OAuth；`GITHUB_LOGIN_REDIRECT_URI` 回调覆盖；`GITHUB_OAUTH_PROXY` 代理出网 |
| `CLI_TOKEN` | 非空启用 `POST /api/auth/exchange`（身份 internal/cli-admin，权限靠白名单） |
| `AGENT_LLM_PRESETS` | agent 模板可选模型下拉：`name\|model\|baseUrl` 分号分隔，token 复用全局 |

### 行为调优（默认值可不动）
`PORT=3330`、`HOST=0.0.0.0`、`LLM_MODEL=glm-4.6`、`LOG_LEVEL=info`、`JWT_TTL_DAYS=30`、`GIT_ALLOW_PRIVATE_HOSTS=true`（内网 Git 必须保持）、`GIT_CLONE_TIMEOUT_MS=120000`、`GIT_AUTH_CACHE_TTL_MS=600000`、`CALLBACK_RATE_LIMIT_PER_MIN=10`、`TURN_STALL_TIMEOUT_MS=600000`（生产建议 0，见 §3.4）、`SESSION_IDLE_ROLL_HOURS=168`。

## 附录 B：与单机部署（deploy.ps1 / deploy.sh）的差异

- 单机脚本自动生成的 `.env` 继承清单**缺** `ADMIN_EXTERNAL_IDS`、`HTTPS_*`、`PUBLIC_BASE_URL`、`GITHUB_*`、`EMAIL_SIGNUP_ALLOWED_DOMAINS` 等十余键，且 `deploy.sh` 先 `--production` 安装导致 `npm run build` 必失败——K8s 方案不依赖这两个脚本，镜像构建顺序已在 Dockerfile 内修正。
- 单机版 TLS 在进程内（`HTTPS_CERT_PATH`）；K8s 版 TLS 在 Ingress，进程内纯 HTTP，证书换发不动镜像。
- 单机版升级手工重跑脚本且会清 `data/`；K8s 版数据在 PVC，升级只换镜像。
