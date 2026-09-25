import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { modelForRole, type RoleModel } from "../core/policy";
import { optionalText, receiptSchema } from "./routing-config";
import { ROUTING_PROVIDER } from "./routing-plan";

// OLW re-plans category and agent routes itself, and OMO skips an unknown retry candidate
// and clamps an unsupported reasoning level at runtime, so nothing here blocks a start.
// It only reports routes that cannot fall back or cannot run at all.
export interface ChainIssue {
  readonly path: string;
  readonly message: string;
}
export interface ChainReport {
  readonly catalog: number;
  readonly checked: number;
  readonly warnings: readonly ChainIssue[];
}

const entrySchema = z.union([z.string(), z.object({ model: z.string() }).passthrough()]);
const routeSchema = z
  .object({
    model: z.string().optional(),
    models: z.array(entrySchema).optional(),
    fallback_models: z.array(z.object({ provider: z.string(), model_id: z.string() })).optional(),
  })
  .passthrough();
const configSchema = z
  .object({
    categories: z.record(z.string(), routeSchema).default({}),
    agents: z.record(z.string(), routeSchema).default({}),
  })
  .passthrough();
const catalogSchema = z.object({ providers: z.record(z.string(), z.unknown()) });
const providerSchema = z.object({ models: z.array(z.object({ id: z.string().min(1) })) });

export function catalogModels(catalog: unknown): ReadonlySet<string> {
  const parsed = providerSchema.safeParse(catalogSchema.parse(catalog).providers[ROUTING_PROVIDER]);
  return new Set(parsed.success ? parsed.data.models.map((model) => model.id) : []);
}

export function checkChains(
  config: unknown,
  roles: readonly RoleModel[],
  catalog: ReadonlySet<string>,
  unroutable: readonly string[] = [],
): ChainReport {
  const groups = configSchema.parse(config);
  const warnings: ChainIssue[] = unroutable.map((path) => ({
    path,
    message: "no working model: no upstream choice is published by opencodex",
  }));
  let checked = 0;
  const usable = (qualified: string): string | undefined => {
    checked += 1;
    const prefix = `${ROUTING_PROVIDER}/`;
    if (!qualified.startsWith(prefix)) return undefined;
    const id = qualified.slice(prefix.length);
    return catalog.has(id) ? id : undefined;
  };
  for (const scope of ["categories", "agents"] as const) {
    for (const [name, route] of Object.entries(groups[scope])) {
      const references = [
        ...(route.model ? [route.model] : []),
        ...(route.models ?? []).map((entry) => (typeof entry === "string" ? entry : entry.model)),
        ...(route.fallback_models ?? []).map((model) => `${model.provider}/${model.model_id}`),
      ];
      // An agent without its own models inherits a category, which is reported on its own.
      if (references.length === 0 || unroutable.includes(`${scope}.${name}`)) continue;
      const working = new Set(
        references.map(usable).filter((id): id is string => id !== undefined),
      );
      if (working.size === 0)
        warnings.push({
          path: `${scope}.${name}`,
          message: "no working model: none of its models is in the opencodex catalog",
        });
      else if (working.size === 1)
        warnings.push({
          path: `${scope}.${name}`,
          message: `no fallback: only ${[...working][0]} is available`,
        });
    }
  }
  for (const role of roles)
    if (usable(`${role.provider}/${role.modelId}`) === undefined)
      warnings.push({
        path: `olw.role.${role.provider}/${role.modelId}`,
        message: "not in the opencodex catalog; the OLW role cannot start",
      });
  return { catalog: catalog.size, checked, warnings };
}

export async function readChainReport(paths: {
  readonly configPath: string;
  readonly catalogPath: string;
  readonly stateDir: string;
}): Promise<ChainReport> {
  const [config, catalog, receipt] = await Promise.all([
    readFile(paths.configPath, "utf8"),
    readFile(paths.catalogPath, "utf8"),
    optionalText(join(paths.stateDir, "state.json")),
  ]);
  const roles = [modelForRole("supervisor"), modelForRole("parent"), modelForRole("child")];
  return checkChains(
    Bun.JSON5.parse(config),
    roles.filter(
      (role, index) =>
        roles.findIndex(
          (other) => other.provider === role.provider && other.modelId === role.modelId,
        ) === index,
    ),
    catalogModels(JSON.parse(catalog)),
    receipt ? receiptSchema.parse(JSON.parse(receipt)).unroutable : [],
  );
}

export function summarizeChains(report: ChainReport): string | undefined {
  if (report.warnings.length === 0) return undefined;
  return `Model chain warnings: ${report.warnings
    .map((issue) => `${issue.path} (${issue.message})`)
    .join("; ")}`;
}
