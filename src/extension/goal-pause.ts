import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getPackageDir } from "@code-yeongyu/senpi";
import { z } from "zod";
import type {
  Goal,
  GoalStoreRef,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/types.js";

// Native require bypasses Senpi's per-generation extension import graph. Static
// external imports alone still get their own mutationTails Map in that graph.
// getPackageDir comes from the host's virtual Senpi export, not an independently
// resolved package. Never inline the store or import it through the generation.
const requireSenpi = createRequire(join(getPackageDir(), "dist/index.js"));
const {
  readGoal,
}: typeof import("../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/store.js") =
  requireSenpi("./core/extensions/builtin/goal/store.js");
const {
  goalFilePath,
  writeGoalFile,
}: typeof import("../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/persistence.js") =
  requireSenpi("./core/extensions/builtin/goal/persistence.js");
const {
  transitionGoalStatus,
}: typeof import("../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/transitions.js") =
  requireSenpi("./core/extensions/builtin/goal/transitions.js");
const {
  serializeByKey,
}: typeof import("../../node_modules/@code-yeongyu/senpi/dist/core/session-sidecar-store.js") =
  requireSenpi("./core/session-sidecar-store.js");

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
export async function compareAndSetGoalStatus(
  store: GoalStoreRef,
  expected: Pick<Goal, "id" | "status" | "updatedAt">,
  status: "active" | "paused",
): Promise<Goal | null> {
  return serializeByKey(goalFilePath(store), async () => {
    const current = await readGoal(store);
    if (current === null) return null;
    const valid = nativeGoalSchema.parse(current);
    if (valid.threadId !== store.threadId) throw new Error("Pinned Senpi goal identity mismatch");
    if (
      valid.id !== expected.id ||
      valid.status !== expected.status ||
      valid.updatedAt !== expected.updatedAt
    )
      return null;
    // The status-only branch of pinned updateGoal: same transition, monotonic
    // timestamp and continuation accounting, no objective/history replacement.
    // Do not call updateGoal/writeGoal here: they acquire this same key again.
    const next = transitionGoalStatus(
      current,
      status,
      "user",
      undefined,
      Math.max(Math.trunc(Date.now() / 1000), current.updatedAt + 1),
    );
    if (next.status !== current.status) {
      next.consecutiveContinuations = 0;
      next.unattendedContinuations = 0;
      delete next.lastContinuationSignature;
    }
    await writeGoalFile(store, next);
    return next;
  });
}

export async function pauseGoal(ctx: GoalContext): Promise<GoalPause | null | false> {
  const store = ref(ctx);
  if (!store) return null;
  const goal = await readGoal(store);
  if (goal === null) return null;
  const valid = nativeGoalSchema.parse(goal);
  if (valid.threadId !== store.threadId) throw new Error("Pinned Senpi goal identity mismatch");
  if (valid.status !== "active") return null;
  const paused = await compareAndSetGoalStatus(store, valid, "paused");
  return paused === null ? false : { id: paused.id, updatedAt: paused.updatedAt };
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
export async function resumeGoal(
  ctx: GoalContext,
  pause: GoalPause,
  onOwnershipLost?: () => void,
): Promise<void> {
  const store = ref(ctx);
  if (!store || !(await ownsGoalPause(ctx, pause))) {
    onOwnershipLost?.();
    return;
  }
  if ((await compareAndSetGoalStatus(store, { ...pause, status: "paused" }, "active")) === null)
    onOwnershipLost?.();
}
