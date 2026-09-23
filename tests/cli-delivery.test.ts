import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import type { DeliveryRecord, NativeReceipt, Result } from "../src/core/contracts";
import { Orchestrator } from "../src/orchestrator";

const rejected: DeliveryRecord = {
  envelope: {
    version: 1,
    id: "logical-message",
    fromBindingId: "supervisor",
    toBindingId: "parent",
    designationId: "designation",
    snapshotDigest: "digest",
    kind: "instruction",
    text: "payload",
    outcome: null,
    evidence: [],
  },
  state: "rejected",
  receipt: {
    kind: "error",
    error: {
      code: "turn_conflict",
      message: "The active turn changed before delivery.",
      next_action: "Read the target again and retry with the current turn id.",
    },
  },
};

async function invoke(command: "send" | "report", reply: Result<unknown>, json = true) {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-delivery-"));
  const body = join(root, "payload.txt");
  await writeFile(body, "payload");
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  // Keep argument parsing, body reading, result interpretation, printing, and exit status real.
  // Only the already-covered orchestrator/native boundary is replaced.
  const operation = spyOn(Orchestrator.prototype, command).mockResolvedValue(reply);
  try {
    const code = await runCli([
      "--root",
      root,
      command,
      "--from",
      "supervisor",
      "--id",
      "logical-message",
      "--text-file",
      body,
      ...(command === "send"
        ? ["--to", "parent", "--kind", "instruction"]
        : ["--outcome", "blocked"]),
      ...(json ? ["--json"] : []),
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
    const decoded: unknown = JSON.parse(output);
    return { code, output: decoded };
  } finally {
    operation.mockRestore();
    stdout.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["send", "report"] as const)(
  "%s does not report a processed native rejection as successful delivery",
  async (command) => {
    const result = await invoke(command, { ok: true, value: rejected });
    expect(result.code).toBe(2);
    expect(result.output).toMatchObject({
      ok: false,
      error: {
        code: "delivery_rejected",
        details: {
          delivery: rejected,
          recovery: "inspect_before_retry",
          next_action: expect.any(String),
        },
      },
    });
  },
);

test("non-JSON rejected delivery also exits nonzero and retains the receipt", async () => {
  const result = await invoke("send", { ok: true, value: rejected }, false);
  expect(result.code).toBe(2);
  expect(result.output).toMatchObject({ error: { details: { delivery: rejected } } });
});

test.each(["sending", "uncertain"] as const)(
  "%s delivery is not accepted and cannot be blindly retried",
  async (state) => {
    const delivery = { ...rejected, state, receipt: null };
    const result = await invoke("send", { ok: true, value: delivery });
    expect(result.code).toBe(4);
    expect(result.output).toMatchObject({
      ok: false,
      error: {
        code: "delivery_uncertain",
        details: {
          delivery,
          recovery: "inspect_before_retry",
          next_action: expect.any(String),
        },
      },
    });
  },
);

test("an in-progress same-ID retry exits as uncertain without dropping the stored evidence", async () => {
  const delivery = { ...rejected, state: "uncertain", receipt: null };
  const result = await invoke("send", {
    ok: false,
    error: { code: "delivery_in_progress", message: "Not safe to replay", details: delivery },
  });
  expect(result.code).toBe(4);
  expect(result.output).toMatchObject({
    ok: false,
    error: {
      code: "delivery_in_progress",
      details: {
        delivery,
        recovery: "inspect_before_retry",
        next_action: expect.any(String),
      },
    },
  });
});

test.each(["started", "steered", "queued"] as const)(
  "%s acceptance keeps the successful machine contract",
  async (kind) => {
    const receipt: NativeReceipt = {
      kind: "ok",
      thread_id: "parent-session",
      message_seq: 1,
      deduplicated: false,
      delivery: kind === "queued" ? { kind, queue_position: 1 } : { kind, turn_id: "turn" },
    };
    const reply = { ok: true, value: { ...rejected, state: "accepted", receipt } };
    expect(await invoke("send", { ...reply, ok: true })).toEqual({ code: 0, output: reply });
  },
);

test("route and validation failures keep their original error contract", async () => {
  const reply = { ok: false, error: { code: "route_denied", message: "Route denied" } };
  expect(await invoke("send", { ...reply, ok: false })).toEqual({ code: 2, output: reply });
});
