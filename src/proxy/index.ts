import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@code-yeongyu/senpi";
import type { z } from "zod";
import { CatalogDiscovery, DEFAULT_CHANNELS, DiscoveryError, type NativeCost } from "./catalog";
import {
  type Api,
  anthropicMessagesApi,
  getBuiltinModels,
  getBuiltinProviders,
  type Model,
  openAICompletionsApi,
  openAIResponsesApi,
} from "./engine";
import { withPriorityModels } from "./priority-models";
import { clientAccessSchema, managementAccessSchema } from "./schema";

export const PROVIDER_ID = "cliproxyapi";
const PROXY_API = "olw-cliproxyapi";
const DEFAULT_CLIENT_CREDENTIALS = `${process.env["HOME"]}/.config/cliproxyapi/omo-client.json`;
const DEFAULT_MANAGEMENT_CREDENTIALS = `${process.env["HOME"]}/.config/cliproxyapi/management-access.json`;

type Dependencies = {
  clientCredentials?: string;
  managementCredentials?: string;
  channels?: readonly string[];
  nativeCosts?: ReadonlyMap<string, NativeCost>;
  nativeModels?: readonly Model<Api>[];
};

async function credentials<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new DiscoveryError(`cannot read valid credential JSON at ${path}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DiscoveryError(`invalid credential fields at ${path}`);
  return parsed.data;
}

function builtinMetadata(): {
  costs: ReadonlyMap<string, NativeCost>;
  models: readonly Model<Api>[];
} {
  const costs = new Map<string, NativeCost>();
  const models: Model<Api>[] = [];
  const preferred = [
    "openai",
    "chatgpt-subscription",
    "anthropic",
    "moonshotai",
    "xai",
    "google",
    "google-vertex",
  ];
  const providers = getBuiltinProviders().sort((left, right) => {
    const leftRank = preferred.indexOf(left);
    const rightRank = preferred.indexOf(right);
    return (
      (leftRank < 0 ? preferred.length : leftRank) - (rightRank < 0 ? preferred.length : rightRank)
    );
  });
  for (const provider of providers)
    for (const model of getBuiltinModels(provider)) {
      models.push(model);
      if (!costs.has(model.id)) costs.set(model.id, model.cost);
    }
  return { costs, models };
}

function refreshError(result: {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}): Error | undefined {
  if (result.aborted) return new Error("CLIProxyAPI model refresh timed out");
  return result.errors.get(PROVIDER_ID);
}

export function createExtension(dependencies: Dependencies = {}): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const [client, management] = await Promise.all([
      credentials(dependencies.clientCredentials ?? DEFAULT_CLIENT_CREDENTIALS, clientAccessSchema),
      credentials(
        dependencies.managementCredentials ?? DEFAULT_MANAGEMENT_CREDENTIALS,
        managementAccessSchema,
      ),
    ]);
    const builtin = builtinMetadata();
    const nativeCosts = dependencies.nativeCosts ?? builtin.costs;
    const nativeModels = dependencies.nativeModels ?? builtin.models;
    const discovery = new CatalogDiscovery({
      clientBaseUrl: client.baseUrl,
      clientKey: client.apiKey,
      managementUrl: management.managementUrl,
      managementKey: management.managementKey,
      nativeCosts,
      nativeModels,
      channels: dependencies.channels ?? DEFAULT_CHANNELS,
    });
    await discovery.discover({ force: true });
    let wireModels = withPriorityModels(discovery.current(), nativeCosts);
    const materialize = (): Model<Api>[] =>
      wireModels.map((model) => ({
        ...model,
        api: PROXY_API,
        provider: PROVIDER_ID,
        baseUrl: client.baseUrl,
      }));
    let models = materialize();
    const transports = {
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
    };
    const modelForRequest = (model: Model<Api>): Model<Api> => {
      const upstream = wireModels.find((available) => available.id === model.id);
      if (!upstream) {
        throw new DiscoveryError(
          `${model.id} is unavailable; run /proxy-refresh and select another model`,
        );
      }
      return {
        ...model,
        id: upstream.upstreamModelId ?? model.id,
        api: upstream.api,
        ...(upstream.serviceTier ? { serviceTier: upstream.serviceTier } : {}),
        baseUrl:
          upstream.api === "anthropic-messages"
            ? model.baseUrl.replace(/\/v1\/?$/, "")
            : model.baseUrl,
      };
    };
    const streamsFor = (model: Model<Api>) => {
      switch (model.api) {
        case "openai-responses":
          return transports["openai-responses"];
        case "anthropic-messages":
          return transports["anthropic-messages"];
        case "openai-completions":
          return transports["openai-completions"];
        default:
          throw new DiscoveryError(`unsupported proxy transport ${model.api}`);
      }
    };

    pi.registerProvider({
      id: PROVIDER_ID,
      name: "CLIProxyAPI",
      baseUrl: client.baseUrl,
      auth: {
        apiKey: {
          name: "CLIProxyAPI client key",
          resolve: async () => ({
            auth: { apiKey: client.apiKey, headers: { Authorization: `Bearer ${client.apiKey}` } },
          }),
        },
      },
      getModels: () => models,
      refreshModels: async ({ allowNetwork, force, signal, publish }) => {
        if (!allowNetwork) return;
        const next = await discovery.discover({ force: force ?? false, signal });
        await publish({
          update: () => {
            wireModels = withPriorityModels(next, nativeCosts);
            models = materialize();
          },
        });
      },
      stream: (model, context, options) => {
        const wireModel = modelForRequest(model);
        return streamsFor(wireModel).stream(
          wireModel,
          context,
          wireModel.serviceTier ? { ...options, serviceTier: wireModel.serviceTier } : options,
        );
      },
      streamSimple: (model, context, options) => {
        const wireModel = modelForRequest(model);
        return streamsFor(wireModel).streamSimple(
          wireModel,
          context,
          wireModel.serviceTier ? { ...options, serviceTier: wireModel.serviceTier } : options,
        );
      },
    });

    const refresh = async (ctx: ExtensionContext, force: boolean) => {
      const signal = AbortSignal.timeout(15_000);
      const result = await ctx.modelRegistry.refresh({
        providers: [PROVIDER_ID],
        allowNetwork: true,
        force,
        signal,
      });
      const error = refreshError(result);
      if (error) throw error;
      if (
        ctx.model?.provider === PROVIDER_ID &&
        !wireModels.some((model) => model.id === ctx.model?.id)
      ) {
        throw new DiscoveryError(
          `${ctx.model.id} is no longer advertised by /v1/models; select an available ${PROVIDER_ID} model`,
        );
      }
      if (ctx.model?.provider === PROVIDER_ID) {
        const latest = ctx.modelRegistry.find(PROVIDER_ID, ctx.model.id);
        if (latest && JSON.stringify(latest) !== JSON.stringify(ctx.model)) {
          if (!(await pi.setModel(latest))) {
            throw new DiscoveryError(`cannot activate refreshed metadata for ${ctx.model.id}`);
          }
        }
      }
    };

    pi.registerCommand("proxy-refresh", {
      description: "Refresh CLIProxyAPI models and metadata",
      handler: async (_args, ctx) => {
        try {
          await refresh(ctx, true);
          const count = ctx.modelRegistry
            .getAll()
            .filter((model) => model.provider === PROVIDER_ID).length;
          const diagnostics = discovery.diagnostics();
          ctx.ui.notify(
            `CLIProxyAPI catalog refreshed (${count} models${diagnostics.length ? `; ${diagnostics.length} omitted with metadata diagnostics` : ""})`,
            diagnostics.length ? "warning" : "info",
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          throw error;
        }
      },
    });

    pi.on("session_start", (_event, ctx) => {
      const diagnostics = discovery.diagnostics();
      if (diagnostics.length)
        ctx.ui.notify(
          `CLIProxyAPI omitted ${diagnostics.length} model(s): ${diagnostics.slice(0, 3).join("; ")}`,
          "warning",
        );
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      await refresh(ctx, false);
    });
  };
}

export default createExtension();
