import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  createGoal,
  readGoal,
  updateGoal,
} from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/store.js";
import { ownsGoalPause, pauseGoal, resumeGoal } from "../src/extension/goal-pause";

test("pinned Senpi goal store contract and user-owned transitions survive OLW pause", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-goal-adapter-"));
  const ref = { baseDir: root, threadId: "child" };
  const path = join(root, "child.json");
  const ctx = { goalStoreFile: path, sessionManager: { getSessionId: () => "child" } };
  try {
    const goal = await createGoal(ref, "packet");
    const pause = await pauseGoal(ctx);
    if (!pause) throw new Error("Missing owned pause");
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(
      z
        .strictObject({
          version: z.literal(1),
          goal: z.object({
            id: z.string(),
            threadId: z.string(),
            status: z.literal("paused"),
            updatedAt: z.number().int(),
          }),
        })
        .parse(raw).goal,
    ).toMatchObject({ id: goal.id, threadId: "child", updatedAt: pause.updatedAt });
    expect(await ownsGoalPause(ctx, pause)).toBe(true);
    await updateGoal(ref, { status: "active" }, "user");
    await updateGoal(ref, { status: "paused" }, "user");
    expect(await ownsGoalPause(ctx, pause)).toBe(false);
    await resumeGoal(ctx, pause);
    expect((await readGoal(ref))?.status).toBe("paused");
    expect(await pauseGoal(ctx)).toBeNull();
    await writeFile(path, JSON.stringify({ version: 2, goal: raw.goal }));
    await expect(pauseGoal(ctx)).rejects.toThrow("unsupported goal store version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
