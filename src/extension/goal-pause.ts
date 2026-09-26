import { dirname } from "node:path";
import { z } from "zod";
import {
  readGoal,
  updateGoal,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/store.js";

// The only production dependency on the pinned Senpi goal-store implementation.
// updatedAt is monotonic even within one second; it distinguishes our pause from
// a subsequent user resume/pause of the same goal. Never adopt somebody else's pause.
export const goalPauseSchema = z.strictObject({ id: z.string(), updatedAt: z.number().int() });
export type GoalPause = z.infer<typeof goalPauseSchema>;
const nativeGoalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  status: z.enum(["active", "paused", "blocked", "complete"]),
  updatedAt: z.number().int().nonnegative(),
});
interface GoalContext {
  readonly goalStoreFile?: string;
  readonly sessionManager: { getSessionId(): string };
}
function ref(ctx: GoalContext) {
  return ctx.goalStoreFile === undefined
    ? null
    : { baseDir: dirname(ctx.goalStoreFile), threadId: ctx.sessionManager.getSessionId() };
}
export async function pauseGoal(ctx: GoalContext): Promise<GoalPause | null> {
  const store = ref(ctx);
  if (!store) return null;
  const goal = await readGoal(store);
  if (goal === null) return null;
  const valid = nativeGoalSchema.parse(goal);
  if (valid.threadId !== store.threadId) throw new Error("Pinned Senpi goal identity mismatch");
  if (valid.status !== "active") return null;
  const paused = nativeGoalSchema.parse(await updateGoal(store, { status: "paused" }, "user"));
  return { id: paused.id, updatedAt: paused.updatedAt };
}
export async function ownsGoalPause(ctx: GoalContext, pause: GoalPause): Promise<boolean> {
  const store = ref(ctx);
  if (!store) return false;
  const goal = await readGoal(store);
  if (goal === null) return false;
  const valid = nativeGoalSchema.parse(goal);
  return (
    valid.threadId === store.threadId &&
    valid.id === pause.id &&
    valid.status === "paused" &&
    valid.updatedAt === pause.updatedAt
  );
}
export async function resumeGoal(ctx: GoalContext, pause: GoalPause): Promise<void> {
  const store = ref(ctx);
  if (store && (await ownsGoalPause(ctx, pause)))
    await updateGoal(store, { status: "active" }, "user");
}
