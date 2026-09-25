import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { z } from "zod";

const requestSchema = z.object({
  tool: z.string().startsWith("mcp_linear_"),
  arguments: z.record(z.string(), z.unknown()),
});

export default function qaLinearExtension(pi: ExtensionAPI): void {
  const invocations: { name: string; active: string[] }[] = [];
  pi.on("tool_call", (event) => {
    if (event.toolName.startsWith("mcp_linear_"))
      invocations.push({ name: event.toolName, active: pi.getActiveTools() });
  });
  pi.rpc.handle("oi.qa.linear.invocations", () => invocations);
  pi.rpc.handle("oi.qa.linear.tools", () =>
    pi
      .getAllTools()
      .filter((tool) => tool.name.startsWith("mcp_linear_"))
      .map((tool) => tool.name),
  );
  pi.rpc.handle("oi.qa.linear.active", () => pi.getActiveTools());
  pi.rpc.handle("oi.qa.linear.search", async (input: unknown) => {
    const query = z.object({ query: z.string(), source: z.literal("mcp").optional() }).parse(input);
    return pi.executeTool("tool_search", query);
  });
  pi.rpc.handle("oi.qa.linear.eval", async (input: unknown) => {
    const request = requestSchema.parse(input);
    return pi.executeTool("eval", {
      language: "js",
      summary: "Exercise first-use MCP activation in the owned QA session",
      code: `const result = await tool[${JSON.stringify(request.tool)}](${JSON.stringify(request.arguments)}); if (result.hasError) throw new Error(result.text); print(result);`,
    });
  });
  pi.rpc.handle("oi.qa.linear.call", async (input: unknown) => {
    const request = requestSchema.parse(input);
    return pi.executeTool(request.tool, request.arguments, { activateInactiveTool: true });
  });
}
