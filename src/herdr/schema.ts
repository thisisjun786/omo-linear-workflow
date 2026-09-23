import { z } from "zod";

const identifierSchema = z.string().min(1);
const nullableIdentifierSchema = identifierSchema.nullish().transform((value) => value ?? null);

export const upstreamErrorSchema = z.object({
  id: z.string(),
  error: z.object({ code: z.string().min(1), message: z.string() }),
});
export const successFrameSchema = z.object({ id: z.string(), result: z.unknown() });
export const eventFrameSchema = z.object({ event: z.string().min(1), data: z.unknown() });
export type HerdrEvent = z.output<typeof eventFrameSchema>;

export const workspaceResultSchema = z.object({
  type: z.enum(["workspace_created", "worktree_created"]),
  workspace: z.object({ workspace_id: identifierSchema }),
  root_pane: z.object({ pane_id: identifierSchema, cwd: z.string().min(1).nullish() }),
  worktree: z.object({ path: z.string().min(1) }).optional(),
});

const agentSessionSchema = z.object({
  kind: z.enum(["id", "path"]),
  value: z.string(),
});
export const snapshotResultSchema = z.object({
  type: z.literal("session_snapshot"),
  snapshot: z.object({
    focused_workspace_id: nullableIdentifierSchema,
    focused_tab_id: nullableIdentifierSchema,
    focused_pane_id: nullableIdentifierSchema,
    workspaces: z.array(
      z.object({
        workspace_id: identifierSchema,
        active_tab_id: identifierSchema,
        label: z.string().optional(),
      }),
    ),
    panes: z.array(
      z.object({
        pane_id: identifierSchema,
        workspace_id: identifierSchema,
        tab_id: identifierSchema,
        cwd: z.string().min(1).nullish(),
        revision: z.number().int().nonnegative(),
        agent_session: agentSessionSchema.nullish(),
      }),
    ),
    layouts: z.array(
      z.object({
        workspace_id: identifierSchema,
        tab_id: identifierSchema,
        panes: z.array(z.object({ pane_id: identifierSchema })),
      }),
    ),
  }),
});
export const okResultSchema = z.object({ type: z.literal("ok") });
export const worktreeRemovedSchema = z.object({
  type: z.literal("worktree_removed"),
  workspace_id: identifierSchema,
  path: z.string().min(1),
  forced: z.boolean(),
});
export const subscriptionStartedSchema = z.object({ type: z.literal("subscription_started") });

export const nonEmptyStringSchema = z.string().min(1);
export const absolutePathSchema = z.string().startsWith("/");
export const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());
