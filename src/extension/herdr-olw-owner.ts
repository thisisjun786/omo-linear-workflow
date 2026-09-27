import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { createRoleHerdrClient } from "./herdr-reporter";

// Loaded only by OLW-managed role TUIs. Its herdr-* filename intentionally makes
// Senpi's builtin reporter defer to the shared-host OLW reporter for that pane.
export default function herdrOlwOwner(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit") return;
    const socket = process.env["HERDR_SOCKET_PATH"];
    const pane = process.env["HERDR_PANE_ID"];
    if (process.env["HERDR_ENV"] !== "1" || socket === undefined || pane === undefined) return;
    try {
      await createRoleHerdrClient(socket, pane).send("pane.release_agent", { agent: "pi" });
    } catch {
      // Pane release is best effort; the shared host remains authoritative for role state.
    }
  });
}
