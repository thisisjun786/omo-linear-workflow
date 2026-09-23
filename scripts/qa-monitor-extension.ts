import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { z } from "zod";

const request = z.object({
  tool: z.enum(["monitor", "kill_bash"]),
  arguments: z.record(z.string(), z.unknown()),
});

export default function qaMonitor(pi: ExtensionAPI): void {
  const { OMO_QA_MONITOR_PORT: port } = process.env;
  pi.registerProvider("qa-monitor-local", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "local-only",
    api: "openai-completions",
    models: [
      {
        id: "offline",
        name: "Offline QA",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 128,
      },
    ],
  });
  for (const name of ["terminal_monitor_state", "terminal_monitor_ended"]) {
    pi.events.on(name, (data) => pi.rpc.emit(`oi.qa.monitor.${name}`, data));
  }
  pi.on("message_start", (event) => {
    if (
      event.message.role === "custom" &&
      event.message.customType === "senpi-monitor:notification"
    ) {
      pi.rpc.emit("oi.qa.monitor.notification", event.message);
    }
  });
  pi.rpc.handle("oi.qa.monitor.tool", async (raw: unknown) => {
    const input = request.parse(raw);
    const result = await pi.executeTool(input.tool, input.arguments);
    if (input.tool === "monitor" && !result.isError)
      pi.appendEntry("oi.qa.monitor.registration", result.details);
    return result;
  });
}
