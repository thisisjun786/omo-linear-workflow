import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { z } from "zod";

const requestSchema = z.object({
  tool: z.string().startsWith("mcp_linear_"),
  arguments: z.record(z.string(), z.unknown()),
});

export default function qaLinearExtension(pi: ExtensionAPI): void {
  pi.rpc.handle("oi.qa.linear.tools", () =>
    pi
      .getAllTools()
      .filter((tool) => tool.name.startsWith("mcp_linear_"))
      .map((tool) => tool.name),
  );
  pi.rpc.handle("oi.qa.linear.call", async (input: unknown) => {
    const request = requestSchema.parse(input);
    pi.setActiveTools([...new Set([...pi.getActiveTools(), request.tool])]);
    return pi.executeTool(request.tool, request.arguments);
  });
}
