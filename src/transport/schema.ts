import { z } from "zod";
import { deliveryRecordSchema, runtimeIdentitySchema } from "../core/schema";

const errorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

export const describeResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: runtimeIdentitySchema }),
  z.strictObject({ ok: z.literal(false), error: errorSchema }),
]);

export const sendResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: deliveryRecordSchema }),
  z.strictObject({ ok: z.literal(false), error: errorSchema }),
]);
