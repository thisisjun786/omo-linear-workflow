import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { Type } from "typebox";
import { z } from "zod";
import offlineProvider from "./qa-official-provider";

// No shutdown cleanup: compare native disposal of both nested eval kernels and
// session-extension tools (which can start their own servers outside eval).
export default function memoryFixture(pi: ExtensionAPI): void {
  offlineProvider(pi);
  pi.registerTool({
    name: "qa_memory_server",
    label: "Session tool memory fixture",
    description: "Allocate a loopback fixture in the session extension runtime",
    parameters: Type.Object({ megabytes: Type.Number({ minimum: 1, maximum: 128 }) }),
    async execute(_id, { megabytes }) {
      const retained = new Uint8Array(megabytes * 1024 * 1024);
      retained.fill(119);
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(String(retained.byteLength)),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              port: listener.port,
              bytes: retained.byteLength,
              pid: process.pid,
            }),
          },
        ],
        details: { port: listener.port, bytes: retained.byteLength, pid: process.pid },
      };
    },
  });
  pi.rpc.handle("qa.memory.allocate", async (raw: unknown) => {
    const { megabytes, layer } = z
      .object({
        megabytes: z.number().int().min(1).max(128),
        layer: z.enum(["eval", "extension"]).default("eval"),
      })
      .parse(raw);
    if (layer === "extension") return pi.executeTool("qa_memory_server", { megabytes });
    return pi.executeTool(
      "eval",
      {
        language: "js",
        summary: "Retain a touched allocation and loopback server for session disposal QA",
        code: `var retained = new Uint8Array(${megabytes} * 1024 * 1024); retained.fill(117);
var listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(String(retained.byteLength)); } });
print(JSON.stringify({ port: listener.port, bytes: retained.byteLength, pid: process.pid }));`,
      },
      { activateInactiveTool: true },
    );
  });
}
