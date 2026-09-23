# Actual OMO MCP and skill-loading QA

Command: `bun run qa:linear`. Exit 0.

The script starts an ephemeral localhost MCP Streamable HTTP fixture, configures
an isolated OMO agent directory, and launches the actual OMO RPC runtime with the
built initiative extension and a QA-only direct tool bridge. No credentials are
copied and no live Linear endpoint is contacted.

The first run queried the tool inventory before asynchronous MCP attachment had
settled and correctly failed: missing mcp_linear_get_initiative. The driver now
awaits the actual `/mcp test linear` command before inspecting tools. This uses
the real connection/health completion, not sleep or polling.

Observed actual MCP tool calls and parsed result IDs:

- get_initiative: 11111111-1111-4111-8111-111111111111
- get_project: 22222222-2222-4222-8222-222222222222
- get_issue: 33333333-3333-4333-8333-333333333333

The server independently recorded exactly those three tools/call requests.
The actual OMO get_commands response exposed oi-define, oi-plan, oi-run and
oi-check through the built extension's resources_discover hook.

Result: LINEAR_QA_PASS. This proves the actual MCP transport, tool dispatch,
structured read results and packaged skill discovery. It is not a claim of live
Linear OAuth, real project mutation, or an autonomous planning run.

Cleanup: RPC PID 155898 exited; local MCP server stopped; temporary isolated
agent directory removed. The earlier failed attempt also completed cleanup.
