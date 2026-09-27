import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import type { Binding } from "../core/contracts";

declare global {
  // The shared host can load a separate extension module generation per session.
  var olwManagerIdleContexts:
    | Map<string, Pick<ExtensionContext, "cwd" | "isIdle" | "sessionManager">>
    | undefined;
}

export function registerManagerIdle(pi: ExtensionAPI): void {
  globalThis.olwManagerIdleContexts ??= new Map();
  const contexts = globalThis.olwManagerIdleContexts;
  let current: Pick<ExtensionContext, "cwd" | "isIdle" | "sessionManager"> | undefined;
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    contexts.set(ctx.sessionManager.getSessionId(), ctx);
  });
  pi.on("session_shutdown", () => {
    if (current && contexts.get(current.sessionManager.getSessionId()) === current)
      contexts.delete(current.sessionManager.getSessionId());
  });
}

export function isManagerIdle(target: Binding): boolean {
  const ctx = globalThis.olwManagerIdleContexts?.get(target.durableSessionId);
  if (!ctx || ctx.cwd !== target.cwd || ctx.sessionManager.getSessionFile() !== target.sessionPath)
    throw new Error("Manager is not present in this shared host");
  return ctx.isIdle();
}
