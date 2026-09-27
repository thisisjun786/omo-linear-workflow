import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function questionRecipient(
  senderRole: Binding["assignment"]["role"],
  existing: DeliveryRecord | null,
  owner: Binding | null,
): string | null {
  if (existing !== null) return existing.envelope.toBindingId;
  if (owner === null || owner.launchState !== "ready") return null;
  if (senderRole === "parent" && owner.contactState !== "active") return null;
  return owner.id;
}

export function initializationMessageId(bindingId: string): string {
  return `initialization:${bindingId}`;
}

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface RoleModel {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: z.infer<typeof thinkingLevelSchema>;
}

const managerSettingsSchema = z.object({
  defaultProvider: z.string().min(1),
  defaultModel: z.string().min(1),
  defaultThinkingLevel: thinkingLevelSchema.optional(),
  modelThinkingLevels: z.record(z.string(), thinkingLevelSchema).optional(),
});

export interface ManagerModelResolution {
  readonly model: RoleModel;
  readonly source: "settings" | "fallback_no_default";
}

export class ManagerSettingsError extends Error {
  readonly code = "manager_settings_error";
  constructor(
    message: string,
    readonly settingsPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagerSettingsError";
  }
}

const managerFallback: RoleModel = {
  provider: "opencodex",
  modelId: "anthropic/claude-opus-5-5",
  thinking: "medium",
};

/** Match pinned Senpi's JSONC semantics without loading its complete runtime into OLW workers. */
function parseSettingsJson(content: string): Record<string, unknown> {
  const text = content.replace(/^\uFEFF/, "");
  const normalized: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (inString) {
      normalized.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized.push(char);
      continue;
    }
    if (char === "/" && next === "/") {
      normalized.push(" ", " ");
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        normalized.push(" ");
        index += 1;
      }
      if (index < text.length) normalized.push(text[index] ?? "");
      continue;
    }
    if (char === "/" && next === "*") {
      normalized.push(" ", " ");
      index += 2;
      let closed = false;
      for (; index < text.length; index += 1) {
        if (text[index] === "*" && text[index + 1] === "/") {
          normalized.push(" ", " ");
          index += 1;
          closed = true;
          break;
        }
        normalized.push(text[index] === "\n" || text[index] === "\r" ? (text[index] ?? "") : " ");
      }
      if (!closed) throw new SyntaxError("Unterminated block comment in settings");
      continue;
    }
    normalized.push(char);
  }
  inString = false;
  escaped = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== ",") continue;
    let nextIndex = index + 1;
    while (nextIndex < normalized.length && /\s/.test(normalized[nextIndex] ?? "")) nextIndex += 1;
    if (normalized[nextIndex] === "}" || normalized[nextIndex] === "]") normalized[index] = " ";
  }
  const parsed: unknown = JSON.parse(normalized.join(""));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError("Settings must contain a JSON object");
  return z.record(z.string(), z.unknown()).parse(parsed);
}

export function resolveManagerModel(
  settingsPath = join(homedir(), ".omo/agent/settings.json"),
): ManagerModelResolution {
  let settingsText: string;
  try {
    settingsText = readFileSync(settingsPath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { model: managerFallback, source: "fallback_no_default" };
    throw new ManagerSettingsError(
      `Could not read manager settings: ${String(cause)}`,
      settingsPath,
      {
        cause,
      },
    );
  }
  let settingsValue: unknown;
  try {
    settingsValue = parseSettingsJson(settingsText);
  } catch (cause) {
    throw new ManagerSettingsError(
      `Could not parse manager settings: ${String(cause)}`,
      settingsPath,
      {
        cause,
      },
    );
  }
  const object = z.record(z.string(), z.unknown()).safeParse(settingsValue);
  if (!object.success)
    throw new ManagerSettingsError("Manager settings must be a JSON object", settingsPath, {
      cause: object.error,
    });
  if (!("defaultModel" in object.data))
    return { model: managerFallback, source: "fallback_no_default" };
  const settings = managerSettingsSchema.safeParse(object.data);
  if (!settings.success)
    throw new ManagerSettingsError("Manager default model settings are invalid", settingsPath, {
      cause: settings.error,
    });
  const modelKey = `${settings.data.defaultProvider}/${settings.data.defaultModel}`;
  return {
    model: {
      provider: settings.data.defaultProvider,
      modelId: settings.data.defaultModel,
      thinking:
        settings.data.modelThinkingLevels?.[modelKey] ??
        settings.data.defaultThinkingLevel ??
        "medium",
    },
    source: "settings",
  };
}

export function modelForLaunch(
  role: Assignment["role"],
  stage: ChildStage | null,
  settingsPath = join(homedir(), ".omo/agent/settings.json"),
): RoleModel {
  if (role === "manager") return resolveManagerModel(settingsPath).model;
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

/** Static opencodex model references whose catalog health affects OLW role launches. */
export const OLW_ROLE_MODELS: Readonly<Record<string, string>> = {
  supervisor: "gpt-6-astra",
  parent: "anthropic/claude-opus-5-5",
  "child.plan": "anthropic/claude-fable-5-1",
  "child.execute": "anthropic/claude-opus-5-5",
  child: "anthropic/claude-opus-5-5",
};

const seedEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("model_change"),
    provider: z.string(),
    modelId: z.string(),
  }),
  z.object({
    type: z.literal("thinking_level_change"),
    thinkingLevel: thinkingLevelSchema,
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
  if (binding.assignment.role === "manager")
    return (
      identity.durableSessionId === binding.durableSessionId &&
      identity.sessionPath === binding.sessionPath &&
      identity.cwd === binding.cwd
    );
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
