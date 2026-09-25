import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { modelForRole, type RoleModel } from "../core/policy";
import { optionalText } from "./routing-config";
import { ROUTING_PROVIDER } from "./routing-plan";

const isProxyModel = (qualified: string) =>
  qualified.slice(0, qualified.indexOf("/")) === ROUTING_PROVIDER;

export const scopePreferenceSchema = z.object({ mode: z.enum(["all", "referenced"]) });
const modelEntrySchema = z.union([z.string(), z.object({ model: z.string() })]);
const routeSchema = z.object({
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  fallback_models: z.array(z.object({ provider: z.string(), model_id: z.string() })).optional(),
});
const routeGroupsSchema = z.object({
  categories: z.record(z.string(), routeSchema).default({}),
  agents: z.record(z.string(), routeSchema).default({}),
  model_profiles: z.record(z.string(), routeSchema).default({}),
});
const scopeSettingsSchema = z.object({
  defaultProvider: z.string().default(ROUTING_PROVIDER),
  defaultModel: z.string().optional(),
  favoriteModels: z.array(z.string()).optional(),
  compaction: z.object({ model: z.string().optional() }).optional(),
  lookAt: z.object({ models: z.array(modelEntrySchema).optional() }).optional(),
  retry: z
    .object({
      fallbackChains: z.record(z.string(), z.array(modelEntrySchema)).optional(),
    })
    .optional(),
});

export function referencedModels(
  config: unknown,
  settings: unknown,
  roles: readonly RoleModel[],
): string[] {
  const groups = routeGroupsSchema.parse(config);
  const tuning = scopeSettingsSchema.parse(settings);
  const models = new Set<string>();
  const add = (model: string | undefined) => {
    if (!model) return;
    const qualified = model.includes("/") ? model : `${tuning.defaultProvider}/${model}`;
    if (isProxyModel(qualified)) models.add(qualified);
  };
  const addEntry = (entry: z.infer<typeof modelEntrySchema>) =>
    add(typeof entry === "string" ? entry : entry.model);
  for (const group of Object.values(groups)) {
    for (const route of Object.values(group)) {
      add(route.model);
      route.models?.forEach(addEntry);
      for (const model of route.fallback_models ?? []) add(`${model.provider}/${model.model_id}`);
    }
  }
  add(tuning.defaultModel);
  add(tuning.compaction?.model);
  tuning.lookAt?.models?.forEach(addEntry);
  tuning.favoriteModels?.forEach(add);
  for (const [model, fallbacks] of Object.entries(tuning.retry?.fallbackChains ?? {})) {
    // Bare empty-chain keys also serve as native-fallback guards, not selections.
    if (model.includes("/")) add(model);
    fallbacks.forEach(addEntry);
  }
  for (const role of roles) add(`${role.provider}/${role.modelId}`);
  return [...models].sort();
}

export async function readReferencedModels(
  configPath: string,
  settingsPath: string,
): Promise<string[]> {
  const [config, settings] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(settingsPath, "utf8"),
  ]);
  return referencedModels(Bun.JSON5.parse(config), JSON.parse(settings), [
    modelForRole("supervisor"),
    modelForRole("parent"),
    modelForRole("child"),
  ]);
}

export async function modelScopeArguments(
  home: string,
  flags: readonly string[],
): Promise<string[]> {
  if (flags.some((flag) => flag === "--models" || flag.startsWith("--models="))) return [];
  const text = await optionalText(join(home, ".omo/proxy-routing/model-scope.json"));
  if (!text || scopePreferenceSchema.parse(JSON.parse(text)).mode === "all") return [];
  const settingsPath = join(home, ".omo/agent/settings.json");
  const models = await readReferencedModels(join(home, ".omo/omo.jsonc"), settingsPath);
  const selectedIndex = flags.findIndex((flag) => flag === "--model" || flag === "-m");
  const selected = selectedIndex >= 0 ? flags[selectedIndex + 1] : undefined;
  if (selected) {
    const { defaultProvider } = scopeSettingsSchema.parse(
      JSON.parse(await readFile(settingsPath, "utf8")),
    );
    const qualified = selected.includes("/") ? selected : `${defaultProvider}/${selected}`;
    if (isProxyModel(qualified) && !models.includes(qualified)) models.push(qualified);
  }
  return ["--models", models.join(",")];
}
