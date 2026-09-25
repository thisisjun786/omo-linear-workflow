import assert from "node:assert/strict";
import { watch as watchDirectory } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type RpcClient, SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import { modelForRole } from "../src/core/policy";
import { bindingSchema, deliveryRecordSchema, nativeReceiptSchema } from "../src/core/schema";
import { attach, idle } from "./qa-hierarchy";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const created = z.object({ binding: bindingSchema });
type Event = Parameters<Parameters<RpcClient["onEvent"]>[0]>[0];

function watch(client: RpcClient, predicate: (event: Event) => boolean, label: string) {
  const signal = Promise.withResolvers<Event>();
  const timer = setTimeout(() => signal.reject(new Error(`Timed out: ${label}`)), 120_000);
  const off = client.onEvent((event) => {
    if (predicate(event)) signal.resolve(event);
  });
  return {
    promise: signal.promise,
    close() {
      clearTimeout(timer);
      off();
    },
  };
}

function fileSignal(path: string) {
  const signal = Promise.withResolvers<unknown>();
  const timer = setTimeout(
    () => signal.reject(new Error(`Timed out waiting for atomic signal ${path}`)),
    120_000,
  );
  const watcher = watchDirectory(dirname(path), (_event, name) => {
    if (name === basename(path)) {
      readFile(path, "utf8")
        .then((text) => JSON.parse(text))
        .then(signal.resolve, signal.reject);
    }
  });
  watcher.on("error", signal.reject);
  return {
    promise: signal.promise,
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

async function main() {
  const qa = await prepareQaWorld();
  const mode = z.enum(["delivery", "report", "notice"]).parse(process.argv[2] ?? "delivery");
  const evidence = join(
    qa.installRoot,
    `.omo/evidence/real-use-repairs/${mode === "notice" ? "lina-145" : "lina-142"}/${mode === "report" ? "report-native" : "native"}`,
  );
  const clients: RpcClient[] = [];
  const log: {
    root: string;
    result: string;
    recovery?: unknown;
    metadataLoss?: unknown;
    identity?: unknown;
    error?: string;
    cleanup?: string;
    cleanupError?: string;
    diagnostics?: unknown[];
    notices?: unknown;
  } = { root: qa.scratch, result: "incomplete" };
  let failure: unknown;
  const invoke = async (args: string[]) => {
    const reply = await qa.cli(args);
    assert.equal(reply.code, 0, JSON.stringify(reply));
    return success.parse(JSON.parse(reply.stdout)).value;
  };
  try {
    const builderPath = join(qa.controlRoot, "qa-profile-builder.ts");
    await cp(join(qa.installRoot, "src/host-profile.ts"), builderPath);
    const builder: typeof import("../src/host-profile") = await import(
      pathToFileURL(builderPath).href
    );
    const profilePath = await builder.createHostProfile(qa.controlRoot);
    const profile = z
      .object({ core: z.object({ extensions: z.array(z.string()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(await readFile(profilePath, "utf8")));
    const extensionPath = join(qa.controlRoot, "qa-repair-extension.ts");
    await cp(join(qa.installRoot, "scripts/qa-repair-extension.ts"), extensionPath);
    profile.core.extensions.push(extensionPath);
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    await checkedQaCommand(
      [
        join(qa.controlRoot, "node_modules/.bin/omo"),
        "host",
        "ensure",
        "--launch-spec",
        profilePath,
        "--socket",
        join(qa.controlRoot, ".omo/state/omo.sock"),
        "--policy",
        "never",
      ],
      qa.controlRoot,
      { ...qa.environment, ...builder.runtimeCacheEnvironment(qa.controlRoot) },
    );
    const scopePath = join(qa.scratch, "scope.json");
    await cp(join(qa.installRoot, "tests/fixtures/scope.json"), scopePath);
    const scope = z
      .object({ digest: z.string() })
      .parse(await invoke(["scope", "import", "--file", scopePath, "--fixture"]));
    const supervisor = created.parse(
      await invoke([
        "supervisor",
        "create",
        "--initiative",
        "initiative-omo-1",
        "--scope-digest",
        scope.digest,
        "--designation",
        "native-delivery-qa",
        "--execute",
        "--fixture",
      ]),
    ).binding;
    const parent = created.parse(
      await invoke([
        "parent",
        "create",
        "--supervisor",
        supervisor.id,
        "--project",
        "project-omo-1",
        "--repo",
        qa.repository,
        "--base",
        "main",
      ]),
    ).binding;
    const sourceBinding = mode === "report" ? parent : supervisor;
    const targetBinding = mode === "report" ? supervisor : parent;
    const sender = await attach(sourceBinding);
    clients.push(sender);
    const receiver = await attach(targetBinding);
    clients.push(receiver);
    for (const client of clients) {
      await client.setClientInfo(120, ["extension_events"]);
      await idle(client);
    }
    await mkdir(join(parent.cwd, ".omo/qa-repair"), { recursive: true });
    await mkdir(join(supervisor.cwd, ".omo/qa-repair"), { recursive: true });
    const parentClient = mode === "report" ? sender : receiver;
    const before = await parentClient.getState();
    if (mode === "notice") {
      const notices = async () =>
        z
          .array(deliveryRecordSchema)
          .parse(await invoke(["notices", "--project", "project-omo-1"]));
      const initial = await notices();
      assert.equal(initial.length, 0);
      const triggerFailure = async (nativeOwner: boolean) => {
        const previous = await notices();
        const status = z
          .object({ modelFallback: z.literal(false) })
          .parse(await receiver.requestExtension("qa.repair.status"));
        const nonce = crypto.randomUUID();
        const intercepted = fileSignal(join(parent.cwd, ".omo/qa-repair", `${nonce}.json`));
        const settled = watch(
          receiver,
          (event) => event.type === "agent_settled",
          "failed parent settled without fallback",
        );
        const managerSettled = nativeOwner
          ? watch(
              sender,
              (event) => event.type === "agent_settled",
              "manager received operational notice",
            )
          : undefined;
        try {
          await receiver.requestExtension("qa.repair.arm", { mode: "error", nonce });
          await Promise.all([
            receiver.prompt(
              `Respond briefly for isolated runtime-error QA ${nonce}. Do not implement work.`,
            ),
            intercepted.promise,
            settled.promise,
            ...(managerSettled ? [managerSettled.promise] : []),
          ]);
          const records = await notices();
          const added = records.filter(
            (record) => !previous.some((old) => old.envelope.id === record.envelope.id),
          );
          assert.equal(added.length, 1, JSON.stringify(records));
          const notice = added[0];
          assert.ok(notice);
          assert.equal(notice.envelope.kind, "operational_notice");
          assert.equal(notice.envelope.fromBindingId, parent.id);
          assert.equal(notice.envelope.toBindingId, nativeOwner ? supervisor.id : null);
          assert.equal(notice.state, nativeOwner ? "accepted" : "posted");
          assert.equal(notice.envelope.outcome, null);
          const failure = notice.envelope.operational?.failure;
          assert.ok(failure);
          assert.equal(failure.durableSessionId, parent.durableSessionId);
          assert.equal(failure.modelId, "claude-opus-5-5");
          const entries = SessionManager.open(failure.sessionPath).getBranch();
          const entry = z
            .object({
              message: z.object({
                role: z.literal("assistant"),
                stopReason: z.literal("error"),
                errorMessage: z.string(),
              }),
            })
            .parse(entries.find((row) => row.id === failure.sessionEntryId));
          assert.equal(entry.message.errorMessage, failure.errorMessage);
          assert.deepEqual(await invoke(["reports", "--project", "project-omo-1"]), []);
          if (nativeOwner) {
            const count = (await sender.getMessages()).filter(
              (message) =>
                message.role === "user" &&
                JSON.stringify(message.content).includes(notice.envelope.id),
            ).length;
            assert.equal(count, 1);
          }
          const ids = records.map((record) => record.envelope.id);
          assert.notEqual((await receiver.reload()).cancelled, true);
          assert.deepEqual(
            (await notices()).map((record) => record.envelope.id),
            ids,
          );
          const prior = (await receiver.getMessages()).length;
          const resumed = watch(
            receiver,
            (event) => event.type === "agent_settled",
            "same parent resumed after fault",
          );
          try {
            await Promise.all([
              receiver.prompt(
                `The owned QA fault is removed. Use native read on ${join(parent.cwd, "README.md")} and acknowledge without editing or reporting project completion.`,
              ),
              resumed.promise,
            ]);
          } finally {
            resumed.close();
          }
          const continuation = (await receiver.getMessages())
            .slice(prior)
            .filter((message) => message.role === "assistant");
          assert.ok(
            continuation.some((message) =>
              message.content.some((part) => part.type === "toolCall" && part.name === "read"),
            ),
          );
          assert.ok(continuation.every((message) => message.stopReason !== "error"));
          const after = await receiver.getState();
          assert.equal(after.sessionId, before.sessionId);
          assert.equal(after.model?.id, "claude-opus-5-5");
          assert.equal(after.thinkingLevel, "xhigh");
          return {
            status,
            notice,
            continuation: continuation.map((message) => ({
              stopReason: message.stopReason,
              content: message.content,
            })),
            sessionId: after.sessionId,
          };
        } finally {
          intercepted.close();
          settled.close();
          managerSettled?.close();
          await receiver.requestExtension("qa.repair.reset");
        }
      };
      const managed = await triggerFailure(true);
      const managerReply = (await sender.getMessages())
        .filter((message) => message.role === "assistant")
        .at(-1);
      await sender.stop();
      await invoke(["close", "--binding", supervisor.id]);
      const local = await triggerFailure(false);
      log.notices = { managed, managerReply, local };
    } else {
      const nonce = crypto.randomUUID();
      const intercepted = fileSignal(join(targetBinding.cwd, ".omo/qa-repair", `${nonce}.json`));
      const ended = watch(receiver, (event) => event.type === "agent_end", "held turn completion");
      const id = `qa-recovery-${crypto.randomUUID()}`;
      const body = join(qa.scratch, "instruction.txt");
      await writeFile(
        body,
        "This is an isolated transport QA instruction. Acknowledge briefly; do not start project work or send a report.",
      );
      const args = [
        mode === "report" ? "report" : "send",
        "--from",
        sourceBinding.id,
        ...(mode === "report"
          ? ["--outcome", "completed"]
          : ["--to", targetBinding.id, "--kind", "instruction"]),
        "--id",
        id,
        "--text-file",
        body,
      ];
      try {
        await receiver.requestExtension("qa.repair.arm", { mode: "hold", nonce });
        await Promise.all([
          receiver.prompt(
            `For isolated transport QA ${nonce}, use the native read tool on ${join(targetBinding.cwd, mode === "report" ? "package.json" : "README.md")}. Do not edit files or start project work.`,
          ),
          intercepted.promise,
        ]);
        console.log("QA_PHASE read tool gate observed");
        const busy = await receiver.getState();
        assert.equal(busy.isStreaming, true);
        const rejected = await qa.cli(args);
        assert.equal(rejected.code, 2, JSON.stringify(rejected));
        const refused = z
          .object({
            error: z.object({
              details: z.object({
                recovery: z.literal("retry_same_id"),
                delivery: deliveryRecordSchema,
              }),
            }),
          })
          .parse(JSON.parse(rejected.stdout));
        assert.equal(refused.error.details.delivery.receipt?.kind, "error");
        assert.equal(refused.error.details.delivery.attempts?.length, 1);
        await receiver.requestExtension("qa.repair.release");
        await ended.promise;
        await idle(receiver);
        const accepted = deliveryRecordSchema.parse(await invoke(args));
        assert.equal(accepted.state, "accepted");
        assert.deepEqual(accepted.envelope, refused.error.details.delivery.envelope);
        assert.equal(accepted.attempts?.length, 2);
        assert.notEqual(accepted.attempts?.[0]?.nativeKey, accepted.attempts?.[1]?.nativeKey);
        assert.deepEqual(deliveryRecordSchema.parse(await invoke(args)), accepted);
        await idle(receiver);
        const messages = await receiver.getMessages();
        const count = messages.filter(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(id),
        ).length;
        assert.equal(count, 1);
        log.recovery = { busy, rejected: refused, accepted, targetMessageCount: count };
      } finally {
        intercepted.close();
        ended.close();
        await receiver.requestExtension("qa.repair.reset");
      }
      await idle(receiver);
      const lostId = `qa-lost-receipt-${crypto.randomUUID()}`;
      const lostArgs = args.map((arg) => (arg === id ? lostId : arg));
      const original = fileSignal(join(sourceBinding.cwd, ".omo/qa-repair", `${lostId}.json`));
      try {
        await sender.requestExtension("qa.repair.drop-receipt", { id: lostId });
        const [lost, receiptEvent] = await Promise.all([qa.cli(lostArgs), original.promise]);
        const nativeAccepted = z
          .object({ id: z.literal(lostId), details: z.object({ result: nativeReceiptSchema }) })
          .parse(receiptEvent);
        assert.equal(nativeAccepted.details.result.kind, "ok");
        assert.equal(lost.code, 4, JSON.stringify(lost));
        const decoded = z
          .object({ error: z.object({ details: z.object({ delivery: deliveryRecordSchema }) }) })
          .parse(JSON.parse(lost.stdout));
        assert.equal(decoded.error.details.delivery.state, "uncertain");
        const repeated = await qa.cli(lostArgs);
        assert.equal(repeated.code, 4, JSON.stringify(repeated));
        const replay = z
          .object({ error: z.object({ details: z.object({ delivery: deliveryRecordSchema }) }) })
          .parse(JSON.parse(repeated.stdout));
        assert.deepEqual(replay.error.details.delivery, decoded.error.details.delivery);
        await idle(receiver);
        const count = (await receiver.getMessages()).filter(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(lostId),
        ).length;
        assert.equal(count, 1);
        log.metadataLoss = {
          boundary: "SDK tool-result metadata to OLW consumer, not host socket",
          receiptEvent,
          delivery: decoded,
          replay,
          targetMessageCount: count,
        };
      } finally {
        original.close();
        await sender.requestExtension("qa.repair.reset");
      }
    }
    const after = await parentClient.getState();
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.sessionFile, before.sessionFile);
    const expected = modelForRole("parent");
    assert.equal(after.model?.provider, expected.provider);
    assert.equal(after.model?.id, expected.modelId);
    assert.equal(after.thinkingLevel, expected.thinking);
    log.identity = { supervisor, parent, before, after };
    log.result = "pass";
  } catch (error) {
    failure = error;
    log.error = String(error);
    log.diagnostics = [];
    for (const client of clients) {
      try {
        const state = await client.getState();
        const helper = await client.requestExtension("qa.repair.status");
        const errors = (await client.getMessages()).filter(
          (message) => message.role === "assistant" && message.stopReason === "error",
        );
        log.diagnostics.push({
          sessionId: state.sessionId,
          streaming: state.isStreaming,
          helper,
          errors,
        });
      } catch (diagnosticError) {
        log.diagnostics.push({ error: String(diagnosticError) });
      }
    }
  } finally {
    for (const client of clients) await client.stop();
    try {
      await qa.close();
      log.cleanup = "owned QA resources removed";
    } catch (error) {
      failure ??= error;
      log.cleanupError = String(error);
    }
    if (failure) log.result = "failed";
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "result.json"), `${JSON.stringify(log, null, 2)}\n`);
  }
  if (failure) throw failure;
  console.log(
    mode === "notice"
      ? "PASS: real model error, one manager notice, local notice after manager closure, same-parent recovery without model fallback"
      : "PASS: same-ID native retry and accepted-result metadata loss; one target delivery each",
  );
}

await main();
