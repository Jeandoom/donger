// 主机执行策略 API client（specs/2026-10-12-host-exec-policy-design.md §8 M2 治理面）。
import { apiFetch } from "./auth";

export interface HostExecPolicyDTO {
  id: string;
  hostCode: string;
  tool: "*" | "host_exec" | "host_logs_clean";
  scopeKind: "global" | "agent" | "user" | "role";
  scopeRef?: string;
  matchKind: "prefix" | "pattern";
  matchValue: string;
  decision: "allow" | "ask" | "deny";
  unattended: "inherit" | "allow" | "skip";
  enabled: boolean;
  note?: string;
  createdBy?: string;
  createdAt: string;
}

export interface HostExecPolicyContextDTO {
  policies: HostExecPolicyDTO[];
  hosts: Array<{ code: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
}

export interface HostExecPolicyInput {
  hostCode: string;
  tool: "*" | "host_exec" | "host_logs_clean";
  scopeKind: "global" | "agent" | "user" | "role";
  scopeRef?: string;
  matchKind: "prefix" | "pattern";
  matchValue: string;
  decision: "allow" | "ask" | "deny";
  unattended: "inherit" | "allow";
  note?: string;
}

export async function fetchHostExecPolicies(): Promise<HostExecPolicyContextDTO> {
  const res = await apiFetch("/api/admin/host-exec-policies");
  if (!res.ok) throw new Error(`fetch policies ${res.status}`);
  return (await res.json()) as HostExecPolicyContextDTO;
}

export async function createHostExecPolicy(input: HostExecPolicyInput): Promise<HostExecPolicyDTO> {
  const res = await apiFetch("/api/admin/host-exec-policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { policy?: HostExecPolicyDTO; error?: string };
  if (!res.ok) throw new Error(data.error ?? `create policy ${res.status}`);
  return data.policy!;
}

export async function updateHostExecPolicy(
  id: string,
  input: HostExecPolicyInput,
): Promise<HostExecPolicyDTO> {
  const res = await apiFetch(`/api/admin/host-exec-policies/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { policy?: HostExecPolicyDTO; error?: string };
  if (!res.ok) throw new Error(data.error ?? `update policy ${res.status}`);
  return data.policy!;
}

export async function deleteHostExecPolicy(id: string): Promise<void> {
  const res = await apiFetch(`/api/admin/host-exec-policies/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete policy ${res.status}`);
}

export async function setHostExecPolicyEnabled(id: string, enabled: boolean): Promise<void> {
  const res = await apiFetch(`/api/admin/host-exec-policies/${id}/enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`toggle policy ${res.status}`);
}

export async function fetchSshEgressMode(): Promise<"ask" | "deny"> {
  const res = await apiFetch("/api/admin/ssh-egress-mode");
  if (!res.ok) throw new Error(`fetch ssh-egress ${res.status}`);
  const data = (await res.json()) as { mode: "ask" | "deny" };
  return data.mode;
}

export async function putSshEgressMode(mode: "ask" | "deny"): Promise<void> {
  const res = await apiFetch("/api/admin/ssh-egress-mode", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`put ssh-egress ${res.status}`);
}
