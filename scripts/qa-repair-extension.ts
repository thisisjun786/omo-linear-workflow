import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { z } from "zod";

async function publish(cwd: string, id: string, data: unknown) {
  const path = join(cwd, ".omo/qa-repair", `${id}.json`);
  await writeFile(`${path}.tmp`, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export default function repairQa(pi: ExtensionAPI) {
  let armed: { mode: "hold" | "error"; nonce: string } | undefined;
  let release: (() => void) | undefined;
  let dropReceipt: string | undefined;
  let agentStarts = 0;
  let providerRequests = 0;
  let readCalls = 0;
  let settings: ExtensionContext["sessionSettings"] | undefined;
  pi.on("session_start", (_event, ctx) => {
    settings = ctx.sessionSettings;
  });
  pi.on("agent_start", () => {
    agentStarts += 1;
  });
  pi.rpc.handle("qa.repair.status", () => ({
    armed,
    agentStarts,
    providerRequests,
    readCalls,
    held: release !== undefined,
    modelFallback: settings?.getRetryFallbackSettings().modelFallback,
  }));
  const reset = () => {
    release?.();
    release = undefined;
    armed = undefined;
    dropReceipt = undefined;
  };
  pi.on("session_shutdown", reset);
  pi.rpc.handle("qa.repair.reset", () => {
    reset();
    return { reset: true };
  });
  pi.rpc.handle("qa.repair.arm", (data) => {
    if (armed || release) throw new Error("A QA request boundary is already armed");
    armed = z.object({ mode: z.enum(["hold", "error"]), nonce: z.uuid() }).parse(data);
    return { armed };
  });
  pi.on("before_provider_request", async (event, ctx) => {
    providerRequests += 1;
    if (armed?.mode !== "error" || !JSON.stringify(event.payload).includes(armed.nonce)) return;
    const request = armed;
    armed = undefined;
    await publish(ctx.cwd, request.nonce, request);
    const payload = z.record(z.string(), z.unknown()).parse(event.payload);
    return { ...payload, messages: null };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return;
    readCalls += 1;
    if (armed?.mode !== "hold") return;
    const request = armed;
    armed = undefined;
    const gate = Promise.withResolvers<void>();
    release = gate.resolve;
    await publish(ctx.cwd, request.nonce, request);
    await gate.promise;
    release = undefined;
  });
  pi.rpc.handle("qa.repair.release", () => {
    release?.();
    return { released: true };
  });
  pi.rpc.handle("qa.repair.drop-receipt", (data) => {
    dropReceipt = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) }).parse(data).id;
    return { armed: dropReceipt };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "thread_send" || !dropReceipt) return;
    const input = z.object({ message: z.string() }).safeParse(event.input);
    if (!input.success) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(input.data.message);
    } catch {
      return;
    }
    const parsed = z.object({ id: z.string() }).safeParse(envelope);
    if (!parsed.success || parsed.data.id !== dropReceipt) return;
    dropReceipt = undefined;
    // The oracle captures real native acceptance before metadata is lost at the
    // SDK tool-result/OLW boundary. This is not socket-level ACK fault injection.
    await publish(ctx.cwd, parsed.data.id, { id: parsed.data.id, details: event.details });
    return { details: {} };
  });
}
