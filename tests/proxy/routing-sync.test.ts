import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  digest,
  editRoutingConfig,
  groupsSchema,
  type RoutingReceipt,
  receiptSchema,
  recoverRouting,
} from "../../src/proxy/routing-config";
import {
  dismissRoutingAdvice,
  readRoutingAdvice,
  retainedRoutingInstalled,
  type SyncOptions,
  saveRoutingBaseline,
  syncRouting,
} from "../../src/proxy/routing-sync";

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
      opencodex: {
        baseUrl: "http://127.0.0.1:10100/v1",
        api: "openai-completions",
        models: ids.map((id) => ({
          id,
          name: id,
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          input: ["text", "image"],
          reasoning: true,
        })),
      },
    },
  });
}

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
    catalogPath,
    state: () => readFile(join(options.stateDir, "state.json"), "utf8"),
  };
}

describe("retained routing for a fail-open launch", () => {
  test("is installed only while every managed route still routes through opencodex", async () => {
    const world = await fixture();
    const { configPath, stateDir } = world.options;
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
    await syncRouting(world.options);
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(true);
    const adopted = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      adopted.replace(/"opencodex\/gpt-6-luna"/g, '"opencodex/gpt-6-sol"'),
    );
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(true);
    await writeFile(configPath, adopted.replace(/"opencodex\/gpt-6-luna"/g, '"native/luna"'));
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
    await writeFile(configPath, adopted.replace('"quick"', '"quick-renamed"'));
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
    const withFallback = (fallback: string) =>
      adopted.replace(
        /"quick": \{\n(\s*)"models"/,
        `"quick": {\n$1"fallback_models": [${fallback}],\n$1"models"`,
      );
    await writeFile(configPath, withFallback('{"provider": "native", "model_id": "luna"}'));
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
    await writeFile(configPath, withFallback('{"provider": "opencodex", "model_id": "gpt-6-sol"}'));
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(true);
    await writeFile(configPath, withFallback('{"provider": "native"}'));
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
    await rm(configPath);
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
    await writeFile(configPath, adopted);
    await writeFile(join(stateDir, "state.json"), "{not json");
    expect(await retainedRoutingInstalled(configPath, stateDir)).toBe(false);
  });
});

describe("routing synchronization real filesystem boundary", () => {
  test("a receipt from an older mapping revision re-plans on an ordinary start", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const statePath = join(world.options.stateDir, "state.json");
    const receipt = JSON.parse(await world.state());
    delete receipt.planRevision;
    await writeFile(statePath, `${JSON.stringify(receipt, null, 2)}\n`);
    const next = await syncRouting({ ...world.options, adopt: false });
    expect(next.generation).not.toBe(receipt.generation);
    expect(JSON.parse(await world.state()).planRevision).toBeGreaterThan(0);
  });

  test.each(["entry record", "quoted exec"] as const)(
    "a package path with spaces resolves through the %s",
    async (form) => {
      const world = await fixture();
      const spaced = join(dirname(world.options.configPath), "My Tools", "omo-ai");
      await mkdir(dirname(spaced), { recursive: true });
      await rename(dirname(dirname(world.options.upstream)), spaced);
      const entry = join(spaced, "bin/omo.js");
      const shim = join(dirname(world.options.configPath), "spaced-omo");
      const lines =
        form === "entry record"
          ? ["#!/bin/sh", `# entry: ${entry}`, `exec bun '${entry}' "$@"`]
          : ["#!/bin/sh", `exec bun '${entry}' "$@"`];
      await writeFile(shim, `${lines.join("\n")}\n`, { mode: 0o755 });
      const result = await syncRouting({ ...world.options, upstream: shim, check: true });
      expect(result.version).toBe("1.0.0");
    },
  );
  test("a generated bun launcher shim resolves to its recorded omo-ai entry package", async () => {
    const world = await fixture();
    const shimDirectory = join(dirname(dirname(world.options.upstream)), "..", "bun-bin");
    await mkdir(shimDirectory, { recursive: true });
    const shim = join(shimDirectory, "omo");
    await writeFile(
      shim,
      [
        "#!/bin/sh",
        "# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it",
        `# entry: ${world.options.upstream}`,
        `exec bun '${world.options.upstream}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = await syncRouting({ ...world.options, upstream: shim, check: true });
    expect(result.version).toBe("1.0.0");
  });

  test("a launcher script without an entry comment still resolves through its exec target", async () => {
    const world = await fixture();
    const shimDirectory = join(dirname(dirname(world.options.upstream)), "..", "other-bin");
    await mkdir(shimDirectory, { recursive: true });
    // An unrelated package.json on the launcher's own ancestry must not be taken for omo-ai.
    await writeFile(
      join(shimDirectory, "..", "package.json"),
      JSON.stringify({ name: "unrelated", version: "9.9.9" }),
    );
    const shim = join(shimDirectory, "omo");
    await writeFile(shim, `#!/bin/sh\nexec /usr/bin/env bun "${world.options.upstream}" "$@"\n`, {
      mode: 0o755,
    });
    const result = await syncRouting({ ...world.options, upstream: shim, check: true });
    expect(result.version).toBe("1.0.0");
  });

  test("a launcher that names no omo-ai package fails with the paths it tried", async () => {
    const world = await fixture();
    const shim = join(dirname(world.options.configPath), "stray-omo");
    await writeFile(shim, "#!/bin/sh\nexec true\n", { mode: 0o755 });
    await expect(syncRouting({ ...world.options, upstream: shim, check: true })).rejects.toThrow(
      /omo-ai package/,
    );
  });

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

  test("pinned mode records upstream advice without rewriting configuration", async () => {
    const world = await fixture();
    const first = await syncRouting(world.options);
    const config = await readFile(world.options.configPath, "utf8");
    await writeFile(world.bundle, source("gpt-6-sol"));

    const beforeStat = await stat(world.options.configPath);
    const next = await syncRouting({ ...world.options, adopt: false });

    expect(await readFile(world.options.configPath, "utf8")).toBe(config);
    const afterStat = await stat(world.options.configPath);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(next.routingPolicy).toBe("pinned");
    expect(next.advice).toContainEqual({
      path: "categories.deep-low",
      before: first.managed.categories["deep-low"],
      after: { models: [{ model: "opencodex/gpt-6-sol", reasoning: "low" }] },
      current: first.managed.categories["deep-low"],
      status: "changed",
      alternatives: ["opencodex/gpt-6-sol"],
    });
  });

  test("follow mode automatically updates untouched routes and preserves manual edits", async () => {
    const world = await fixture();
    const first = await syncRouting({ ...world.options, routingPolicy: "follow" });
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
    const next = await syncRouting({
      ...world.options,
      adopt: false,
      routingPolicy: "follow",
    });
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

  test("a changed opencodex catalog advises without updating pinned routes", async () => {
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
    // Then the next ordinary start keeps the accepted route and records the candidate.
    expect(next.managed.categories["quick"]).toEqual(first.managed.categories["quick"]);
    expect(next.advice.find((item) => item.path === "categories.quick")?.after).toEqual({
      models: [
        { model: "opencodex/gpt-6-terra", reasoning: "high" },
        { model: "opencodex/gpt-6-luna", reasoning: "low" },
      ],
    });
    expect(next.generation).not.toBe(first.generation);
  });

  test("applies one advised route with a backup and leaves the rest pending", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await writeFile(world.bundle, source("gpt-6-sol"));
    await syncRouting({ ...world.options, adopt: false });

    const applied = await syncRouting({
      ...world.options,
      adopt: false,
      apply: ["categories.deep-low"],
    });

    expect(applied.changes).toEqual(["categories.deep-low"]);
    expect(applied.backup).not.toBeNull();
    expect(applied.advice.some((item) => item.path === "categories.deep-low")).toBe(false);
    expect(applied.advice.length).toBeGreaterThan(0);
    expect(await readFile(applied.backup ?? "", "utf8")).toContain("gpt-6-luna");
    const recomputed = await syncRouting({ ...world.options, adopt: false, force: true });
    expect(recomputed.advice.some((item) => item.path === "categories.deep-low")).toBe(false);
    expect(recomputed.advice.some((item) => item.path === "categories.quick")).toBe(true);
    const second = await syncRouting({
      ...world.options,
      adopt: false,
      apply: ["categories.quick"],
    });
    expect(second.changes).toEqual(["categories.quick"]);

    await writeFile(world.bundle, source("gpt-6-luna"));
    const returned = await syncRouting({ ...world.options, adopt: false });
    expect(returned.advice.find((item) => item.path === "categories.deep-low")).toMatchObject({
      before: { models: [{ model: "opencodex/gpt-6-sol", reasoning: "low" }] },
      after: { models: [{ model: "opencodex/gpt-6-luna", reasoning: "low" }] },
    });
    expect(
      (await syncRouting({ ...world.options, adopt: false, apply: ["categories.deep-low"] }))
        .changes,
    ).toEqual(["categories.deep-low"]);
  });

  test("dismisses advice until the upstream candidate changes again", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await writeFile(world.bundle, source("gpt-6-sol"));
    await syncRouting({ ...world.options, adopt: false });
    const dismissed = await dismissRoutingAdvice(world.options.stateDir, ["categories.deep-low"]);
    expect(dismissed.advice.some((item) => item.path === "categories.deep-low")).toBe(false);
    const edited = (await readFile(world.options.configPath, "utf8")).replaceAll(
      "opencodex/gpt-6-luna",
      "opencodex/gpt-6-terra",
    );
    await writeFile(world.options.configPath, edited);
    expect(
      (await syncRouting({ ...world.options, adopt: false, force: true })).advice.some(
        (item) => item.path === "categories.deep-low",
      ),
    ).toBe(false);
    expect(
      (await syncRouting({ ...world.options, adopt: false, force: true })).advice.some(
        (item) => item.path === "categories.deep-low",
      ),
    ).toBe(false);
    await writeFile(world.bundle, source("gpt-6-terra"));
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "gpt-6-terra"]);
    expect(
      (await syncRouting({ ...world.options, adopt: false })).advice.some(
        (item) => item.path === "categories.deep-low",
      ),
    ).toBe(true);
    await writeFile(world.bundle, source("gpt-6-sol"));
    expect(
      (await syncRouting({ ...world.options, adopt: false })).advice.some(
        (item) => item.path === "categories.deep-low",
      ),
    ).toBe(true);
  });

  test("dismissal for a newly introduced route expires after another candidate", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const extraSource = (model: string) =>
      source("gpt-6-luna").replace(
        "const categories={",
        `const categories={"extra":[{"providers":["openai"],"model":"${model}","variant":"low"}],`,
      );
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "gpt-6-terra"]);
    await writeFile(world.bundle, extraSource("gpt-6-sol"));
    await syncRouting({ ...world.options, adopt: false });
    await dismissRoutingAdvice(world.options.stateDir, ["categories.extra"]);
    await writeFile(world.bundle, extraSource("gpt-6-terra"));
    expect(
      (await syncRouting({ ...world.options, adopt: false })).advice.some(
        (item) => item.path === "categories.extra",
      ),
    ).toBe(true);
    await writeFile(world.bundle, extraSource("gpt-6-sol"));
    expect(
      (await syncRouting({ ...world.options, adopt: false })).advice.some(
        (item) => item.path === "categories.extra",
      ),
    ).toBe(true);
  });

  test("a removed current model is unavailable advice and is never replaced", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const before = await readFile(world.options.configPath, "utf8");
    await world.setCatalog(["gpt-6-sol"]);
    const next = await syncRouting({ ...world.options, adopt: false });
    expect(await readFile(world.options.configPath, "utf8")).toBe(before);
    expect(next.advice.find((item) => item.path === "categories.deep-low")).toMatchObject({
      status: "unavailable",
      alternatives: [],
    });
  });

  test("migrates an existing receipt to pinned without changing config", async () => {
    const world = await fixture();
    await syncRouting({ ...world.options, routingPolicy: "follow" });
    const statePath = join(world.options.stateDir, "state.json");
    const legacy = JSON.parse(await world.state());
    delete legacy.routingPolicy;
    delete legacy.advice;
    delete legacy.dismissed;
    delete legacy.catalogFindings;
    await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = await readFile(world.options.configPath, "utf8");
    const beforeStat = await stat(world.options.configPath);
    const migrated = await syncRouting({ ...world.options, adopt: false });
    const afterStat = await stat(world.options.configPath);
    expect(migrated.routingPolicy).toBe("pinned");
    expect(await readFile(world.options.configPath, "utf8")).toBe(before);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("baseline save records routing, upstream identity and catalog with private mode", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const path = await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
      "fixture",
    );
    const value = JSON.parse(await readFile(path, "utf8"));
    expect(value).toMatchObject({
      reason: "fixture",
      upstream: { version: "1.0.0" },
      routing: {
        categories: { quick: { models: [{ model: "opencodex/gpt-6-luna", reasoning: "low" }] } },
      },
    });
    expect(value.catalog.some((model: { id: string }) => model.id === "gpt-6-luna")).toBe(true);
    expect(
      (await import("node:fs/promises")).stat(path).then((value) => value.mode & 0o777),
    ).resolves.toBe(0o600);
    expect((await readRoutingAdvice(world.options.stateDir)).unchanged).toBe(
      "upstream routing unchanged since baseline 2026-09-27 (omo-ai 1.0.0)",
    );
  });

  test.each([
    ["removed", undefined, "removed"],
    ["context", { contextWindow: 100_000 }, "context_shrank"],
    ["image", { input: ["text"] }, "lost_image"],
    ["reasoning", { reasoning: false }, "reasoning_flipped"],
  ] as const)("catalog health reports %s for a referenced model", async (_name, change, issue) => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const raw = JSON.parse(await readFile(world.catalogPath, "utf8"));
    const models = raw.providers.opencodex.models as Array<Record<string, unknown>>;
    raw.providers.opencodex.models = change
      ? models.map((model) => (model["id"] === "gpt-6-luna" ? { ...model, ...change } : model))
      : models.filter((model) => model["id"] !== "gpt-6-luna");
    await writeFile(world.catalogPath, JSON.stringify(raw));
    const next = await syncRouting({ ...world.options, adopt: false, force: true });
    expect(
      next.catalogFindings.some(
        (finding) => finding.model === "gpt-6-luna" && finding.issue === issue,
      ),
    ).toBe(true);
  });

  test("catalog health recognizes a renamed or aliased accepted model", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const raw = JSON.parse(await readFile(world.catalogPath, "utf8"));
    raw.providers.opencodex.models = raw.providers.opencodex.models.map(
      (model: Record<string, unknown>) =>
        model["id"] === "gpt-6-luna" ? { ...model, id: "gpt-6-luna-renamed" } : model,
    );
    await writeFile(world.catalogPath, JSON.stringify(raw));
    const next = await syncRouting({ ...world.options, adopt: false, force: true });
    expect(next.catalogFindings).toContainEqual(
      expect.objectContaining({
        model: "gpt-6-luna",
        issue: "renamed_or_aliased",
        after: "gpt-6-luna-renamed",
      }),
    );
  });

  test("ordinary sync detects metadata changes after effective MODEL_CATALOG overrides", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const raw = JSON.parse(await readFile(world.catalogPath, "utf8"));
    raw.providers.opencodex.models = raw.providers.opencodex.models.map(
      (model: Record<string, unknown>) =>
        model["id"] === "gpt-6-luna" ? { ...model, contextWindow: 100_000 } : model,
    );
    await writeFile(world.catalogPath, JSON.stringify(raw));
    expect(
      (await syncRouting({ ...world.options, adopt: false })).catalogFindings.some(
        (finding) => finding.issue === "context_shrank",
      ),
    ).toBe(true);

    raw.providers.opencodex.models = raw.providers.opencodex.models.map(
      (model: Record<string, unknown>) =>
        model["id"] === "gpt-6-luna"
          ? { ...model, contextWindow: 1_000_000, maxTokens: 32_000 }
          : model,
    );
    await writeFile(world.catalogPath, JSON.stringify(raw));
    const corrected = await syncRouting({ ...world.options, adopt: false });
    expect(
      corrected.catalogFindings.some(
        (finding) => finding.issue === "max_tokens_shrank" || finding.issue === "placeholder_32000",
      ),
    ).toBe(false);
  });

  test("a baseline without catalog reports the missing snapshot and receipt fallback", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const baselinePath = await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    delete baseline.catalog;
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    const before = await readFile(baselinePath, "utf8");
    const checked = await syncRouting({ ...world.options, adopt: false, check: true, force: true });
    expect(checked.catalogFindings).toContainEqual(
      expect.objectContaining({ issue: "no_snapshot" }),
    );
    expect(await readFile(baselinePath, "utf8")).toBe(before);
  });

  test("explicit follow persists on unchanged inputs and follows the next update", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    const followed = await syncRouting({
      ...world.options,
      adopt: false,
      routingPolicy: "follow",
    });
    expect(followed.routingPolicy).toBe("follow");
    expect(JSON.parse(await world.state()).routingPolicy).toBe("follow");
    await writeFile(world.bundle, source("gpt-6-sol"));
    const next = await syncRouting({ ...world.options, adopt: false });
    expect(next.managed.categories["quick"]).toEqual({
      models: [{ model: "opencodex/gpt-6-sol", reasoning: "low" }],
    });
  });

  test("follow to pinned anchors accepted upstream to the followed routes", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await syncRouting({ ...world.options, adopt: false, routingPolicy: "follow" });
    await writeFile(world.bundle, source("gpt-6-sol"));
    const followed = await syncRouting({ ...world.options, adopt: false });
    expect(followed.acceptedUpstream?.categories["deep-low"]).toEqual({
      models: [{ model: "opencodex/gpt-6-sol", reasoning: "low" }],
    });
    const pinned = await syncRouting({
      ...world.options,
      adopt: false,
      routingPolicy: "pinned",
    });
    expect(pinned.advice).toEqual([]);
    expect(pinned.acceptedUpstream?.categories["deep-low"]).toEqual(
      followed.acceptedUpstream?.categories["deep-low"],
    );
    await writeFile(world.bundle, source("gpt-6-luna"));
    const rollback = await syncRouting({ ...world.options, adopt: false });
    expect(rollback.advice.find((item) => item.path === "categories.deep-low")).toMatchObject({
      before: { models: [{ model: "opencodex/gpt-6-sol", reasoning: "low" }] },
      after: { models: [{ model: "opencodex/gpt-6-luna", reasoning: "low" }] },
    });
    expect(
      (await syncRouting({ ...world.options, adopt: false, apply: ["categories.deep-low"] }))
        .changes,
    ).toEqual(["categories.deep-low"]);
  });

  test("advice before is the prior upstream route, not the customized user baseline", async () => {
    const world = await fixture();
    const first = await syncRouting(world.options);
    const customized = editRoutingConfig(await readFile(world.options.configPath, "utf8"), {
      categories: { ...first.managed.categories, quick: { models: ["opencodex/gpt-6-terra"] } },
      agents: first.managed.agents,
    });
    await writeFile(world.options.configPath, customized);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "gpt-6-terra"]);
    await writeFile(world.bundle, source("gpt-6-sol"));
    const quick = (await syncRouting({ ...world.options, adopt: false, check: true })).advice.find(
      (item) => item.path === "categories.quick",
    );
    expect(quick?.before).toEqual({
      models: [{ model: "opencodex/gpt-6-luna", reasoning: "low" }],
    });
    expect(quick?.current).toEqual({ models: ["opencodex/gpt-6-terra"] });
  });

  test("manager settings model is included in catalog health references", async () => {
    const world = await fixture();
    const settingsPath = join(dirname(world.options.configPath), "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: "opencodex",
        defaultModel: "manager-only",
        defaultThinkingLevel: "high",
      }),
    );
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "manager-only"]);
    await syncRouting({ ...world.options, managerSettingsPath: settingsPath });
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol"]);
    const result = await syncRouting({
      ...world.options,
      adopt: false,
      managerSettingsPath: settingsPath,
    });
    expect(result.catalogFindings).toContainEqual(
      expect.objectContaining({ model: "manager-only", issue: "removed", roles: ["manager"] }),
    );
  });

  test("dismissed advice is not described as unchanged upstream", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await writeFile(world.bundle, source("gpt-6-sol"));
    const advice = await syncRouting({ ...world.options, adopt: false });
    await dismissRoutingAdvice(
      world.options.stateDir,
      advice.advice.map((item) => item.path),
    );
    const summary = await readRoutingAdvice(world.options.stateDir);
    expect(summary.unchanged).toBeUndefined();
    expect(summary.line).toContain("differs from baseline");
  });

  test("baseline and manager-settings changes invalidate cached advice", async () => {
    const world = await fixture();
    const settingsPath = join(dirname(world.options.configPath), "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: "opencodex",
        defaultModel: "gpt-6-luna",
        defaultThinkingLevel: "high",
      }),
    );
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "manager-only"]);
    await syncRouting({ ...world.options, managerSettingsPath: settingsPath });
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const raw = JSON.parse(await readFile(world.catalogPath, "utf8"));
    raw.providers.opencodex.models = raw.providers.opencodex.models.map(
      (model: Record<string, unknown>) =>
        model["id"] === "gpt-6-luna" ? { ...model, input: ["text"] } : model,
    );
    await writeFile(world.catalogPath, JSON.stringify(raw));
    expect(
      (await syncRouting({ ...world.options, adopt: false, managerSettingsPath: settingsPath }))
        .catalogFindings,
    ).not.toEqual([]);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    expect(
      (await syncRouting({ ...world.options, adopt: false, managerSettingsPath: settingsPath }))
        .catalogFindings,
    ).toEqual([]);

    await world.setCatalog(["gpt-6-luna", "gpt-6-sol"]);
    await syncRouting({ ...world.options, adopt: false, managerSettingsPath: settingsPath });
    await writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: "opencodex",
        defaultModel: "manager-only",
        defaultThinkingLevel: "high",
      }),
    );
    expect(
      (
        await syncRouting({
          ...world.options,
          adopt: false,
          managerSettingsPath: settingsPath,
        })
      ).catalogFindings,
    ).toContainEqual(expect.objectContaining({ model: "manager-only", roles: ["manager"] }));
  });

  test("incomplete metadata skips only that model and reports a limitation", async () => {
    const world = await fixture();
    const settingsPath = join(dirname(world.options.configPath), "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: "opencodex",
        defaultModel: "manager-only",
        defaultThinkingLevel: "high",
      }),
    );
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "manager-only"]);
    await syncRouting({ ...world.options, managerSettingsPath: settingsPath });
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const raw = JSON.parse(await readFile(world.catalogPath, "utf8"));
    raw.providers.opencodex.models = [
      ...raw.providers.opencodex.models.filter(
        (model: { id: string }) => model.id !== "manager-only",
      ),
      { id: "unrelated-metadata-pending" },
    ];
    await writeFile(world.catalogPath, JSON.stringify(raw));
    const result = await syncRouting({
      ...world.options,
      adopt: false,
      managerSettingsPath: settingsPath,
    });
    expect(result.catalogFindings).toContainEqual(
      expect.objectContaining({ model: "manager-only", issue: "removed", roles: ["manager"] }),
    );
    expect(result.catalogFindings).toContainEqual(
      expect.objectContaining({
        issue: "metadata_unavailable",
        before: 1,
      }),
    );
  });

  test("present models without metadata are not reported as removed", async () => {
    const world = await fixture();
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol"]);
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const raw = JSON.parse(await readFile(world.catalogPath, "utf8"));
    raw.providers.opencodex.models = raw.providers.opencodex.models.map(
      (model: { id: string }) => ({ id: model.id }),
    );
    await writeFile(world.catalogPath, JSON.stringify(raw));
    const findings = (await syncRouting({ ...world.options, adopt: false, force: true }))
      .catalogFindings;
    expect(findings.filter((finding) => finding.issue !== "metadata_unavailable")).toEqual([]);
    expect(findings).toContainEqual(
      expect.objectContaining({ issue: "metadata_unavailable", before: 2 }),
    );
  });

  test("unchanged accepted catalog has no health findings", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await saveRoutingBaseline(
      world.options.configPath,
      world.catalogPath,
      world.options.stateDir,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    expect(
      (await syncRouting({ ...world.options, adopt: false, force: true })).catalogFindings,
    ).toEqual([]);
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
    await writeFile(world.options.catalogPath, JSON.stringify({ providers: { other: {} } }));
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
    await world.setCatalog(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "anthropic/claude-opus-5-5"]);
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
        expect(code).toBe(0);
        return { stderr, receipt: receiptSchema.parse(JSON.parse(stdout)) };
      }),
    );
    expect(new Set(results.map((result) => result.receipt.generation)).size).toBe(1);
    expect(results.every((result) => result.receipt.routingPolicy === "pinned")).toBe(true);
    // The fixture's one-model routes warn once; the serialized second start stays quiet.
    expect(results.map((result) => result.stderr).join("")).toMatch(
      /^Proxy routing: Model chain warnings: categories\.visual-engineering \(no fallback: only gpt-6-luna is available\);[^\n]*\n$/,
    );
  }, 15000);

  test.each(["dismiss", "baseline", "scope"] as const)(
    "%s waits for the routing lock",
    async (command) => {
      const world = await fixture();
      await syncRouting(world.options);
      if (command === "dismiss") {
        await writeFile(world.bundle, source("gpt-6-sol"));
        await syncRouting({ ...world.options, adopt: false });
      }
      const lockReady = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = Bun.spawn(
        [
          "python3",
          "-c",
          "import fcntl,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('READY',flush=True); sys.stdin.read()",
          join(world.options.stateDir, "sync.lock"),
        ],
        { stdin: "pipe", stdout: "pipe" },
      );
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      if (new TextDecoder().decode(first.value).includes("READY")) lockReady.resolve();
      await lockReady.promise;
      const args = [
        process.execPath,
        resolve(import.meta.dir, "../../scripts/proxy-routing.ts"),
        ...(command === "dismiss"
          ? ["dismiss", "categories.deep-low"]
          : command === "baseline"
            ? ["baseline", "save"]
            : ["scope", "all"]),
        "--config",
        world.options.configPath,
        "--state-dir",
        world.options.stateDir,
        "--catalog",
        world.options.catalogPath,
      ];
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(child.exitCode).toBeNull();
      holder.stdin.end();
      await holder.exited;
      release.resolve();
      expect(await child.exited).toBe(0);
    },
  );

  test("CLI apply parses fixture path flags separately from route paths", async () => {
    const world = await fixture();
    await syncRouting(world.options);
    await writeFile(world.bundle, source("gpt-6-sol"));
    await syncRouting({ ...world.options, adopt: false });
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../scripts/proxy-routing.ts"),
        "apply",
        "categories.deep-low",
        "--upstream",
        world.options.upstream,
        "--config",
        world.options.configPath,
        "--state-dir",
        world.options.stateDir,
        "--catalog",
        world.options.catalogPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
  });

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
