import type { ModuleConfigStore } from "../ports/module-config-store.js";
import type { UserStore } from "../ports/user-store.js";

/**
 * setup_completed 标记补写（spec 2026-09-21-user-management-design §2.3，决策②）。
 *
 * 存量库（setup 功能上线前就有 admin）从未写过该标记，isSetupRequired 的第二条件
 * 长期为假候选——一旦 admin 被清零（DB 手术等绕过 UI 守卫的路径），零配置引导会重开，
 * 公开的 POST /api/setup/admin 可被任意访客抢占。启动时补写把这条数据面路径封死。
 *
 * 幂等：已有 admin 且无标记才写；无 admin（尚未引导）或已有标记均不动。
 * 返回是否补写（供启动日志）。
 */
export async function backfillSetupCompletedFlag(
  users: Pick<UserStore, "hasAnyAdmin">,
  configs: Pick<ModuleConfigStore, "getFlag" | "setFlag">,
): Promise<boolean> {
  if (!(await users.hasAnyAdmin())) return false;
  if (configs.getFlag("setup_completed")) return false;
  configs.setFlag("setup_completed", new Date().toISOString());
  return true;
}
