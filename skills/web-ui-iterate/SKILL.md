---
name: web-ui-iterate
description: donger Web UI 渐进式迭代升级：每轮执行「清扫发现未重制件 → Penpot 补设计图 → 代码实现 → 质量门禁 + e2e 验证 → 提交部署」闭环，一轮一个 commit，直到旧样式指标清零。适用于定时巡检式 UI 升级与"继续重设计"类任务。
---

# Web UI 迭代升级（web-ui-iterate）

> 工作目录：`D:\code\donger`，前端子包 `web/`。设计稿在 Penpot「logo」页（DS 设计体系板 + P01-P19 屏板）。
> 本技能是**循环执行**的：每次调用执行一轮；当第 1 步清扫全部指标为零时，本轮直接输出"无未重制件"并结束。

## 步骤

### 1. 清扫（找）
用五类 grep 指标判定是否存在未重制件，全部命中数为 0 则本轮无事可做：

```bash
cd web
grep -rn "window.confirm\|window.alert" src --include=*.tsx        # 原生弹窗
grep -rn "hover:bg-accent\|bg-accent\b" src --include=*.tsx | grep -v accent-foreground
grep -rn "bg-yellow-\|text-yellow-\|bg-red-50\|text-red-7" src --include=*.tsx
grep -rn "rounded-md border px\|rounded border px\|bg-background shadow\|rounded-lg bg-background" src --include=*.tsx  # 旧边框/弹窗底
grep -rn "✨\|📄\|🤖\|📱\|🔵\|✅\|⚠\|●" src --include=*.tsx        # emoji 占位图标
```

辅以浏览器目检：起服务后用 control-browser 逐页截图/DOM 校验（无横向溢出、无崩溃文案、深色侧边栏 `rgb(15,23,42)`）。
产出：未重制件清单（文件:行 + 问题归类）。

### 2. Penpot 设计（画）
- 对每个新发现的页面/控件补一张屏板（1440×900，命名 `P{nn} · 名称`，接在已有 P 板之后）；纯控件改动可并入合集板。
- 设计 token 速查（与 `web/src/index.css` 一一对应）：
  - 色：墨黑侧边栏 `#0F172A` / hover `#1E293B` / 主色靛蓝 `#4F46E5` / soft `#EEF2FF` / 内容区 `#F8FAFC` / 卡片 `#FFF` / 描边 `#E2E8F0` / 次文字 `#64748B` / 成功 `#10B981`(soft `#ECFDF5`) / 警告 `#FBBF24`(soft `#FFFBEB`) / 危险 `#EF4444`(soft `#FEF2F2`)
  - 字阶：22/700 页标题、16/600 区块、14/600 卡标题、13 正文按钮、12 辅助、11 徽章
  - 形：卡片圆角 12(`rounded-xl`)、按钮/输入 8(`rounded-lg`)、徽章 999；阴影 `0 2px 8px rgba(15,23,42,0.06)`
  - 组件：primary(靛底白字)/secondary(白底描边)/danger(浅红底红字) 按钮；六 tone 徽章；PageHeader=左标题描述右操作
- 插件坑（必读）：标签页挂起需用户手动聚焦恢复；storage 可能重置需重建 helper（rect/board/text 创建后必须手动 `appendChild`；flex 对齐值用 `start/end`；只能画当前激活页）；execute_code 30s 超时但往往已执行完——先查状态再决定是否重画。

### 3. 代码实现（改）
- 全部样式走 `web/tailwind.config.ts` 已注册 token（`bg-card`/`bg-primary-soft`/`bg-success-soft`/`bg-warning-soft`/`bg-destructive-soft`/`bg-sidebar*`/`text-muted-foreground`），禁止裸 hex 与语义化前旧类。
- 复用 `web/src/components/ui/`：`Button`(default/secondary/ghost/danger)、`Badge`(六 tone)、`Card`、`Input`、`PageHeader`、`ConfirmDialog`、`Switch`。
- 列表页骨架：`mx-auto max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7` + PageHeader + 搜索/筛选行 + 卡片栅格(`grid sm:grid-cols-2 xl:grid-cols-3`) 或 Card 表格（表头 `bg-muted/60 text-xs`）+ 虚线空态。
- 原生 `confirm/alert` 一律替换：确认→ConfirmDialog（pendingDelete 状态模式，参考 AgentsPage）；结果反馈→页内通知横幅（success-soft/destructive-soft）。
- 最小 diff，逐文件 patch；不改业务逻辑与 API 层。

### 4. 验证（验）
```bash
npm --prefix web run lint && cd web && npx tsc --noEmit && npm test && npm run build
```
80 个 vitest 必须全绿；e2e 用 control-browser：
1. `CLI_TOKEN`（根 .env）POST `/api/auth/exchange` 换 JWT，注入 `localStorage.donger_jwt`；
2. **先注销 Service Worker 并清 caches**（PWA 会缓存旧构建，否则验证的是旧 UI）；
3. 逐路由检查渲染/溢出/崩溃 + 本轮改动点的交互验证；
4. playwright click 易挂起，优先 `evaluate(() => el.click())` 或直接 goto。

### 5. 提交与部署
- 分支 `feat-20260912-web-sweep-controls` 式命名（`feat-{yyyyMMdd}-{≤6 词}`），commit 用 `feat(web): 中文简述`。
- 合入 master 与 push 需用户当轮明示（历史上常用语：「合并master并推送」「部署吧」）；部署 = `npm run build`（根）→ 杀 3300 进程树 → 根目录 `npm start` → `/api/health` 200 + 浏览器抽查。
- 每轮一个 commit，便于回溯与回滚。

## 约束

- 只动 `web/`（含其测试）；后端、CLI、Penpot 已有板禁止顺手改。
- 渐进语义：一轮只消化清扫发现的一批（≤20 文件），不做大爆炸重写；发现未纳入设计的全新交互模式时先补 Penpot 图再写码。
- 验证不过不提交；生产部署仅在被要求时执行。
- 本轮结束必须在回复中给出：清扫计数（五类指标命中数）、本轮改动清单、验证结果。
