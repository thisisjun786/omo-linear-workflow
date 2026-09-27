import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { waitForAnswerIdle } from "./answer-idle";
import { ownsGoalPause, pauseGoal, resumeGoal } from "./goal-pause";
import { type RuntimePort, registerInitiativeRuntime, type SessionContextPort } from "./runtime";

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

export default function initiativeExtension(pi: ExtensionAPI): void {
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
    waitForIdle: waitForAnswerIdle,
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
  const { OMO_INITIATIVE_HOST: hostMarker, OMO_INITIATIVE_ROOT: initiativeRoot } = process.env;
  registerInitiativeRuntime(port, {
    root: initiativeRoot ?? pi.cwd,
    hostRuntime: hostMarker === "1",
  });
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
