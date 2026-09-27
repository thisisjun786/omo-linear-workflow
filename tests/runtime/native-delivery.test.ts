import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { deliveryRecordSchema, nativeReceiptSchema, resultSchema } from "../../src/core/schema";
import { openRegistry } from "../../src/core/store";
import { registerInitiativeRuntime } from "../../src/extension/runtime";
import {
  context,
  envelope,
  Harness,
  linkReadyManager,
  fixture as runtimeFixture,
  value,
} from "../runtime-harness";

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

async function fixture(targetId = "parent") {
  const root = resolve(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), "olw-native-delivery-"));
  roots.push(directory);
  const source = await readFile(join(root, "node_modules/omo-ai/plugin/extensions/omo.js"), "utf8");
  const atomicStart = source.indexOf("import{closeSync as oy");
  const atomicEnd = source.indexOf("import{closeSync as yy");
  const threadsStart = source.indexOf("import{Type as gte");
  const threadsEnd = source.indexOf("import{createConnection as Une");
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
  await writeFile(modulePath, `${executable}\nexport { Bne as createTools };\n`);
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
        { sessionId: "route-parent", durableSessionId: targetId, cwd: directory },
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
    async execute(input: unknown) {
      return z
        .object({ details: z.object({ result: z.unknown() }) })
        .parse(await send.execute("native-manager", input));
    },
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

test("manager busy race reenters event admission before native auto; no mailbox polling or duplicate", async () => {
  await runtimeFixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const native = await fixture(manager.durableSessionId);
      const harness = new Harness();
      const nextIdle = Promise.withResolvers<void>();
      const waitingAgain = Promise.withResolvers<void>();
      let waits = 0;
      let nativeCalls = 0;
      harness.isIdle = () => !native.state.active;
      harness.waitForIdle = async () => {
        waits++;
        if (waits === 1) native.state.active = false;
        else {
          waitingAgain.resolve();
          await nextIdle.promise;
        }
      };
      harness.executeTool = async (name, input) => {
        // Race after initial admission, during the actual tool preflight.
        native.state.active = true;
        const decision = await harness.guard()(
          name,
          z.record(z.string(), z.unknown()).parse(input),
          context(parent),
        );
        expect(decision).toBeUndefined();
        nativeCalls++;
        return native.execute(input);
      };
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const timeout = globalThis.setTimeout;
      const delays: number[] = [];
      const timerSpy = spyOn(globalThis, "setTimeout");
      const message = envelope(parent, manager, digest, "native-busy-race", "report");
      const send = harness.rpc("omo.initiative.send");
      const pending = send(message);
      const deadline = timeout(() => waitingAgain.reject(new Error("No event readmission")), 3000);
      try {
        await waitingAgain.promise;
        expect(nativeCalls).toBe(0);
        expect(native.state.promptCalls).toBe(0);
        native.state.active = false;
        native.state.turnId = undefined;
        nextIdle.resolve();
        expect(value(resultSchema(deliveryRecordSchema).parse(await pending)).state).toBe(
          "accepted",
        );
        await send(message);
        expect(nativeCalls).toBe(1);
        expect(native.state.accepted).toBe(1);
        for (const call of timerSpy.mock.calls)
          if (typeof call[1] === "number") delays.push(call[1]);
        expect(delays).not.toContain(50);
      } finally {
        clearTimeout(deadline);
        nextIdle.resolve();
        timerSpy.mockRestore();
      }
    } finally {
      registry.close();
    }
  });
});

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
