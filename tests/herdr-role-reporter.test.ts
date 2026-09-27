import { describe, expect, test } from "bun:test";
import type { Binding } from "../src/core/contracts";
import {
  type RoleHerdrClient,
  type RoleHerdrReporterPort,
  type RoleSessionContext,
  registerRoleHerdrReporter,
  roleHerdrRequest,
} from "../src/extension/herdr-reporter";

class Harness implements RoleHerdrReporterPort {
  sessionStart?: Parameters<RoleHerdrReporterPort["onSessionStart"]>[0];
  agentStart?: Parameters<RoleHerdrReporterPort["onAgentStart"]>[0];
  agentSettled?: Parameters<RoleHerdrReporterPort["onAgentSettled"]>[0];
  sessionShutdown?: Parameters<RoleHerdrReporterPort["onSessionShutdown"]>[0];
  blocked?: Parameters<RoleHerdrReporterPort["onBlocked"]>[0];

  onSessionStart(handler: Parameters<RoleHerdrReporterPort["onSessionStart"]>[0]): void {
    this.sessionStart = handler;
  }
  onAgentStart(handler: Parameters<RoleHerdrReporterPort["onAgentStart"]>[0]): void {
    this.agentStart = handler;
  }
  onAgentSettled(handler: Parameters<RoleHerdrReporterPort["onAgentSettled"]>[0]): void {
    this.agentSettled = handler;
  }
  onSessionShutdown(handler: Parameters<RoleHerdrReporterPort["onSessionShutdown"]>[0]): void {
    this.sessionShutdown = handler;
  }
  onBlocked(handler: Parameters<RoleHerdrReporterPort["onBlocked"]>[0]): void {
    this.blocked = handler;
  }
}

function session(mode: RoleSessionContext["mode"] = "rpc") {
  let idle = true;
  return {
    ctx: {
      mode,
      isIdle: () => idle,
      sessionManager: {
        getSessionId: () => "session-parent",
        getSessionFile: () => "/sessions/parent.jsonl",
      },
    } satisfies RoleSessionContext,
    setIdle(value: boolean): void {
      idle = value;
    },
  };
}

const binding = {
  id: "parent",
  durableSessionId: "session-parent",
  herdrSocket: "/tmp/herdr.sock",
  paneId: "pane-parent",
} as Binding;

describe("OLW role Herdr reporter", () => {
  test("reports a bound RPC role turn to its recorded pane", async () => {
    const harness = new Harness();
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client: RoleHerdrClient = {
      send: async (method, params) => {
        sent.push({ method, params });
      },
    };
    registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => binding,
      createClient: (socket, pane) => {
        expect([socket, pane]).toEqual([binding.herdrSocket, "pane-parent"]);
        return client;
      },
      debug: () => undefined,
    });
    const current = session();

    await harness.sessionStart?.("new", current.ctx);
    current.setIdle(false);
    await harness.agentStart?.(current.ctx);
    current.setIdle(true);
    await harness.agentSettled?.(current.ctx);

    expect(sent).toEqual([
      {
        method: "pane.report_agent_session",
        params: {
          agent: "pi",
          agent_session_path: "/sessions/parent.jsonl",
          session_start_source: "new",
        },
      },
      {
        method: "pane.report_agent",
        params: { agent: "pi", agent_session_path: "/sessions/parent.jsonl", state: "idle" },
      },
      {
        method: "pane.report_agent",
        params: {
          agent: "pi",
          agent_session_path: "/sessions/parent.jsonl",
          state: "working",
        },
      },
      {
        method: "pane.report_agent",
        params: { agent: "pi", agent_session_path: "/sessions/parent.jsonl", state: "idle" },
      },
    ]);
  });

  test("does not report unbound sessions or sessions outside the shared host", async () => {
    for (const [hostRuntime, ctx, found] of [
      [true, session().ctx, undefined],
      [false, session("tui").ctx, binding],
    ] as const) {
      const harness = new Harness();
      const sent: unknown[] = [];
      registerRoleHerdrReporter(harness, {
        hostRuntime,
        lookupBinding: () => found,
        createClient: () => ({ send: async (...args) => void sent.push(args) }),
        debug: () => undefined,
      });
      await harness.sessionStart?.("new", ctx);
      await harness.agentStart?.(ctx);
      await harness.agentSettled?.(ctx);
      expect(sent).toEqual([]);
    }
  });

  test("mirrors Senpi's report protocol shape", () => {
    expect(
      roleHerdrRequest(
        "pane.report_agent",
        { agent: "pi", state: "working", agent_session_id: "session-parent" },
        "pane-parent",
        42,
      ),
    ).toEqual({
      id: "custom:senpi:42",
      method: "pane.report_agent",
      params: {
        agent: "pi",
        state: "working",
        agent_session_id: "session-parent",
        pane_id: "pane-parent",
        source: "custom:senpi",
        seq: 42,
      },
    });
  });

  test("swallows and debug-logs transport failures", async () => {
    const harness = new Harness();
    const debug: string[] = [];
    registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => binding,
      createClient: () => ({
        send: async () => {
          throw new Error("socket unavailable");
        },
      }),
      debug: (message) => debug.push(message),
    });
    const ctx = session().ctx;

    await expect(harness.sessionStart?.("new", ctx)).resolves.toBeUndefined();
    await expect(harness.agentStart?.(ctx)).resolves.toBeUndefined();
    await expect(harness.sessionShutdown?.("quit", ctx)).resolves.toBeUndefined();
    expect(debug).toEqual([
      "socket unavailable",
      "socket unavailable",
      "socket unavailable",
      "socket unavailable",
    ]);
  });
});
