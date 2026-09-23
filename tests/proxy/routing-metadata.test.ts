import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHANNELS, DiscoveryError } from "../../src/proxy/catalog";
import { syncRouting } from "../../src/proxy/routing-sync";
import { fixture } from "./fixtures";

test.each([true, false])(
  "compatible routes require native metadata: published=%s",
  async (published) => {
    // Given a real proxy-shaped response without an output-token limit, and an
    // isolated upstream SDK exporting the matching token-plan metadata or none.
    const model = "mimo-v2.6-pro";
    const baseUrl = "https://token-plan-sgp.xiaomimimo.com/v1";
    const f = fixture([{ id: model, owned_by: "mimo" }]);
    for (const channel of DEFAULT_CHANNELS)
      f.routes[`/v0/management/model-definitions/${channel}`] = { models: [] };
    f.routes["/v0/management/openai-compatibility"] = {
      "openai-compatibility": [
        {
          name: "mimo",
          "base-url": baseUrl,
          models: [
            {
              name: model,
              alias: model,
              "max-context-length": 1048576,
              "input-modalities": ["text", "image"],
              "output-modalities": ["text"],
              thinking: { levels: ["high"] },
            },
          ],
        },
      ],
    };
    const root = await mkdtemp(join(tmpdir(), "olw-compatible-routing-"));
    try {
      const upstream = join(root, "upstream");
      const senpi = join(upstream, "node_modules/@code-yeongyu/senpi");
      const ai = join(senpi, "node_modules/@earendil-works/pi-ai");
      await Promise.all([
        mkdir(join(upstream, "bin"), { recursive: true }),
        mkdir(join(upstream, "plugin/extensions"), { recursive: true }),
        mkdir(ai, { recursive: true }),
      ]);
      const chain = [{ providers: ["xiaomi"], model, variant: "max" }];
      const native = {
        id: model,
        name: model,
        provider: "xiaomi-token-plan-sgp",
        api: "openai-completions",
        baseUrl,
        contextWindow: 1048576,
        maxTokens: 131072,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const files: Readonly<Record<string, string>> = {
        [join(upstream, "bin/omo.js")]: "",
        [join(upstream, "package.json")]: JSON.stringify({ name: "omo-ai", version: "1.0.0" }),
        [join(upstream, "plugin/extensions/omo-task.js")]:
          `const c=${JSON.stringify({ quick: chain, "visual-engineering": chain, "deep-low": chain })};` +
          `const a=${JSON.stringify({ explore: chain, librarian: chain, "plan-consultant": chain, "plan-reviewer": chain })};`,
        [join(senpi, "package.json")]: JSON.stringify({
          name: "@code-yeongyu/senpi",
          type: "module",
          exports: { ".": { import: "./index.js" } },
        }),
        [join(senpi, "index.js")]: "",
        [join(ai, "package.json")]: JSON.stringify({
          name: "@earendil-works/pi-ai",
          type: "module",
          exports: { "./providers/all": { import: "./catalog.js" } },
        }),
        [join(ai, "catalog.js")]:
          `export const getBuiltinProviders=()=>["xiaomi-token-plan-sgp"];` +
          `export const getBuiltinModels=()=>${JSON.stringify(published ? [native] : [])};`,
        [join(root, "config.jsonc")]: '{"categories":{},"agents":{}}',
        [join(root, "client.json")]: JSON.stringify({ baseUrl: `${f.url}/v1`, apiKey: "fixture" }),
        [join(root, "management.json")]: JSON.stringify({
          managementUrl: f.url,
          managementKey: "fixture",
        }),
      };
      await Promise.all(Object.entries(files).map(([path, text]) => writeFile(path, text)));
      // When standalone routing discovery runs outside the Senpi extension loader.
      const result = syncRouting({
        upstream: join(upstream, "bin/omo.js"),
        configPath: join(root, "config.jsonc"),
        stateDir: join(root, "state"),
        clientCredentials: join(root, "client.json"),
        managementCredentials: join(root, "management.json"),
        adopt: false,
        check: true,
        force: true,
      });
      // Then it uses the installed SDK contract, rather than guessing output limits.
      if (published)
        expect((await result).managed.categories["quick"]).toEqual({
          models: [{ model: "cliproxyapi/mimo-v2.6-pro", reasoning: "max" }],
        });
      else await expect(result).rejects.toBeInstanceOf(DiscoveryError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
