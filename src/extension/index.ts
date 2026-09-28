import { existsSync } from "node:fs";
import { join } from "node:path";
import { debuglog } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { z } from "zod";
import {
  isContinuationHoldStateEvent,
  isTerminalMonitorStateEvent,
  isWakeSourceStateEvent,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/monitor-state-event.js";
import type { Binding } from "../core/contracts";
import { openRegistry } from "../core/store";
import { probeBindingSession } from "../transport";
import { waitForAnswerIdle } from "./answer-idle";
import { ownsGoalPause, pauseGoal, resumeGoal } from "./goal-pause";
import { createRoleHerdrClient, registerRoleHerdrReporter } from "./herdr-reporter";
import { isManagerIdle, registerManagerIdle } from "./manager-idle";
import { type RuntimePort, registerInitiativeRuntime, type SessionContextPort } from "./runtime";

const herdrRepublishProofSchema = z.object({
  sessionId: z.string().min(1),
  bindingId: z.string().min(1),
  claimToken: z.string().min(1),
});

export function authorizeHerdrRepublish(
  root: string,
  data: unknown,
  republish: (sessionId: string) => void,
  now = Date.now(),
) {
  const parsed = herdrRepublishProofSchema.safeParse(data);
  if (!parsed.success)
    return {
      ok: false as const,
      error: { code: "invalid_input", message: "Herdr republish proof is invalid" },
    };
  const dbPath = join(root, ".omo/state/registry.sqlite");
  if (!existsSync(dbPath))
    return {
      ok: false as const,
      error: { code: "herdr_republish_unauthorized", message: "Herdr republish proof is invalid" },
    };
  const registry = openRegistry(dbPath, { readonly: true });
  try {
    const authorized = registry.authorizeHerdrRepublish(
      parsed.data.bindingId,
      parsed.data.sessionId,
      parsed.data.claimToken,
      new Date(now - 120_000).toISOString(),
    );
    if (!authorized.ok) return authorized;
    republish(authorized.value.durableSessionId);
    return { ok: true as const };
  } finally {
    registry.close();
  }
}

export function questionWaitWire(
  pi: Pick<ExtensionAPI, "events" | "appendEntry">,
): Pick<RuntimePort, "emitQuestionWait" | "appendQuestionWait"> {
  return {
    emitQuestionWait(active, ids): void {
      pi.events.emit("continuation_hold_state", { source: "olw-question", active });
      pi.events.emit("wake_source_state", {
        source: "olw-question",
        activeCount: ids.length,
        items: ids.map((id) => ({ id })),
      });
    },
    appendQuestionWait(data): void {
      pi.appendEntry("olw-question-wait", data);
    },
  };
}

export async function abortOrphanedFallbackTurn(
  root: string,
  ctx: {
    abort(source?: "user" | "system"): void;
    sessionManager: { getSessionId(): string };
  },
  probe: (binding: Binding) => ReturnType<typeof probeBindingSession> = probeBindingSession,
): Promise<boolean> {
  const dbPath = join(root, ".omo/state/registry.sqlite");
  if (!existsSync(dbPath)) return false;
  const registry = openRegistry(dbPath, { readonly: true });
  try {
    const binding = registry.bySession(ctx.sessionManager.getSessionId());
    if (!binding.ok) return false;
    const observed = await probe(binding.value);
    if (observed.state !== "absent") return false;
    ctx.abort("system");
    return true;
  } finally {
    registry.close();
  }
}

export default function initiativeExtension(pi: ExtensionAPI): void {
  registerManagerIdle(pi);
  const { OMO_INITIATIVE_HOST: hostMarker, OMO_INITIATIVE_ROOT: initiativeRoot } = process.env;
  const root = initiativeRoot ?? pi.cwd;
  if (hostMarker !== "1") {
    pi.on("session_start", async (_event, ctx) => {
      try {
        await abortOrphanedFallbackTurn(root, ctx);
      } catch (cause) {
        console.error("OLW fallback host-session check failed", cause);
      }
    });
  }
  const debug = debuglog("olw:herdr");
  registerRoleHerdrReporter(
    {
      onSessionStart: (handler) => {
        pi.on("session_start", (event, ctx) => handler(event.reason, ctx));
      },
      onMessageStart: (handler) => {
        pi.on("message_start", (_event, ctx) => handler(ctx));
      },
      onAgentStart: (handler) => {
        pi.on("agent_start", (_event, ctx) => handler(ctx));
      },
      onAgentSettled: (handler) => {
        pi.on("agent_settled", (_event, ctx) => handler(ctx));
      },
      onSessionShutdown: (handler) => {
        pi.on("session_shutdown", (event, ctx) => handler(event.reason, ctx));
      },
      onBlocked: (handler) => {
        pi.events.on("herdr:blocked", (data) => {
          if (isBlockedEvent(data)) handler(data);
        });
      },
      onWakeSource: (handler) => {
        pi.events.on("wake_source_state", (data) => {
          if (isWakeSourceStateEvent(data)) handler(data);
        });
      },
      onContinuationHold: (handler) => {
        pi.events.on("continuation_hold_state", (data) => {
          if (isContinuationHoldStateEvent(data)) handler(data);
        });
      },
      onMonitors: (handler) => {
        pi.events.on("terminal_monitor_state", (data) => {
          if (isTerminalMonitorStateEvent(data)) handler(data);
        });
      },
      onRepublish: (handler) => {
        pi.rpc.handle("omo.initiative.herdr-republish", (data) =>
          authorizeHerdrRepublish(root, data, handler),
        );
      },
    },
    {
      hostRuntime: hostMarker === "1",
      lookupBinding(sessionId) {
        const dbPath = join(root, ".omo/state/registry.sqlite");
        if (!existsSync(dbPath)) return undefined;
        const registry = openRegistry(dbPath, { readonly: true });
        try {
          const binding = registry.bySession(sessionId);
          return binding.ok ? binding.value : undefined;
        } finally {
          registry.close();
        }
      },
      createClient: createRoleHerdrClient,
      debug,
    },
  );
  const port: RuntimePort = {
    onSessionStart(handler): void {
      pi.on("session_start", async (_event, ctx) => handler(contextPort(ctx)));
    },
    onMessageStart(handler): void {
      pi.on("message_start", (event, ctx) => handler(event.message, contextPort(ctx)));
    },
    ...questionWaitWire(pi),
    pauseGoal,
    ownsGoalPause,
    resumeGoal,
    waitForIdle: (target, timeoutMs) => waitForAnswerIdle(target, undefined, timeoutMs),
    isIdle: isManagerIdle,
    onUserInterrupt(handler): void {
      pi.on("session_abort", (_event, ctx) => handler(contextPort(ctx)));
      pi.on("agent_end", (event, ctx) => {
        if (event.aborted && event.abortSource === "user") return handler(contextPort(ctx));
      });
    },
    onGoalCheck(handler): void {
      pi.on("agent_start", (_event, ctx) => handler(contextPort(ctx)));
    },
    onTurnEnd(handler): void {
      pi.on("turn_end", (event, ctx) => {
        // executeTool preflight waits for this event queue; never await delivery inside it.
        void handler(event.message, contextPort(ctx)).catch((cause: unknown) => {
          console.error("OLW operational notification task failed", cause);
        });
      });
    },
    notifyOperational(message): void {
      // stderr is visible in host/RPC logs without injecting a user or assistant message.
      console.error(message);
    },
    onResourcesDiscover(handler): void {
      pi.on("resources_discover", () => handler());
    },
    onToolCall(handler): void {
      pi.on("tool_call", async (event, ctx) =>
        handler(event.toolName, event.input, contextPort(ctx)),
      );
    },
    handleRpc(name, handler): void {
      pi.rpc.handle(name, handler);
    },
    registerTool(tool): void {
      pi.registerTool({
        ...tool,
        execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
          tool.execute(toolCallId, params, contextPort(ctx)),
      });
    },
    exec(command, args, options) {
      return pi.exec(command, [...args], options);
    },
    getActiveTools() {
      return pi.getActiveTools();
    },
    setActiveTools(tools): void {
      pi.setActiveTools([...tools]);
    },
    async executeTool(name, input) {
      const result = await pi.executeTool(name, input);
      return { details: result.details };
    },
  };
  registerInitiativeRuntime(port, {
    root,
    hostRuntime: hostMarker === "1",
  });
}

function isBlockedEvent(data: unknown): data is { active: boolean; id: string; label?: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "active" in data &&
    typeof data.active === "boolean" &&
    "id" in data &&
    typeof data.id === "string" &&
    data.id.length > 0 &&
    (!("label" in data) || data.label === undefined || typeof data.label === "string")
  );
}

function contextPort(ctx: ExtensionContext): SessionContextPort {
  return {
    cwd: ctx.cwd,
    mode: ctx.mode,
    ...(ctx.goalStoreFile === undefined ? {} : { goalStoreFile: ctx.goalStoreFile }),
    get model() {
      return ctx.model === undefined
        ? undefined
        : { provider: ctx.model.provider, id: ctx.model.id };
    },
    get thinkingLevel() {
      return ctx.thinkingLevel;
    },
    disableModelFallbackForSession: () => ctx.sessionSettings.setModelFallbackForSession(false),
    sessionManager: {
      getSessionId: () => ctx.sessionManager.getSessionId(),
      getSessionFile: () => ctx.sessionManager.getSessionFile(),
      getBranch: () => ctx.sessionManager.getBranch(),
    },
  };
}
