import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { QaError, startQaRpc } from "./qa-rpc";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "omo-linear-workflow-linear-"));
const agentDir = join(scratch, "agent");
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const callSchema = z.object({
  name: z.string(),
  arguments: z.object({ id: z.string() }),
});
const initiativeId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const records = {
  get_initiative: {
    id: initiativeId,
    name: "Fixture initiative",
    url: `https://linear.app/qa/initiative/${initiativeId}`,
    updatedAt: "2026-09-22T00:00:00Z",
  },
  get_project: {
    id: projectId,
    initiativeId,
    name: "Fixture project",
    url: `https://linear.app/qa/project/${projectId}`,
    updatedAt: "2026-09-22T00:00:00Z",
  },
  get_issue: {
    id: issueId,
    projectId,
    title: "Fixture issue",
    url: "https://linear.app/qa/issue/QA-1",
    updatedAt: "2026-09-22T00:00:00Z",
  },
} as const;
const names = ["get_initiative", "get_project", "get_issue"] as const;
const calls: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    const raw: unknown = await request.json();
    const message = requestSchema.parse(raw);
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.["protocolVersion"],
          capabilities: { tools: {} },
          serverInfo: { name: "linear-qa-fixture", version: "1.0.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = {
          tools: names.map((name) => ({
            name,
            description: `Read one fixture ${name.slice(4)} by its stable ID.`,
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          })),
        };
        break;
      case "tools/call": {
        const call = callSchema.parse(message.params);
        const name = names.find((candidate) => candidate === call.name);
        if (!name || records[name].id !== call.arguments.id) {
          result = {
            isError: true,
            content: [{ type: "text", text: "Unknown fixture ID" }],
          };
          break;
        }
        calls.push(name);
        result = {
          content: [{ type: "text", text: JSON.stringify(records[name]) }],
          structuredContent: records[name],
        };
        break;
      }
      default:
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  },
});

let rpc: ReturnType<typeof startQaRpc> | undefined;
try {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        linear: {
          type: "http",
          url: `http://127.0.0.1:${server.port}/mcp`,
          auth: false,
          lifecycle: "eager",
          startupTimeoutMs: 10000,
        },
      },
    }),
    { mode: 0o600 },
  );
  rpc = startQaRpc(
    [
      "omo",
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "--no-context-files",
      "--no-recommended-models",
      "--omo-senpi-builtin-mcps-disabled",
      "--omo-senpi-memory-disabled",
      "-e",
      join(root, "dist/extension/index.js"),
      "-e",
      join(root, "scripts/qa-linear-extension.ts"),
    ],
    scratch,
    {
      ...process.env,
      HERDR_ENV: "0",
      OMO_CODING_AGENT_DIR: agentDir,
      OMO_INITIATIVE_ROOT: root,
    },
  );
  await rpc.request({ type: "prompt", message: "/mcp test linear" });
  console.log("MCP_STATUS", JSON.stringify(await rpc.request({ type: "get_loaded_surfaces" })));
  const tools = z
    .array(z.string())
    .parse(await rpc.request({ type: "extension_request", name: "oi.qa.linear.tools" }));
  for (const name of names) {
    const tool = `mcp_linear_${name}`;
    if (!tools.includes(tool)) throw new QaError(`Missing actual MCP tool ${tool}`);
    const returned = await rpc.request({
      type: "extension_request",
      name: "oi.qa.linear.call",
      data: { tool, arguments: { id: records[name].id } },
    });
    const result = z
      .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
      .parse(returned);
    const text = result.content.find((part) => part.type === "text")?.text;
    if (!text) throw new QaError(`MCP result had no JSON text for ${name}`);
    const returnedRecord = z.object({ id: z.literal(records[name].id) }).parse(JSON.parse(text));
    if (returnedRecord.id !== records[name].id) throw new QaError(`Wrong ${name} identity`);
    console.log(`MCP_READ_PASS ${name} ${records[name].id}`);
  }
  const commands = z
    .object({ commands: z.array(z.object({ name: z.string() })) })
    .parse(await rpc.request({ type: "get_commands" }));
  for (const name of ["olw-define", "olw-plan", "olw-run", "olw-check"]) {
    if (!commands.commands.some((command) => command.name === `skill:${name}`)) {
      throw new QaError(`Ported skill not loaded by actual OMO: ${name}`);
    }
  }
  if (calls.join(",") !== names.join(",")) throw new QaError("Unexpected MCP wire calls");
  console.log("LINEAR_QA_PASS: three real MCP read calls and four loaded ported skills");
  console.log("LIVE_LINEAR: not contacted; this was an explicit local MCP fixture");
} finally {
  if (rpc) {
    const stderr = await rpc.close();
    if (stderr) console.error(stderr);
  }
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
  console.log("CLEANUP: local MCP server stopped and isolated agent directory removed");
}
