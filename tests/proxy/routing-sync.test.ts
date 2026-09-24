import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  digest,
  editRoutingConfig,
  groupsSchema,
  type RoutingReceipt,
  receiptSchema,
  recoverRouting,
} from "../../src/proxy/routing-config";
import { type SyncOptions, syncRouting } from "../../src/proxy/routing-sync";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Rung {
  readonly providers: readonly string[];
  readonly model: string;
  readonly variant?: string;
}

function source(chain: string | readonly Rung[]): string {
  const rungs =
    typeof chain === "string" ? [{ providers: ["openai"], model: chain, variant: "low" }] : chain;
  return `const categories=${JSON.stringify({
    "visual-engineering": rungs,
    "deep-low": rungs,
    quick: rungs,
  })}; const agents=${JSON.stringify({
    explore: rungs,
    librarian: rungs,
    "plan-consultant": rungs,
    "plan-reviewer": rungs,
  })}; const reviewer={name:"omo-native-test",mode:"subagent",categories:["quick"]};`;
}

function catalog(ids: readonly string[]): string {
  return JSON.stringify({
    providers: {
      cliproxyapi: { modelOverrides: {} },
      opencodex: {
        baseUrl: "http://127.0.0.1:10100/v1",
        api: "openai-completions",
        models: ids.map((id) => ({ id, name: id })),
      },
    },
  });
}

const quickRoute = z.object({
  categories: z.object({ quick: z.object({ models: z.array(z.unknown()) }) }),
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-routing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "upstream");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "plugin/extensions"), { recursive: true });
  const upstream = join(packageRoot, "bin/omo.js");
  const bundle = join(packageRoot, "plugin/extensions/omo-task.js");
  const configPath = join(root, "omo.jsonc");
  const catalogPath = join(root, "models.json");
  await Promise.all([
    writeFile(upstream, ""),
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "omo-ai", version: "1.0.0" }),
    ),
    writeFile(bundle, source("gpt-6-luna")),
    writeFile(
      configPath,
      '{\n// user-owned comment\n"model_profiles":{"mine":{"models":["opencodex/opus"]}},\n"categories":{}, "agents":{}\n}\n',
    ),
    writeFile(catalogPath, catalog(["gpt-6-luna", "gpt-6-sol"])),
  ]);
  const options: SyncOptions = {
    upstream,
    configPath,
    stateDir: join(root, "state"),
    catalogPath,
    adopt: true,
    check: false,
    force: false,
  };
  return {
    options,
    bundle,
    setCatalog: (ids: readonly string[]) => writeFile(catalogPath, catalog(ids)),
    state: () => readFile(join(options.stateDir, "state.json"), "utf8"),
  };
}

describe("routing synchronization real filesystem boundary", () => {
  test("read-only check shows the next policy without changing configuration", async () => {
    const world = await fixture();
    const before = await readFile(world.options.configPath, "utf8");
    const result = await syncRouting({ ...world.options, check: true });
    expect(result.provider).toBe("opencodex");
    expect(result.managed.categories["quick"]).toEqual({
      models: [{ model: "opencodex/gpt-6-luna", reasoning: "low" }],
    });
    expect(await readFile(world.options.configPath, "utf8")).toBe(before);
    expect(await Bun.file(join(world.options.stateDir, "state.json")).exists()).toBe(false);
  });

  test("source changes automatically update untouched routes and preserve manual edits", async () => {
    const world = await fixture();
    const first = await syncRouting(world.options);
    const config = await readFile(world.options.configPath, "utf8");
    const unownedPrefix = config.slice(0, config.indexOf('"categories"'));
    await writeFile(
      world.options.configPath,
      editRoutingConfig(config, {
        categories: { ...first.managed.categories, quick: { models: ["opencodex/opus"] } },
        agents: first.managed.agents,
      }),
    );
    await writeFile(world.bundle, source("gpt-6-sol"));
    const next = await syncRouting({ ...world.options, adopt: false });
    const updatedText = await readFile(world.options.configPath, "utf8");
    const updated = z
      .object({
        categories: groupsSchema.shape.categories,
        model_profiles: z.record(z.string(), z.object({ models: z.array(z.string()) })),
      })
      .parse(Bun.JSON5.parse(updatedText));
    expect(updatedText.slice(0, unownedPrefix.length)).toBe(unownedPrefix);
    expect(updated.categories["quick"]?.["models"]).toEqual(["opencodex/opus"]);
    expect(updated.categories["deep-low"]?.["models"]).toEqual([
      { model: "opencodex/gpt-6-sol", reasoning: "low" },
    ]);
    expect(updated.model_profiles["mine"]?.models).toEqual(["opencodex/opus"]);
    expect(next.overrides).toContain("categories.quick");
    expect(next.digest).not.toBe(first.digest);
  });

  test("migrates untouched CLIProxyAPI routes to opencodex without --force", async () => {
    // Given the state and configuration written by the CLIProxyAPI-era synchronizer.
    const world = await fixture();
    const current = await syncRouting(world.options);
    const legacyManaged = groupsSchema.parse(
      JSON.parse(JSON.stringify(current.managed).replaceAll('"opencodex/', '"cliproxyapi/')),
    );
    const legacyConfig = editRoutingConfig(
      await readFile(world.options.configPath, "utf8"),
      legacyManaged,
    );
    await writeFile(world.options.configPath, legacyConfig);
    const legacy: Record<string, unknown> = {
      ...current,
      managed: legacyManaged,
      configDigest: digest(legacyConfig),
    };
    delete legacy["provider"];
    await writeFile(join(world.options.stateDir, "state.json"), JSON.stringify(legacy));
    // When the next ordinary start checks routing.
    const migrated = await syncRouting({ ...world.options, adopt: false });
    // Then every untouched route moves to opencodex and none is treated as a manual override.
    expect(migrated.provider).toBe("opencodex");
    expect(migrated.overrides).toEqual([]);
    expect(
      quickRoute.parse(Bun.JSON5.parse(await readFile(world.options.configPath, "utf8"))).categories
        .quick.models,
    ).toEqual([{ model: "opencodex/gpt-6-luna", reasoning: "low" }]);
  });

  test("a changed opencodex catalog updates untouched routes at the next start", async () => {
    // Given a preferred model that opencodex does not publish yet.
    const world = await fixture();
    await writeFile(
      world.bundle,
      source([
        { providers: ["openai"], model: "gpt-6-terra", variant: "high" },
        { providers: ["openai"], model: "gpt-6-luna", variant: "low" },
      ]),
    );
    const first = await syncRouting(world.options);
    expect(first.managed.categories["quick"]).toEqual({
      models: [{ model: "opencodex/gpt-6-luna", reasoning: "low" }],
    });
    // When the user enables it in opencodex, which rewrites the OMO catalog.
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "gpt-6-terra"]);
    const next = await syncRouting({ ...world.options, adopt: false });
    // Then the next ordinary start restores upstream order without --force.
    expect(next.managed.categories["quick"]).toEqual({
      models: [
        { model: "opencodex/gpt-6-terra", reasoning: "high" },
        { model: "opencodex/gpt-6-luna", reasoning: "low" },
      ],
    });
    expect(next.generation).not.toBe(first.generation);
  });

  test("unrecognized upstream structure leaves the last valid files byte-identical", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const config = await readFile(world.options.configPath, "utf8"),
      state = await world.state();
    await writeFile(world.bundle, "const unsupported={};");
    await expect(syncRouting(world.options)).rejects.toThrow("routing table");
    expect(await readFile(world.options.configPath, "utf8")).toBe(config);
    expect(await world.state()).toBe(state);
  });

  test("a missing opencodex catalog retains the previous generation without choosing another provider", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const config = await readFile(world.options.configPath, "utf8"),
      state = await world.state();
    await writeFile(world.bundle, source("gpt-6-sol"));
    await writeFile(world.options.catalogPath, JSON.stringify({ providers: { cliproxyapi: {} } }));
    await expect(syncRouting(world.options)).rejects.toThrow("opencodex");
    expect(await readFile(world.options.configPath, "utf8")).toBe(config);
    expect(await world.state()).toBe(state);
  });

  test("unchanged startup tolerates an unreadable catalog and does not rewrite state", async () => {
    const world = await fixture();
    const receipt = await syncRouting(world.options);
    const state = await world.state();
    await rm(world.options.catalogPath);
    expect(await syncRouting({ ...world.options, adopt: false })).toEqual(receipt);
    expect(await world.state()).toBe(state);
  });

  test("two actual CLI starts serialize publication under the same lock", async () => {
    const world = await fixture();
    const args = [
      process.execPath,
      resolve(import.meta.dir, "../../scripts/proxy-routing.ts"),
      "sync",
      "--adopt",
      "--upstream",
      world.options.upstream,
      "--config",
      world.options.configPath,
      "--state-dir",
      world.options.stateDir,
      "--catalog",
      world.options.catalogPath,
    ];
    const children = [
      Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }),
    ];
    cleanups.push(async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    });
    const results = await Promise.all(
      children.map(async (child) => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        return receiptSchema.parse(JSON.parse(stdout));
      }),
    );
    expect(new Set(results.map((result) => result.generation)).size).toBe(1);
  }, 15000);

  test("recovers receipt publication after a process died after replacing configuration", async () => {
    const world = await fixture();
    const before = await readFile(world.options.configPath, "utf8");
    const receipt = await syncRouting(world.options);
    const text = await readFile(world.options.configPath, "utf8");
    const next: RoutingReceipt = { ...receipt, generation: "interrupted" };
    await writeFile(
      join(world.options.stateDir, "pending.json"),
      JSON.stringify({
        configPath: world.options.configPath,
        before: digest(before),
        text,
        receipt: next,
      }),
    );
    await recoverRouting(world.options.stateDir);
    expect(receiptSchema.parse(JSON.parse(await world.state())).generation).toBe("interrupted");
    expect(await readFile(world.options.configPath, "utf8")).toBe(text);
    expect(await Bun.file(join(world.options.stateDir, "pending.json")).exists()).toBe(false);
  });
});
