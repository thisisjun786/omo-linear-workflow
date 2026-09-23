import type { Assignment, Binding, RuntimeIdentity } from "./contracts";

export function initializationMessageId(bindingId: string): string {
  return `initialization:${bindingId}`;
}

export interface RoleModel {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: "high" | "max" | "xhigh";
}

export function modelForRole(role: Assignment["role"]): RoleModel {
  if (role === "supervisor")
    return { provider: "chatgpt-subscription", modelId: "gpt-6-astra", thinking: "high" };
  if (role === "parent") return { provider: "kimi-coding", modelId: "k3", thinking: "max" };
  return { provider: "anthropic-subscription", modelId: "claude-opus-5", thinking: "xhigh" };
}

export function matchesRuntime(binding: Binding, identity: RuntimeIdentity): boolean {
  const expected = modelForRole(binding.assignment.role);
  return (
    identity.durableSessionId === binding.durableSessionId &&
    identity.sessionPath === binding.sessionPath &&
    identity.cwd === binding.cwd &&
    identity.provider === expected.provider &&
    identity.modelId === expected.modelId &&
    identity.thinking === expected.thinking
  );
}
