import { afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@code-yeongyu/senpi";
import { AuthStorage } from "../../node_modules/@code-yeongyu/senpi/dist/core/auth-storage.js";
import {
  drainPendingProviderRegistrations,
  loadExtensionFromFactory,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/loader.js";
import { CatalogDiscovery, type NativeCost } from "../../src/proxy/catalog";
import type { Api, Model } from "../../src/proxy/engine";
import { createExtension } from "../../src/proxy/index";

const servers: Bun.Server<unknown>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export function fixture(available: object[]) {
  const hits: string[] = [];
  const requests: Array<{ path: string; body: unknown }> = [];
  const routes: Record<string, unknown> = {
    "/v1/models": { object: "list", data: available },
    "/v0/management/oauth-model-alias": {
      "oauth-model-alias": {
        claude: [{ name: "claude-opus-4-7", alias: "opus-main", "display-name": "Opus Main" }],
      },
    },
    "/v0/management/model-definitions/codex": {
      channel: "codex",
      models: [
        {
          id: "gpt-6-astra",
          owned_by: "openai",
          type: "openai",
          display_name: "GPT 6.0 Astra",
          context_length: 272000,
          max_completion_tokens: 128000,
          supportedInputModalities: ["text", "image"],
          supportedOutputModalities: ["text"],
          thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
        },
      ],
    },
    "/v0/management/model-definitions/claude": {
      channel: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          owned_by: "anthropic",
          type: "claude",
          display_name: "Claude Opus 4.7",
          context_length: 1_000_000,
          max_completion_tokens: 128000,
          supportedInputModalities: ["text", "image"],
          supportedOutputModalities: ["text"],
          thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
        },
      ],
    },
    "/v0/management/model-definitions/kimi": { models: [] },
    "/v0/management/openai-compatibility": { "openai-compatibility": [] },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (req.method === "POST") requests.push({ path, body: await req.json() });
      const body = routes[path];
      return body
        ? Response.json(body)
        : Response.json({ error: "unknown channel" }, { status: 400 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits, routes, requests };
}

export const nativeCosts = new Map<string, NativeCost>([
  ["gpt-6-astra", { input: 4, output: 16, cacheRead: 1, cacheWrite: 0 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
]);

export const nativeModels: Model<Api>[] = [
  {
    id: "mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    api: "openai-completions",
    provider: "xiaomi-token-plan-sgp",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      supportsDisabledThinking: false,
    },
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
];

export function discovery(url: string) {
  return new CatalogDiscovery({
    clientBaseUrl: `${url}/v1`,
    clientKey: "client-secret",
    managementUrl: `${url}/management.html`,
    managementKey: "management-secret",
    channels: ["codex", "claude"],
    nativeCosts,
    nativeModels,
  });
}

export async function extensionFixture(url: string, contextWindow?: number) {
  const dir = await mkdtemp(join(tmpdir(), "omo-cliproxyapi-"));
  directories.push(dir);
  const clientCredentials = join(dir, "client.json");
  const managementCredentials = join(dir, "management.json");
  await writeFile(
    clientCredentials,
    JSON.stringify({ baseUrl: `${url}/v1`, apiKey: "client-secret" }),
  );
  await writeFile(
    managementCredentials,
    JSON.stringify({ managementUrl: url, managementKey: "management-secret" }),
  );
  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  const extension = await loadExtensionFromFactory(
    createExtension({
      clientCredentials,
      managementCredentials,
      nativeCosts,
      channels: ["codex", "claude", "kimi"],
    }),
    dir,
    bus,
    runtime,
  );
  const modelConfig = join(dir, "models.json");
  await writeFile(
    modelConfig,
    JSON.stringify({
      providers:
        contextWindow === undefined
          ? {}
          : {
              cliproxyapi: { modelOverrides: { "gpt-6-astra": { contextWindow } } },
            },
    }),
  );
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelConfig);
  for (const entry of drainPendingProviderRegistrations(runtime)) {
    if (entry.kind === "native") {
      await registry.modelRuntime.registerNativeProvider(entry.provider, { refresh: false });
    } else {
      await registry.modelRuntime.registerProvider(entry.name, entry.config, { refresh: false });
    }
  }
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    dir,
    SessionManager.inMemory(dir),
    registry,
    bus,
  );
  return {
    registry,
    runtime,
    runner,
    extension,
    refresh: () => registry.refresh({ providers: ["cliproxyapi"], allowNetwork: true }),
    models: () => registry.getAll().filter((model) => model.provider === "cliproxyapi"),
  };
}
