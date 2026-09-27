import { mock, setSystemTime } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import * as senpi from "@code-yeongyu/senpi";
import { z } from "zod";
import * as native from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/store.js";
import type {
  Goal,
  GoalStoreRef,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/types.js";
import { createBunExtensionImporter } from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/bun-extension-importer.js";
import { serializeByKey } from "../../node_modules/@code-yeongyu/senpi/dist/core/session-sidecar-store.js";

const mode = process.argv[2];
const root = resolve(import.meta.dir, "../..");
const directory = await fs.mkdtemp(join(root, ".omo/evidence/goal-race-"));
const goalFile = join(directory, "child.json");
const ref = { baseDir: directory, threadId: "child" };
const ctx = { goalStoreFile: goalFile, sessionManager: { getSessionId: () => "child" } };
type Context = typeof ctx;
const actualRead = fs.readFile;
let gate:
  | {
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    }
  | undefined;
function arm() {
  const next = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  gate = next;
  return next;
}
mock.module("node:fs/promises", () => ({
  ...fs,
  readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const result = await actualRead(...args);
    if (gate && String(args[0]) === goalFile) {
      const current = gate;
      gate = undefined;
      current.entered.resolve();
      await current.release.promise;
    }
    return result;
  },
}));
const importer = createBunExtensionImporter({ "@code-yeongyu/senpi": senpi });
const schema = z.object({
  pauseGoal: z.custom<(ctx: Context) => Promise<{ id: string; updatedAt: number } | null | false>>(
    (value) => typeof value === "function",
  ),
  resumeGoal: z.custom<
    (
      ctx: Context,
      token: { id: string; updatedAt: number },
      onOwnershipLost?: () => void,
    ) => Promise<void>
  >((value) => typeof value === "function"),
  compareAndSetGoalStatus: z.custom<
    (
      ref: GoalStoreRef,
      expected: Pick<Goal, "id" | "status" | "updatedAt">,
      status: "active" | "paused",
    ) => Promise<Goal | null>
  >((value) => typeof value === "function"),
  nativeSerialize: z.custom<typeof serializeByKey>((value) => typeof value === "function"),
});
const timeout = setTimeout(() => {
  console.error(`Goal race barrier timed out: ${mode}`);
  process.exit(1);
}, 8000);
try {
  // Build the actual shipped entry point, not a source-only adapter surrogate.
  let source: string;
  if (process.argv[3] === "dist")
    source = await actualRead(join(root, "dist/extension/index.js"), "utf8");
  else {
    const build = await Bun.build({
      entrypoints: [join(root, "src/extension/index.ts")],
      target: "node",
      format: "esm",
      packages: "external",
      minify: false,
    });
    assert.equal(build.success, true, String(build.logs));
    const output = build.outputs[0];
    assert.ok(output);
    source = await output.text();
  }
  await fs.writeFile(
    join(directory, "shipped.js"),
    `${source}\nconst nativeSerialize = requireSenpi("./core/session-sidecar-store.js").serializeByKey;\nexport { pauseGoal, resumeGoal, compareAndSetGoalStatus, nativeSerialize };\n`,
  );
  await fs.writeFile(
    join(directory, "entry.js"),
    'import {pauseGoal,resumeGoal,compareAndSetGoalStatus,nativeSerialize} from "./shipped.js"; export default {pauseGoal,resumeGoal,compareAndSetGoalStatus,nativeSerialize};',
  );
  // Use the same generation importer as the real host; plain import misses a
  // second duplication risk even when the build leaves static imports external.
  const shipped = schema.parse(
    await importer.import(join(directory, "entry.js"), { default: true }),
  );
  await native.createGoal(ref, "packet");
  if (mode === "resume-during-pause" || mode === "model-during-pause") {
    const barrier = arm();
    const pending = shipped.pauseGoal(ctx);
    await barrier.entered.promise;
    const user = await native.updateGoal(
      ref,
      mode === "resume-during-pause" ? { status: "active" } : { status: "complete" },
      mode === "resume-during-pause" ? "user" : "model",
    );
    barrier.release.resolve();
    assert.equal(await pending, false);
    assert.deepEqual(await native.readGoal(ref), user);
  } else if (mode === "user-pause-during-release") {
    const token = await shipped.pauseGoal(ctx);
    assert.ok(token);
    const barrier = arm();
    let relinquished = false;
    const pending = shipped.resumeGoal(ctx, token, () => {
      relinquished = true;
    });
    await barrier.entered.promise;
    await native.updateGoal(ref, { status: "active" }, "user");
    const user = await native.updateGoal(ref, { status: "paused" }, "user");
    barrier.release.resolve();
    await pending;
    assert.equal(relinquished, true);
    assert.deepEqual(await native.readGoal(ref), user);
  } else if (mode === "transition-shape") {
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    for (const status of ["paused", "active"] as const) {
      let before = await native.readGoal(ref);
      assert.ok(before);
      if (status === "active") {
        await native.updateGoal(ref, { status: "paused" }, "user");
        before = await native.readGoal(ref);
        assert.ok(before);
      }
      const seeded = {
        ...before,
        tokenBudget: 42,
        tokensUsed: 123,
        timeUsedSeconds: 7,
        consecutiveContinuations: 3,
        unattendedContinuations: 5,
        lastContinuationSignature: "packet-progress",
      };
      await native.writeGoal(ref, seeded);
      const expected = await native.updateGoal(ref, { status }, "user");
      const expectedBytes = await actualRead(goalFile, "utf8");
      const expectedFiles = await fs.readdir(directory);
      await native.writeGoal(ref, seeded);
      assert.deepEqual(await shipped.compareAndSetGoalStatus(ref, seeded, status), expected);
      assert.equal(await actualRead(goalFile, "utf8"), expectedBytes);
      assert.deepEqual(await fs.readdir(directory), expectedFiles);
    }
  } else if (mode === "shared-lock") {
    assert.equal(
      shipped.nativeSerialize,
      serializeByKey,
      "Built generation must share the host's exact lock function/module",
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const locked = serializeByKey(goalFile, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const barrier = arm();
    const pending = shipped.pauseGoal(ctx);
    await barrier.entered.promise;
    // Both successors are queued while the exact native key is held. The user
    // transition must win before OLW's compare-and-set is admitted.
    const user = native.updateGoal(ref, { status: "active" }, "user");
    barrier.release.resolve();
    release.resolve();
    await locked;
    const expected = await user;
    assert.equal(await pending, false);
    assert.deepEqual(await native.readGoal(ref), expected);
  } else throw new Error(`Unknown race ${mode}`);
  console.log(
    JSON.stringify({
      mode,
      passed: true,
      importer: "native",
      artifact: "built extension/index.js",
    }),
  );
} finally {
  gate?.release.resolve();
  clearTimeout(timeout);
  importer.dispose();
  await fs.rm(directory, { recursive: true, force: true });
}
