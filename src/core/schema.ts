import { z } from "zod";

const text = z.string().min(1);
const refSchema = z.strictObject({ id: text, url: text, revision: text });

export const scopeSnapshotSchema = z.strictObject({
  version: z.literal(1),
  source: z.enum(["linear-export", "fixture"]),
  initiative: refSchema.nullable(),
  projects: z.array(z.strictObject({ project: refSchema, issues: z.array(refSchema) })),
  decisionRefs: z.array(refSchema),
});
export const designationSchema = z.strictObject({
  id: text,
  snapshotDigest: text,
  designatedBy: text,
  designatedAt: text,
  execute: z.boolean(),
  create: z.boolean(),
  contact: z.boolean(),
});
export const assignmentSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("supervisor"), initiativeId: text }),
  z.strictObject({
    role: z.literal("parent"),
    initiativeId: text.nullable(),
    projectId: text,
    ownerBindingId: text.nullable(),
  }),
  z.strictObject({
    role: z.literal("child"),
    initiativeId: text.nullable(),
    projectId: text,
    issueId: text,
    ownerBindingId: text,
  }),
]);
export const checkoutSchema = z.strictObject({
  originalRepoRoot: text,
  path: text,
  branch: text,
  baseBranch: text,
  baseCommit: text,
});
export const bindingSchema = z.strictObject({
  id: text,
  designationId: text,
  assignment: assignmentSchema,
  durableSessionId: text,
  cwd: text,
  checkout: checkoutSchema.nullable(),
  herdrSocket: text,
  omoSocket: text,
  workspaceId: text.nullable(),
  paneId: text.nullable(),
  sessionPath: text.nullable(),
  launchState: z.enum([
    "reserved",
    "provisioning",
    "initializing",
    "ready",
    "failed",
    "uncertain",
    "closing",
    "closed",
  ]),
  contactState: z.enum(["active", "paused", "cancelled"]),
  initialization: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("pending"), text: z.null() }),
    z.strictObject({ state: z.enum(["sending", "accepted", "rejected", "uncertain"]), text }),
  ]),
});
export const runtimeFailureSchema = z.strictObject({
  source: z.literal("turn_end"),
  sessionEntryId: text,
  durableSessionId: text,
  sessionPath: text,
  cwd: text,
  provider: text,
  modelId: text,
  timestamp: z.number().nonnegative(),
  stopReason: z.literal("error"),
  errorMessage: z.string().nullable(),
});
export const runtimeFailureClaimSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("runtime_failure"),
  failure: runtimeFailureSchema,
});
export const envelopeSchema = z
  .strictObject({
    version: z.literal(1),
    id: text,
    fromBindingId: text,
    toBindingId: text.nullable(),
    designationId: text,
    snapshotDigest: text,
    kind: z.enum(["instruction", "coordination", "report", "operational_notice"]),
    text: z.string(),
    outcome: z.enum(["completed", "blocked", "failed"]).nullable(),
    evidence: z.array(text),
    operational: z
      .strictObject({
        failure: runtimeFailureSchema,
        binding: bindingSchema,
        ownerBindingId: text.nullable(),
        localReason: text.nullable(),
      })
      .optional(),
  })
  .refine(
    (envelope) =>
      envelope.kind === "operational_notice"
        ? envelope.operational !== undefined &&
          envelope.outcome === null &&
          envelope.operational.binding.id === envelope.fromBindingId &&
          envelope.operational.failure.durableSessionId ===
            envelope.operational.binding.durableSessionId &&
          (envelope.toBindingId === null
            ? envelope.operational.localReason !== null
            : envelope.operational.localReason === null &&
              envelope.toBindingId === envelope.operational.ownerBindingId)
        : envelope.operational === undefined,
    "Operational telemetry requires actual error evidence, its binding and route, and no result outcome",
  );
const nativeErrorSchema = z.strictObject({
  code: text,
  message: text,
  next_action: text,
  details: z.unknown().optional(),
});
export const nativeReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ok"),
    thread_id: text,
    message_seq: z.number().int().nonnegative(),
    deduplicated: z.boolean(),
    delivery: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.enum(["started", "steered"]), turn_id: text }),
      z.strictObject({ kind: z.literal("queued"), queue_position: z.number().int().nonnegative() }),
    ]),
  }),
  z.strictObject({ kind: z.literal("error"), error: nativeErrorSchema }),
]);
export const deliveryAttemptSchema = z.strictObject({
  number: z.number().int().positive(),
  nativeKey: text,
  state: z.enum(["sending", "accepted", "rejected", "uncertain"]),
  receipt: nativeReceiptSchema.nullable(),
  uncertaintyReason: text.nullable(),
});
export const deliveryRecordSchema = z
  .strictObject({
    envelope: envelopeSchema,
    state: z.enum(["sending", "accepted", "rejected", "uncertain", "posted"]),
    receipt: nativeReceiptSchema.nullable(),
    attempts: z.array(deliveryAttemptSchema).optional(),
  })
  .refine(
    (record) =>
      record.state === "posted"
        ? record.envelope.toBindingId === null &&
          ((record.envelope.kind === "report" && record.envelope.outcome !== null) ||
            record.envelope.kind === "operational_notice") &&
          record.receipt === null
        : record.envelope.toBindingId !== null,
    "Only local posted reports or operational notices address the user inbox, without a native receipt",
  );
export const runtimeIdentitySchema = z.strictObject({
  durableSessionId: text,
  sessionPath: text,
  cwd: text,
  provider: text,
  modelId: text,
  thinking: text,
  extensionProtocol: z.literal(1),
});
export const claimResultSchema = z.strictObject({
  disposition: z.enum(["new", "replay", "in_progress"]),
  record: deliveryRecordSchema,
  target: bindingSchema.nullable(),
  nativeKey: text.optional(),
});
export const reserveInputSchema = z.strictObject({
  bindingId: text,
  durableSessionId: text,
  designation: designationSchema,
  snapshot: scopeSnapshotSchema,
  assignment: assignmentSchema,
  cwd: text,
  checkout: checkoutSchema.nullable(),
  herdrSocket: text,
  omoSocket: text,
});
const lookupRequestSchema = z.strictObject({
  version: z.literal(1),
  dbPath: text,
  action: z.literal("lookup-session"),
  input: z.strictObject({ durableSessionId: text }),
});
const routeRequestSchema = z.strictObject({
  version: z.literal(1),
  dbPath: text,
  action: z.literal("authorize"),
  input: z.strictObject({ senderSessionId: text, envelope: envelopeSchema }),
});
const claimRequestSchema = z.strictObject({
  version: z.literal(1),
  dbPath: text,
  action: z.literal("claim"),
  input: z.strictObject({
    senderSessionId: text,
    envelope: z.union([envelopeSchema, runtimeFailureClaimSchema]),
  }),
});
const finishRequestSchema = z.strictObject({
  version: z.literal(1),
  dbPath: text,
  action: z.literal("finish"),
  input: z.strictObject({
    messageId: text,
    receipt: nativeReceiptSchema,
    nativeKey: text.optional(),
  }),
});
const uncertainRequestSchema = z.strictObject({
  version: z.literal(1),
  dbPath: text,
  action: z.literal("uncertain"),
  input: z.strictObject({ messageId: text, reason: text, nativeKey: text.optional() }),
});
export const workerRequestSchema = z.union([
  lookupRequestSchema,
  routeRequestSchema,
  claimRequestSchema,
  finishRequestSchema,
  uncertainRequestSchema,
]);

export function resultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({ code: text, message: text, details: z.unknown().optional() }),
    }),
  ]);
}
