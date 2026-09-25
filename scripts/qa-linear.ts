import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { QaError, startQaRpc } from "./qa-rpc";

const root = resolve(import.meta.dir, "..");
const mode = z
  .enum(["direct", "discovery", "discovery-reload", "discovery-host", "discovery-host-reload"])
  .parse(process.argv[2] ?? "direct");
const discovery = mode !== "direct";
const hosted = mode === "discovery-host" || mode === "discovery-host-reload";
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
            description: {
              get_initiative: "Read fixture initiative portfolio scope by stable ID.",
              get_project: "Read fixture project milestones resources by stable ID.",
              get_issue: "Read fixture issue defect acceptance by stable ID.",
            }[name],
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
          exposure: discovery ? "search" : "direct",
          startupTimeoutMs: 10000,
        },
      },
    }),
    { mode: 0o600 },
  );
  rpc = startQaRpc(
    [
      join(root, "node_modules/.bin/omo"),
      "--mode",
      "rpc",
      ...(hosted ? ["--multi-session", "--session-runtime", "in-process"] : []),
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
      SENPI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      OMO_INITIATIVE_ROOT: root,
      OMO_INITIATIVE_HOST: undefined,
      OMO_RPC_SOCKET: undefined,
      OMO_ENABLE_SHARED_HOST: "0",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scratch, "bun-cache"),
      XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    },
  );
  const nativeRpc = rpc;
  if (hosted) {
    const opened = z
      .object({ sessionId: z.string() })
      .parse(await rpc.request({ type: "open_session", cwd: scratch }));
    const unscoped = rpc.request;
    rpc = {
      ...rpc,
      request: (command, timeoutMs) =>
        unscoped({ ...command, sessionId: opened.sessionId }, timeoutMs),
    };
  }
  z.object({ disposition: z.literal("handled") }).parse(
    await rpc.request({ type: "prompt", message: "/mcp status" }),
  );
  if (mode === "discovery-reload" || mode === "discovery-host-reload") {
    await rpc.request({ type: "reload" });
    z.object({ disposition: z.literal("handled") }).parse(
      await rpc.request({ type: "prompt", message: "/mcp status" }),
    );
  }
  console.log("MCP_STATUS", JSON.stringify(await rpc.request({ type: "get_loaded_surfaces" })));
  const tools = z
    .array(z.string())
    .parse(await rpc.request({ type: "extension_request", name: "oi.qa.linear.tools" }));
  if (discovery) {
    const active = z
      .array(z.string())
      .parse(await rpc.request({ type: "extension_request", name: "oi.qa.linear.active" }));
    console.log("MCP_BEFORE_DISCOVERY", JSON.stringify({ registered: tools, active }));
    if (names.some((name) => active.includes(`mcp_linear_${name}`)))
      throw new QaError("Search fixture tools must start inactive");
  }
  for (const name of names) {
    const tool = `mcp_linear_${name}`;
    if (discovery) {
      const search = await rpc.request({
        type: "extension_request",
        name: "oi.qa.linear.search",
        data:
          name === "get_project"
            ? { query: "project milestones resources", source: "mcp" }
            : { query: tool, ...(name === "get_initiative" ? { source: "mcp" } : {}) },
      });
      const matches = z
        .object({ details: z.object({ matched: z.array(z.string()) }) })
        .parse(search);
      console.log("MCP_DISCOVERY", tool, JSON.stringify(matches));
      if (!matches.details.matched.includes(tool))
        throw new QaError(`Search did not discover ${tool}`);
    }
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
    if (discovery) {
      const active = z
        .array(z.string())
        .parse(await rpc.request({ type: "extension_request", name: "oi.qa.linear.active" }));
      if (!active.includes(tool)) throw new QaError(`First call did not activate ${tool}`);
    }
    console.log(`MCP_READ_PASS ${name} ${records[name].id}`);
  }
  if (hosted) {
    const siblingCwd = join(scratch, "sibling");
    await mkdir(siblingCwd);
    const sibling = z
      .object({ sessionId: z.string() })
      .parse(await nativeRpc.request({ type: "open_session", cwd: siblingCwd }));
    z.object({ disposition: z.literal("handled") }).parse(
      await nativeRpc.request({
        type: "prompt",
        message: "/mcp status",
        sessionId: sibling.sessionId,
      }),
    );
    const before = z.array(z.string()).parse(
      await nativeRpc.request({
        type: "extension_request",
        name: "oi.qa.linear.active",
        sessionId: sibling.sessionId,
      }),
    );
    if (names.some((name) => before.includes(`mcp_linear_${name}`)))
      throw new QaError("MCP activation leaked into sibling session");
    const result = await nativeRpc.request({
      type: "extension_request",
      name: "oi.qa.linear.eval",
      sessionId: sibling.sessionId,
      data: { tool: "mcp_linear_get_issue", arguments: { id: records.get_issue.id } },
    });
    z.object({
      details: z.object({
        toolCallCount: z.literal(1),
        toolCalls: z
          .array(z.object({ name: z.literal("mcp_linear_get_issue"), ok: z.literal(true) }))
          .length(1),
        cells: z.array(z.object({ status: z.literal("complete") })).length(1),
      }),
    }).parse(result);
    console.log("MCP_EVAL_RESULT", JSON.stringify(result));
    const after = z.array(z.string()).parse(
      await nativeRpc.request({
        type: "extension_request",
        name: "oi.qa.linear.active",
        sessionId: sibling.sessionId,
      }),
    );
    if (!after.includes("mcp_linear_get_issue") || after.includes("mcp_linear_get_project"))
      throw new QaError("eval did not activate only its requested MCP tool");
    console.log("MCP_EVAL_PASS", sibling.sessionId);
  }
  const commands = z
    .object({ commands: z.array(z.object({ name: z.string() })) })
    .parse(await rpc.request({ type: "get_commands" }));
  for (const name of ["olw-define", "olw-plan", "olw-run", "olw-check"]) {
    if (!commands.commands.some((command) => command.name === `skill:${name}`)) {
      throw new QaError(`Ported skill not loaded by actual OMO: ${name}`);
    }
  }
  const expectedCalls = hosted ? [...names, "get_issue"] : names;
  if (calls.join(",") !== expectedCalls.join(",")) throw new QaError("Unexpected MCP wire calls");
  console.log(`LINEAR_QA_PASS: ${calls.length} real MCP read calls and four loaded ported skills`);
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
