import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Assignment, Binding, ChildStage, DeliveryRecord, RuntimeIdentity } from "./contracts";

export function canRetryDelivery(record: DeliveryRecord): boolean {
  return (
    record.envelope.kind !== "operational_notice" &&
    record.state === "rejected" &&
    record.receipt?.kind === "error" &&
    record.receipt.error.code === "turn_conflict_before_delivery"
  );
}

export function initializationMessageId(bindingId: string): string {
  return `initialization:${bindingId}`;
}

export interface RoleModel {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: "medium" | "high" | "max" | "xhigh";
}

export function modelForLaunch(role: Assignment["role"], stage: ChildStage | null): RoleModel {
  if (role === "supervisor")
    return { provider: "opencodex", modelId: "gpt-6-astra", thinking: "high" };
  if (role === "parent")
    return { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "xhigh" };
  if (stage === "plan")
    return { provider: "opencodex", modelId: "anthropic/claude-fable-5-1", thinking: "xhigh" };
  if (stage === "execute")
    return { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "medium" };
  return { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "xhigh" };
}

export function modelForRole(role: Assignment["role"]): RoleModel {
  return modelForLaunch(role, null);
}

const seedEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("model_change"),
    provider: z.string(),
    modelId: z.string(),
  }),
  z.object({
    type: z.literal("thinking_level_change"),
    thinkingLevel: z.enum(["medium", "high", "max", "xhigh"]),
  }),
]);

function seededModel(sessionPath: string): RoleModel | null {
  if (!existsSync(sessionPath)) return null;
  let provider: string | undefined;
  let modelId: string | undefined;
  let thinking: RoleModel["thinking"] | undefined;
  for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const parsed = seedEntrySchema.safeParse(JSON.parse(line));
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.type === "model_change" && provider === undefined && modelId === undefined) {
      provider = entry.provider;
      modelId = entry.modelId;
    }
    if (entry.type === "thinking_level_change" && thinking === undefined) {
      thinking = entry.thinkingLevel;
    }
    if (provider !== undefined && modelId !== undefined && thinking !== undefined) {
      return { provider, modelId, thinking };
    }
  }
  return null;
}

export function modelForBinding(binding: Binding): RoleModel {
  return binding.sessionPath === null
    ? modelForRole(binding.assignment.role)
    : (seededModel(binding.sessionPath) ?? modelForRole(binding.assignment.role));
}

export function matchesRuntime(binding: Binding, identity: RuntimeIdentity): boolean {
  const expected = modelForBinding(binding);
  return (
    identity.durableSessionId === binding.durableSessionId &&
    identity.sessionPath === binding.sessionPath &&
    identity.cwd === binding.cwd &&
    identity.provider === expected.provider &&
    identity.modelId === expected.modelId &&
    identity.thinking === expected.thinking
  );
}
