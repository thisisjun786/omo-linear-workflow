import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { type RuntimePort, registerInitiativeRuntime, type SessionContextPort } from "./runtime";

export default function initiativeExtension(pi: ExtensionAPI): void {
  const port: RuntimePort = {
    onSessionStart(handler): void {
      pi.on("session_start", async (_event, ctx) => handler(contextPort(ctx)));
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
    get model() {
      return ctx.model === undefined
        ? undefined
        : { provider: ctx.model.provider, id: ctx.model.id };
    },
    get thinkingLevel() {
      return ctx.thinkingLevel;
    },
    sessionManager: {
      getSessionId: () => ctx.sessionManager.getSessionId(),
      getSessionFile: () => ctx.sessionManager.getSessionFile(),
    },
  };
}
