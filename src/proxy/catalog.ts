import {
  type Candidate,
  DiscoveryError,
  type NativeCost,
  type ProxyModelConfig,
  toModel,
} from "./model";

export { DiscoveryError, type NativeCost } from "./model";

export const DEFAULT_CHANNELS = [
  "codex",
  "claude",
  "kimi",
  "xai",
  "devin",
  "meta",
  "gemini",
  "vertex",
  "aistudio",
  "antigravity",
] as const;

import type { Api, Model } from "./engine";
import {
  type Alias,
  type AvailableModel,
  aliasesSchema,
  availableListSchema,
  type Compatibility,
  compatibilitySchema,
  type Definition,
  definitionsSchema,
} from "./schema";

export interface CatalogDiscoveryOptions {
  clientBaseUrl: string;
  clientKey: string;
  managementUrl: string;
  managementKey: string;
  nativeCosts: ReadonlyMap<string, NativeCost>;
  nativeModels?: readonly Model<Api>[] | (() => Promise<readonly Model<Api>[]>);
  channels: readonly string[];
  fetch?: typeof fetch;
}

function endpoint(base: string, path: string): string {
  const url = new URL(base);
  return new URL(path, `${url.protocol}//${url.host}`).toString();
}

function clientModelsEndpoint(base: string): string {
  return `${base.replace(/\/$/, "")}/models`;
}

async function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  key: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${key}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new DiscoveryError(`${new URL(url).pathname} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new DiscoveryError(`${new URL(url).pathname} returned invalid JSON`);
  }
}

function parseAvailable(payload: unknown): AvailableModel[] {
  return availableListSchema.parse(payload).data;
}

function parseDefinitions(payload: unknown): Definition[] {
  return definitionsSchema.parse(payload).models;
}

function parseCompatibility(payload: unknown): Compatibility[] {
  return compatibilitySchema.parse(payload)["openai-compatibility"] ?? [];
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseAliases(payload: unknown): Map<string, { channel: string; alias: Alias }> {
  const result = new Map<string, { channel: string; alias: Alias }>();
  const groups = aliasesSchema.parse(payload)["oauth-model-alias"] ?? {};
  for (const [channel, entries] of Object.entries(groups)) {
    for (const alias of entries) result.set(alias.alias, { channel, alias });
  }
  return result;
}

export class CatalogDiscovery {
  private readonly options: CatalogDiscoveryOptions;
  private models: ProxyModelConfig[] = [];
  private diagnosticMessages: string[] = [];

  constructor(options: CatalogDiscoveryOptions) {
    this.options = options;
  }
  current(): ProxyModelConfig[] {
    return this.models;
  }
  has(id: string): boolean {
    return this.models.some((model) => model.id === id);
  }
  diagnostics(): readonly string[] {
    return this.diagnosticMessages;
  }

  async discover({
    signal: callerSignal,
  }: {
    force: boolean;
    signal?: AbortSignal;
  }): Promise<ProxyModelConfig[]> {
    const timeout = AbortSignal.timeout(15_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const fetcher = this.options.fetch ?? fetch;
    const available = parseAvailable(
      await jsonRequest(
        fetcher,
        clientModelsEndpoint(this.options.clientBaseUrl),
        this.options.clientKey,
        signal,
      ),
    );
    if (available.length === 0) {
      this.models = [];
      this.diagnosticMessages = [];
      return [];
    }

    const aliasesPayload = await jsonRequest(
      fetcher,
      endpoint(this.options.managementUrl, "/v0/management/oauth-model-alias"),
      this.options.managementKey,
      signal,
    );
    const aliases = parseAliases(aliasesPayload);
    const compatibilityPayload = await jsonRequest(
      fetcher,
      endpoint(this.options.managementUrl, "/v0/management/openai-compatibility"),
      this.options.managementKey,
      signal,
    );
    const compatibility = parseCompatibility(compatibilityPayload);
    const definitionResults = await Promise.all(
      this.options.channels.map(async (channel) => {
        const payload = await jsonRequest(
          fetcher,
          endpoint(this.options.managementUrl, `/v0/management/model-definitions/${channel}`),
          this.options.managementKey,
          signal,
        );
        return { channel, definitions: parseDefinitions(payload) };
      }),
    );
    if (
      compatibility.length === 0 &&
      definitionResults.every((result) => result.definitions.length === 0)
    ) {
      throw new DiscoveryError(
        "all management model-definition channels failed; verify managementUrl, managementKey, and CLIProxyAPI version",
      );
    }

    const nativeModels =
      compatibility.length === 0
        ? undefined
        : typeof this.options.nativeModels === "function"
          ? await this.options.nativeModels()
          : this.options.nativeModels;
    const candidates = new Map<string, Candidate[]>();
    for (const provider of compatibility) {
      if (provider.disabled) continue;
      const baseUrl = normalizedBaseUrl(provider["base-url"]);
      for (const configured of provider.models) {
        const exposedId = provider.prefix
          ? `${provider.prefix.replace(/\/$/, "")}/${configured.alias}`
          : configured.alias;
        const nativeModel = nativeModels?.find(
          (model) => normalizedBaseUrl(model.baseUrl) === baseUrl && model.id === configured.name,
        );
        const definition: Definition = {
          id: configured.name,
          owned_by: provider.name,
          type: "openai",
          display_name: configured["display-name"],
          context_length: configured["max-context-length"],
          supportedInputModalities: configured["input-modalities"],
          supportedOutputModalities: configured["output-modalities"],
          thinking: configured.thinking,
        };
        candidates.set(exposedId, [
          ...(candidates.get(exposedId) ?? []),
          {
            channel: "openai-compatibility",
            definition,
            ...(nativeModel ? { nativeModel } : {}),
          },
        ]);
      }
    }
    for (const result of definitionResults) {
      for (const definition of result.definitions) {
        candidates.set(definition.id, [
          ...(candidates.get(definition.id) ?? []),
          { channel: result.channel, definition },
        ]);
      }
    }

    const models: ProxyModelConfig[] = [];
    const diagnostics: string[] = [];
    for (const item of available) {
      const managedAlias = aliases.get(item.id);
      let matches: Candidate[];
      if (managedAlias) {
        matches = (candidates.get(managedAlias.alias.name) ?? [])
          .filter((candidate) => candidate.channel === managedAlias.channel)
          .map((candidate) => ({ ...candidate, alias: managedAlias.alias }));
      } else {
        matches = candidates.get(item.id) ?? [];
      }
      if (item.owned_by) {
        const ownerMatches = matches.filter(
          (candidate) => candidate.definition.owned_by === item.owned_by,
        );
        if (ownerMatches.length) matches = ownerMatches;
      }
      const candidate = matches[0];
      if (!candidate) {
        diagnostics.push(`${item.id}: no matching management definition or managed alias`);
        continue;
      }
      try {
        const model = toModel(item, candidate, this.options.nativeCosts);
        if (model) {
          models.push(model);
          if (candidate.alias && !model.promptPreset)
            diagnostics.push(
              `${item.id}: inherited ${candidate.alias.name} metadata, but its family has no recognized OMO prompt preset`,
            );
        }
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (models.length === 0 && diagnostics.length > 0)
      throw new DiscoveryError(`no usable chat models; ${diagnostics.join("; ")}`);
    this.models = models;
    this.diagnosticMessages = diagnostics;
    return models;
  }
}
