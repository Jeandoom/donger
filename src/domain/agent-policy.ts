import type { Agent } from "./agent.js";

type Actor = { id: string; role: "admin" | "user" };

export function canManageAgent(agent: Agent, user: Actor): boolean {
  return user.role === "admin" || agent.ownerId === user.id;
}

export function canUseAgent(agent: Agent, user: Actor, isGranted: boolean): boolean {
  return canManageAgent(agent, user) || isGranted;
}
