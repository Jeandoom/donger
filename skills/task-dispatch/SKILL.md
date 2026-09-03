---
name: task-dispatch
description: 任务分发：阅读任务管理知识库（agents.md / routing-rules.md），把用户任务路由给最合适的执行智能体，并按输出契约返回路由 JSON。仅做路由判断，不执行任务。
---

# 任务分发

## 步骤

1. 用 Glob 列出「任务管理知识库」扩展目录下的全部文件，并 Read 每个文件。
2. 按 routing-rules.md 的规则判定任务类型（taskType）与是否需要方案设计确认（requiresDesign）。
3. 在 agents.md 登记表中选定唯一 agentId；无匹配时按规则第 1 条处理。
4. 按系统提示中的输出契约，在最终回复末尾输出路由 JSON。

## 约束

- 只读操作（Read / Glob），不执行任务本身。
- 不确定时宁可输出 requiresDesign=true 并在 rationale 说明，由人工在方案门兜底。
