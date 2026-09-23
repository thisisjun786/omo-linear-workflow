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

function source(model: string): string {
  const chain = [{ providers: ["native"], model, variant: "low" }];
  return `const categories=${JSON.stringify({
    "visual-engineering": chain,
    "deep-low": chain,
    quick: chain,
  })}; const agents=${JSON.stringify({
    explore: chain,
    librarian: chain,
    "plan-consultant": chain,
    "plan-reviewer": chain,
  })}; const reviewer={name:"omo-native-test",mode:"subagent",categories:["quick"]};`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-routing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let offline = false;
  let discoveries = 0;
  const models = ["gpt-6-luna", "gpt-6-sol"];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (offline) return new Response("offline", { status: 503 });
      const path = new URL(request.url).pathname;
      if (path === "/v1/models") {
        discoveries++;
        return Response.json({ data: models.map((id) => ({ id })) });
      }
      if (path.endsWith("/oauth-model-alias")) return Response.json({ "oauth-model-alias": null });
      return Response.json({
        models: path.endsWith("/codex")
          ? models.map((id) => ({
              id,
              context_length: 100000,
              max_completion_tokens: 10000,
              supportedInputModalities: ["text"],
              thinking: { levels: ["low", "high"] },
            }))
          : [],
      });
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const packageRoot = join(root, "upstream");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "plugin/extensions"), { recursive: true });
  const upstream = join(packageRoot, "bin/omo.js");
  const bundle = join(packageRoot, "plugin/extensions/omo-task.js");
  const configPath = join(root, "omo.jsonc");
  const clientCredentials = join(root, "client.json");
  const managementCredentials = join(root, "management.json");
  await Promise.all([
    writeFile(upstream, ""),
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "omo-ai", version: "1.0.0" }),
    ),
    writeFile(bundle, source("gpt-6-luna")),
    writeFile(
      configPath,
      '{\n// user-owned comment\n"model_profiles":{"mine":{"models":["cliproxyapi/opus"]}},\n"categories":{}, "agents":{}\n}\n',
    ),
    writeFile(clientCredentials, JSON.stringify({ baseUrl: `${server.url}v1`, apiKey: "fixture" })),
    writeFile(
      managementCredentials,
      JSON.stringify({ managementUrl: String(server.url), managementKey: "fixture" }),
    ),
  ]);
  const options: SyncOptions = {
    upstream,
    configPath,
    stateDir: join(root, "state"),
    clientCredentials,
    managementCredentials,
    adopt: true,
    check: false,
    force: false,
  };
  return {
    options,
    bundle,
    setOffline: () => {
      offline = true;
    },
    discoveries: () => discoveries,
    state: () => readFile(join(options.stateDir, "state.json"), "utf8"),
  };
}

describe("routing synchronization real filesystem and HTTP boundary", () => {
  test("read-only check shows the next policy without changing configuration", async () => {
    const world = await fixture();
    const before = await readFile(world.options.configPath, "utf8");
    const result = await syncRouting({ ...world.options, check: true });
    expect(result.managed.categories["quick"]).toEqual({
      models: [{ model: "cliproxyapi/gpt-6-luna", reasoning: "low" }],
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
        categories: { ...first.managed.categories, quick: { models: ["cliproxyapi/opus"] } },
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
    expect(updated.categories["quick"]?.["models"]).toEqual(["cliproxyapi/opus"]);
    expect(updated.categories["deep-low"]?.["models"]).toEqual([
      { model: "cliproxyapi/gpt-6-sol", reasoning: "low" },
    ]);
    expect(updated.model_profiles["mine"]?.models).toEqual(["cliproxyapi/opus"]);
    expect(next.overrides).toContain("categories.quick");
    expect(next.digest).not.toBe(first.digest);
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

  test("proxy failure retains the previous generation without choosing another provider", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const config = await readFile(world.options.configPath, "utf8"),
      state = await world.state();
    await writeFile(world.bundle, source("gpt-6-sol"));
    world.setOffline();
    await expect(syncRouting(world.options)).rejects.toThrow("503");
    expect(await readFile(world.options.configPath, "utf8")).toBe(config);
    expect(await world.state()).toBe(state);
  });

  test("unchanged startup needs no proxy connection and does not rewrite state", async () => {
    const world = await fixture();
    const receipt = await syncRouting(world.options);
    world.setOffline();
    expect(await syncRouting({ ...world.options, adopt: false })).toEqual(receipt);
    expect(world.discoveries()).toBe(1);
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
      "--client",
      world.options.clientCredentials,
      "--management",
      world.options.managementCredentials,
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
    expect(world.discoveries()).toBe(1);
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
