import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { nativeReceiptSchema } from "../../src/core/schema";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const callable = z.custom<(...args: unknown[]) => unknown>((value) => typeof value === "function");

test("native bundle marker verifies its body and recorded downstream inputs", async () => {
  const root = resolve(import.meta.dir, "../..");
  const raw: unknown = JSON.parse(
    await readFile(join(root, "patches/omo-ai-native-delivery.provenance.json"), "utf8"),
  );
  const provenance = z
    .object({
      inputs: z.object({
        format: z.literal("olw-downstream-bundle-v1"),
        package: z.literal("omo-ai"),
        version: z.string(),
        path: z.literal("plugin/extensions/omo.js"),
        upstreamSha256: z.string(),
        upstreamMarker: z.string(),
        edits: z.array(
          z.object({ offset: z.number().int().nonnegative(), old: z.string(), new: z.string() }),
        ),
      }),
      output: z.object({ marker: z.string(), bodySha256: z.string() }),
    })
    .parse(raw);
  const source = await readFile(join(root, "node_modules/omo-ai/plugin/extensions/omo.js"), "utf8");
  const newline = source.indexOf("\n");
  const marker = source.slice(0, newline);
  const body = source.slice(newline + 1);
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify(provenance.inputs))
    .digest("base64url");
  const bodyDigest = createHash("sha256").update(body).digest("base64url");
  expect(marker).toBe(`// omo:${sourceDigest}:${bodyDigest}`);
  expect(marker).toBe(provenance.output.marker);
  expect(createHash("sha256").update(body).digest("hex")).toBe(provenance.output.bodySha256);
  let original = `${provenance.inputs.upstreamMarker}\n${body}`;
  for (const change of provenance.inputs.edits.toReversed()) {
    expect(original.slice(change.offset, change.offset + change.new.length)).toBe(change.new);
    original =
      original.slice(0, change.offset) +
      change.old +
      original.slice(change.offset + change.new.length);
  }
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    provenance.inputs.upstreamSha256,
  );
});

async function fixture() {
  const root = resolve(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), "olw-native-delivery-"));
  roots.push(directory);
  const source = await readFile(join(root, "node_modules/omo-ai/plugin/extensions/omo.js"), "utf8");
  const atomicStart = source.indexOf("import{closeSync as Zm");
  const atomicEnd = source.indexOf("import{closeSync as cg");
  const threadsStart = source.indexOf("import{Type as I7");
  const threadsEnd = source.indexOf("import{createConnection as Qee");
  if (atomicStart < 0 || atomicEnd <= atomicStart || threadsStart < 0 || threadsEnd <= threadsStart)
    throw new Error("Pinned native thread factory extraction boundary changed");
  const resolver = join(root, "node_modules/@code-yeongyu/senpi");
  const executable = (source.slice(atomicStart, atomicEnd) + source.slice(threadsStart, threadsEnd))
    .replaceAll(
      'from"typebox"',
      `from ${JSON.stringify(pathToFileURL(Bun.resolveSync("typebox", resolver)).href)}`,
    )
    .replaceAll(
      'from"typebox/value"',
      `from ${JSON.stringify(pathToFileURL(Bun.resolveSync("typebox/value", resolver)).href)}`,
    );
  const modulePath = join(directory, "native.mjs");
  await writeFile(modulePath, `${executable}\nexport { Zee as createTools };\n`);
  const imported: unknown = await import(pathToFileURL(modulePath).href);
  const native = z.object({ createTools: callable }).parse(imported);
  const snapshotEntered = Promise.withResolvers<void>();
  const releaseSnapshot = Promise.withResolvers<void>();
  const promptEntered = Promise.withResolvers<void>();
  const releasePrompt = Promise.withResolvers<void>();
  const state: {
    active: boolean;
    turnId: string | undefined;
    gateNextSnapshot: boolean;
    dropAck: boolean;
    promptCalls: number;
    accepted: number;
    stateReads: number;
  } = {
    active: true,
    turnId: "initialization",
    gateNextSnapshot: false,
    dropAck: false,
    promptCalls: 0,
    accepted: 0,
    stateReads: 0,
  };
  const raw = native.createTools({
    stateDirectory: directory,
    callerSessionId: () => "supervisor",
    callerWorkspaceRoot: () => directory,
    host: {
      socket: join(directory, "unused.sock"),
      listSessions: async () => [
        { sessionId: "route-parent", durableSessionId: "parent", cwd: directory },
      ],
      getState: async () => {
        state.stateReads += 1;
        if (state.gateNextSnapshot) {
          state.gateNextSnapshot = false;
          snapshotEntered.resolve();
          await releaseSnapshot.promise;
        }
        return {
          isStreaming: state.active,
          ...(state.turnId === undefined ? {} : { activeTurnId: state.turnId }),
        };
      },
      prompt: async () => {
        state.promptCalls += 1;
        state.accepted += 1;
        promptEntered.resolve();
        if (state.dropAck) {
          await releasePrompt.promise;
          throw new Error("thread RPC connection closed before the prompt response arrived");
        }
        return { turnId: "work" };
      },
    },
  });
  const tools = z.array(z.object({ name: z.string(), execute: callable })).parse(raw);
  const send = tools.find((tool) => tool.name === "thread_send");
  if (!send) throw new Error("Pinned native thread_send missing");
  return {
    state,
    snapshotEntered,
    releaseSnapshot,
    promptEntered,
    releasePrompt,
    async call(key: string) {
      const result = await send.execute(`call-${key}`, {
        thread: "parent",
        message: "one logical instruction",
        delivery: "auto",
        all_scope: true,
        idempotency_key: key,
      });
      return z.object({ details: z.object({ result: nativeReceiptSchema }) }).parse(result).details
        .result;
    },
  };
}

test("native pre-delivery turn conflict is distinct and replay cannot re-read the target", async () => {
  const f = await fixture();
  f.state.gateNextSnapshot = true;
  const pending = f.call("logical");
  await f.snapshotEntered.promise;
  f.state.turnId = undefined;
  f.releaseSnapshot.resolve();
  const rejected = await pending;
  expect(rejected).toMatchObject({
    kind: "error",
    error: { code: "turn_conflict_before_delivery" },
  });
  expect(f.state.promptCalls).toBe(0);
  f.state.turnId = "work";
  const reads = f.state.stateReads;
  expect(await f.call("logical")).toEqual(rejected);
  expect(f.state.stateReads).toBe(reads);
  expect(await f.call("logical-attempt-2")).toMatchObject({ kind: "ok" });
  expect(f.state.accepted).toBe(1);
});

test.each([true, false])(
  "native accepted prompt with lost ACK remains uncertain when active=%s",
  async (active) => {
    const f = await fixture();
    f.state.active = active;
    f.state.dropAck = true;
    const pending = f.call("lost-ack");
    await f.promptEntered.promise;
    expect(f.state.accepted).toBe(1);
    f.releasePrompt.resolve();
    const uncertain = await pending;
    expect(uncertain).toMatchObject({ kind: "error", error: { code: "idempotency_uncertain" } });
    expect(await f.call("lost-ack")).toEqual(uncertain);
    expect(f.state.accepted).toBe(1);
  },
);
