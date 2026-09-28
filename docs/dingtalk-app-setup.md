# donger 钉钉应用配置手册（运维操作指南）

> 适用版本：master（2026-09-20，基于 e0bf52d 源码核实，所有 API/字段均与代码对齐）。
> 读者：负责在钉钉开放平台创建与配置应用的运维人员。
> 关系：本文档是 [deploy-k8s-jenkins.md](./deploy-k8s-jenkins.md) §3.5 Secret 中钉钉五项配置的**前置操作**；单机部署同样适用。
> 界面路径以钉钉开放平台当前版本为准，若改版请按名称在平台内搜索。

---

## 1. 能力总览：donger 用钉钉做什么

| 能力 | 作用 | 消息模式 | 是否需要公网回调 | 配置项 |
|---|---|---|---|---|
| **企业机器人通道** | 员工在钉钉私聊机器人 ↔ donger 对话、任务审批 | **Stream 模式**（服务器出站 WebSocket 长连接，`dingtalk-stream` SDK） | **否**（纯内网可部署） | `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` / `DINGTALK_ROBOT_CODE` |
| **扫码登录** | Web 登录页钉钉扫码 → OAuth2 回调换 JWT | HTTP 重定向回调 | 是（浏览器可达即可） | 复用 AppKey/Secret + `DINGTALK_LOGIN_REDIRECT_URI` |
| AI 卡片流式回复 | 机器人回复以卡片流式渲染 | HTTP API | — | `DINGTALK_CARD_TEMPLATE_ID` —— **当前版本预留未接线，无需配置**（见 §7） |

**启用条件（代码逻辑）**：`DINGTALK_APP_KEY + APP_SECRET + ROBOT_CODE` 三者**齐全**钉钉通道才启用；任一缺失整个通道（含扫码登录）不加载。扫码登录回调地址：显式 `DINGTALK_LOGIN_REDIRECT_URI` 优先，未配置则按 `PUBLIC_BASE_URL` → `HOST:PORT` 推导（K8s 部署**必须显式配置**）。

消息流向（全部出站，服务器只需能访问钉钉域名）：

```
收消息：钉钉云 ←wss长连接← donger（Stream 模式，无需任何入站端口）
发消息：donger → POST api.dingtalk.com/v1.0/robot/oToMessages/batchSend
换token：donger → GET oapi.dingtalk.com/gettoken（appKey/appSecret 换企业 access_token，2h 缓存）
扫码登录：浏览器 → login.dingtalk.com 扫码 → 302 跳回 https://<域名>/api/auth/dingtalk/callback
```

---

## 2. 前置条件

- [ ] 拥有**钉钉企业管理员**权限（或可请管理员协作）：创建企业内部应用、申请权限点均需。
- [ ] 登录钉钉开放平台：https://open-dev.dingtalk.com/ （用企业管理员钉钉扫码登录）。
- [ ] donger 服务器可出网访问：`*.dingtalk.com:443`（含 WebSocket 升级）与 `oapi.dingtalk.com:443`。
- [ ] 已确定 donger 对外正式域名（如 `https://donger.corp.example.com`），扫码登录回调要用。
- [ ] **不需要**为机器人消息接收开放任何公网入站端口/回调 URL（Stream 模式）。

---

## 3. 步骤一：创建企业内部应用（获取 AppKey / AppSecret）

1. 开放平台首页 → **应用开发** → **企业内部开发** → **创建应用**（选择 H5 微应用形态即可；donger 不要求移动端形态）。
2. 填写应用名称（如 `donger`）、应用描述、图标，完成后进入应用详情。
3. 在 **凭证与基础信息** 页记录两个值：
   - **AppKey**（应用唯一标识，即 OAuth `client_id`）
   - **AppSecret**（应用密钥，**等同密码保管**，泄露需重置）
4. 基础信息中按需填写：应用描述、PC 端首页地址可填 `https://<donger域名>`（员工从工作台点进即打开 Web 端，可选）。

> 企业内部应用仅本企业可用，无需上架/审核发布；保存配置即对本企业生效。

---

## 4. 步骤二：添加机器人能力（获取 robotCode）

1. 应用详情 → 左侧 **添加应用能力**（或"应用能力"页）→ 开启 **机器人**。
2. 进入机器人配置页，记录 **robotCode**（机器人编码，发消息 API 必传）。部分版本 robotCode 与 AppKey 相同，以页面展示为准。
3. **消息接收模式：选择「Stream 模式」**（关键！donger 通过 `dingtalk-stream` SDK 出站长连接收消息）。
   - 不要选「HTTP 回调模式」——选了 donger 将收不到任何消息。
4. 机器人名称/头像按需配置（员工在钉钉里看到的名字）。

完成后，企业成员即可在钉钉客户端搜索应用名找到机器人发起私聊（消息能否被处理还取决于 §6 权限与 donger 侧配置）。

> 注意：donger 会**忽略无 `senderStaffId` 的消息**（未关联企业账号的临时会话）。机器人问答必须由本企业成员发起。

---

## 5. 步骤三：申请 API 权限

应用详情 → **权限管理** → 按下表逐项搜索并**申请开通**（部分权限需管理员审批）：

| donger 实际调用的 API（代码实锤） | 用途 | 需申请的权限点（名称以平台当前清单为准） |
|---|---|---|
| `GET oapi.dingtalk.com/gettoken` | appKey/appSecret 换企业 access_token | 凭证直换，无需单独权限点 |
| Stream `TOPIC_ROBOT` | 接收机器人私聊消息 | 开启机器人能力 + Stream 模式即具备 |
| `POST /v1.0/robot/oToMessages/batchSend` | 机器人单聊回复（文本/Markdown） | **企业内部机器人发送消息**（按"机器人/单聊/发送"关键字搜索） |
| `POST /v1.0/oauth2/userAccessToken` | 扫码授权码换用户 token | 扫码登录能力（`openid` / `corpid` scope） |
| `GET /v1.0/contact/users/me` | 获取扫码用户信息（nick/userId/头像） | **通讯录个人信息读权限**（Contact.User.Read / "成员信息"关键字） |

申请后若权限状态为"待审批"，请企业管理员在后台完成审批；权限变更后建议**保存/重新发布一次应用**确保生效。

---

## 6. 步骤四：配置扫码登录回调

donger 登录页发起的是钉钉**新版统一登录**（`https://login.dingtalk.com/oauth2/auth`，scope=`openid corpid`），回调路径固定为：

```
https://<donger对外域名>/api/auth/dingtalk/callback
```

1. 应用详情 → **登录与分享**（或「安全设置」→ 回调/重定向 URL，随平台版本命名略有差异）。
2. 在**登录回调/重定向 URL** 中登记上述完整地址（**与 donger 侧 `DINGTALK_LOGIN_REDIRECT_URI` 一字不差**——协议 https、域名、端口、路径全对齐）。
3. 若列表支持多条，只登记 donger 实际使用的这一个域名；测试环境与生产环境域名不同时应登记各自的回调。

> 此回调仅要求**用户浏览器可达**（浏览器在内网即可），不要求钉钉服务器反向访问 donger。

---

## 7. （预留说明）AI 卡片模板 —— 当前版本无需配置

代码中 `DINGTALK_CARD_TEMPLATE_ID` 与卡片 API（`/v1.0/card/instances/createAndDeliver`、`PUT /v1.0/card/instances`）已实现为工具函数（`src/util/dingtalk-api.ts`），但**通道层尚未接线**——当前机器人回复全部走文本/Markdown 单聊消息（`oToMessages/batchSend`）。

因此本版本：
- **不需要**在卡片平台创建模板，**不需要**申请卡片实例权限；
- Secret 中 `DINGTALK_CARD_TEMPLATE_ID` 留空即可；
- 后续版本接线时的模板规格（供提前了解）：模板变量须包含 `content`（Markdown 渲染区）、`title`、`lastMessage`、`config`（`{"autoLayout":true}`），投递模式 IM_ROBOT + STREAM 回调。

---

## 8. 步骤五：（视企业安全策略）服务器出口 IP 白名单

部分企业开启了 API 调用 IP 白名单（应用详情 → **安全设置** → 服务器出口 IP）：

- 若贵司启用：将 donger **Pod/服务器出网 IP**（K8s 集群 NAT 出口 IP）加入白名单；
- 未开启则跳过；
- 判断依据：调用 API 报 `errcode 60020`（ip 不在白名单）即需此步骤。

---

## 9. 步骤六：donger 侧配置与生效

把 §3~§6 拿到的值填入部署配置（K8s 见 [deploy-k8s-jenkins.md](./deploy-k8s-jenkins.md) §3.5 `donger-secret`；单机部署填 `.env`）：

```yaml
DINGTALK_APP_KEY: "<§3 的 AppKey>"
DINGTALK_APP_SECRET: "<§3 的 AppSecret>"
DINGTALK_ROBOT_CODE: "<§4 的 robotCode>"
DINGTALK_CARD_TEMPLATE_ID: ""                                          # 留空（预留未接线）
DINGTALK_LOGIN_REDIRECT_URI: "https://<域名>/api/auth/dingtalk/callback"  # 与 §6 登记一致
```

- K8s：`kubectl -n donger edit secret donger-secret` 后 `kubectl -n donger rollout restart deployment/donger`；
- 单机：改 `.env` 后重启服务；
- 启动日志确认：出现 `donger 启动 ... dingtalk:true`（index.ts:60 的启动横幅）即通道已加载；`dingtalk-stream` 连接失败会在日志持续报错。

---

## 10. 步骤七：验证清单

- [ ] **通道连接**：`kubectl -n donger logs deploy/donger --tail=100 | grep -i dingtalk`——无 connect 报错、无 gettoken 失败。
- [ ] **机器人对话**：钉钉客户端搜索应用名 → 私聊发送 `你好` → 收到 donger 回复（前提：`ANTHROPIC_AUTH_TOKEN` 已配且 LLM 可用）。
- [ ] **审批门**（绑定 git 仓库的 agent 执行发布类任务时）：机器人推送「🔔 审批门」消息 → 回复「通过」→ 任务继续。
- [ ] **扫码登录**：Web 登录页出现「钉钉扫码」入口（登录方式由 `/api/auth/methods` 按 Secret 动态渲染）→ 扫码 → 跳回 `https://<域名>/login/success` 并进入系统。
- [ ] **首次扫码用户**：登录成功后在 Web 端头像处确认昵称/头像来自钉钉（证明 `users/me` 权限生效）。

---

## 11. 故障排查速查

| 现象 | 根因 | 处置 |
|---|---|---|
| 日志无任何 dingtalk 内容 | 三项配置未齐全（缺一即整通道不加载） | 核对 AppKey/Secret/robotCode 三键 |
| `gettoken 失败: errcode 60104/...` | AppSecret 错误或应用被删除 | 重取凭证；Secret 转义问题（含特殊字符时确认未丢字符） |
| `errcode 60020 / ip not in white list` | 企业开了出口 IP 白名单 | §8 加入 Pod 出网 IP |
| Stream 反复断连/连不上 | Pod 无法出网 `*.dingtalk.com`（含 wss） | 检查集群 egress / NAT / 代理 |
| 机器人收到消息但 donger 日志显示「忽略无 senderStaffId」 | 发消息者非企业成员（外部临时会话） | 由本企业员工私聊机器人 |
| donger 收到消息但不回复 | LLM 未配通（token 缺失/出网拦） | 见部署手册 §4 步骤 8 的 LLM 连通验证 |
| 回复失败 `batchSend 403` | 发消息权限未申请/未生效 | §5 补申请并重新发布应用 |
| 扫码页报 client_id 无效 | AppKey 填错 | 核对 `DINGTALK_APP_KEY` |
| 扫码后跳 `login?error=登录会话已过期` | state 超时（5 分钟）或会话异常 | 重新点扫码按钮发起 |
| 扫码后报 redirect_uri 不匹配 | 平台登记与 `DINGTALK_LOGIN_REDIRECT_URI` 不一致 | 两侧逐字比对（协议/域名/端口/路径） |
| 扫码后报用户信息获取失败 | `users/me` 权限未开通 | §5 申请通讯录个人信息读权限 |
| 登录页没有钉钉入口 | 三项配置未齐全（methods 动态渲染） | 核对三键并重启 |

---

## 附录 A：钉钉身份与 donger 管理员白名单

扫码登录成功后，donger 以 `identity provider="dingtalk"`、**externalId = 钉钉员工 userId（staffId，企业内成员标识）** 建立账号（`web-channel.ts` 回调流程 + `user_identities` 表）。

要把某位钉钉用户设为 donger 管理员，在 ConfigMap/`.env` 的 `ADMIN_EXTERNAL_IDS` 中追加：

```
ADMIN_EXTERNAL_IDS=dingtalk:<staffId>          # 限定钉钉平台（推荐）
ADMIN_EXTERNAL_IDS=<staffId>                    # 裸 ID 对全平台生效（慎用，可能与邮箱用户撞名时无法区分）
```

staffId 获取方式（任选其一）：
1. 让该用户先扫码登录一次 donger，管理员在 Web 端「用户管理」查看其外部标识；
2. 钉钉管理后台（admin.dingtalk.com）→ 通讯录 → 成员详情中的 userId；
3. 通讯录导出。

修改后 rollout restart / 重启服务生效。

## 附录 B：代码依据索引（排障时对照源码）

| 行为 | 位置 |
|---|---|
| 三值齐全才启用通道 | `src/config.ts:221` |
| Stream 收消息 / 忽略无 senderStaffId / 审批回复正则 | `src/adapters/dingtalk-channel.ts:42-78`（通过/同意/确认/yes/y/ok/✅ 判定审批） |
| 企业 token 获取与缓存 | `src/util/dingtalk-api.ts:15`（gettoken，7200s 缓存） |
| 发消息体（sampleText / sampleMarkdownMsg） | `src/util/dingtalk-api.ts:200` |
| 扫码授权 URL 构造（scope=openid corpid） | `src/adapters/web-channel.ts:1625` |
| 回调换 token → 取用户信息 → 建账号 | `src/adapters/web-channel.ts:1631-1677`、`src/util/dingtalk-api.ts:94/149` |
| 登录回调地址解析（显式覆盖优先） | `src/adapters/web-channel.ts:1623` |
