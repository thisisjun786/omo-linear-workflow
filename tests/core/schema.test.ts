import { describe, expect, test } from "bun:test";
import { modelForRole } from "../../src/core/policy";
import { envelopeSchema, workerRequestSchema } from "../../src/core/schema";

describe("frozen core schemas and role policy", () => {
  test("modelForRole returns exactly the three proven tuples", () => {
    expect(modelForRole("supervisor")).toEqual({
      provider: "chatgpt-subscription",
      modelId: "gpt-6-astra",
      thinking: "high",
    });
    expect(modelForRole("parent")).toEqual({
      provider: "kimi-coding",
      modelId: "k3",
      thinking: "max",
    });
    expect(modelForRole("child")).toEqual({
      provider: "anthropic-subscription",
      modelId: "claude-opus-5",
      thinking: "xhigh",
    });
  });

  test("strict schemas reject unknown boundary fields", () => {
    const envelope = {
      version: 1,
      id: "m",
      fromBindingId: "a",
      toBindingId: "b",
      designationId: "d",
      snapshotDigest: "hash",
      kind: "instruction",
      text: "do it",
      outcome: null,
      evidence: [],
      extra: true,
    };
    expect(envelopeSchema.safeParse(envelope).success).toBe(false);
    expect(
      workerRequestSchema.safeParse({ version: 1, dbPath: "/tmp/x", action: "retry", input: {} })
        .success,
    ).toBe(false);
  });
});
