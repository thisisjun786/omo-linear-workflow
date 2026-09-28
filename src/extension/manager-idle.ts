import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import type { Binding } from "../core/contracts";

export function registerManagerIdle(pi: ExtensionAPI): (target: Binding) => boolean {
  let current: Pick<ExtensionContext, "cwd" | "isIdle" | "sessionManager"> | undefined;
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
  });
  pi.on("session_shutdown", () => {
    current = undefined;
  });
  return (target) => {
    if (
      !current ||
      current.sessionManager.getSessionId() !== target.durableSessionId ||
      current.cwd !== target.cwd ||
      current.sessionManager.getSessionFile() !== target.sessionPath
    )
      throw new Error("Manager admission must run in the target session isolate");
    return current.isIdle();
  };
}
