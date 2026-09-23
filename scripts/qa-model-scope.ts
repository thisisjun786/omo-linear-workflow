import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readReferencedModels, scopePreferenceSchema } from "../src/proxy/model-scope";
import { atomicText, optionalText } from "../src/proxy/routing-config";

const root = resolve(import.meta.dir, "..");
const modelSchema = z.object({ provider: z.string(), id: z.string() });
const responseSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
});
async function snapshot(extra: readonly string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "olw-scope-rpc-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "dist/omo.js"),
      "--mode",
      "rpc",
      "--no-session",
      "--no-skills",
      "--no-context-files",
      "--no-model-fallback",
      "--no-extensions",
      "-e",
      join(root, "dist/proxy/index.js"),
      ...extra,
    ],
    { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const deadline = AbortSignal.timeout(120000);
  const abort = () => child.kill();
  deadline.addEventListener("abort", abort, { once: true });
  const stderr = new Response(child.stderr).text();
  const replies = new Map<string, unknown>();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    // Subscribe before triggering the two read-only RPC requests.
    const reading = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("{")) continue;
          const event = responseSchema.safeParse(JSON.parse(line));
          if (!event.success || !["scope-state", "scope-catalog"].includes(event.data.id)) continue;
          assert.ok(event.data.success, "RPC scope inspection failed");
          replies.set(event.data.id, event.data.data);
          if (replies.size === 2) await child.stdin.end();
        }
      }
    })();
    child.stdin.write(
      `${JSON.stringify({ type: "get_state", id: "scope-state" })}\n` +
        `${JSON.stringify({ type: "get_available_models", id: "scope-catalog" })}\n`,
    );
    await reading;
    assert.equal(await child.exited, 0, await stderr);
    const state = z
      .object({ scopedModels: z.array(z.object({ model: modelSchema })) })
      .parse(replies.get("scope-state"));
    const catalog = z.object({ models: z.array(modelSchema) }).parse(replies.get("scope-catalog"));
    return {
      scoped: state.scopedModels.map(({ model }) => `${model.provider}/${model.id}`).sort(),
      available: catalog.models.map((model) => `${model.provider}/${model.id}`).sort(),
    };
  } finally {
    deadline.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(cwd, { recursive: true, force: true });
  }
}

const home = process.env["HOME"] ?? "";
const expected = await readReferencedModels(
  join(home, ".omo/omo.jsonc"),
  join(home, ".omo/agent/settings.json"),
);
const preference = await optionalText(join(home, ".omo/proxy-routing/model-scope.json"));
const { mode } = scopePreferenceSchema.parse(preference ? JSON.parse(preference) : { mode: "all" });
const current = await snapshot([]);
if (mode === "referenced") {
  assert.deepEqual(current.scoped, expected);
  assert.ok(!current.scoped.includes("cliproxyapi/mimo-v2.6-flash"));
} else {
  const currentScope = current.scoped.length ? current.scoped : current.available;
  assert.ok(currentScope.length > expected.length);
  assert.ok(currentScope.includes("cliproxyapi/mimo-v2.6-flash"));
}
const full = await snapshot(["--models", "cliproxyapi/*"]);
const fullScope = full.scoped.length ? full.scoped : full.available;
assert.ok(fullScope.length > expected.length);
assert.ok(fullScope.includes("cliproxyapi/mimo-v2.6-flash"));
assert.deepEqual(full.available, current.available, "Scope must not delete callable models");
const evidence = {
  result: "MODEL_SCOPE_LIVE_OK",
  mode,
  referencedCount: expected.length,
  scoped: current.scoped,
  availableCount: full.available.length,
  fullScopeCount: fullScope.length,
};
await atomicText(
  join(root, ".omo/evidence/model-scope-live.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence));
