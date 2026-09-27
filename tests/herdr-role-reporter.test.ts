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
  messageStart?: Parameters<RoleHerdrReporterPort["onMessageStart"]>[0];
  agentStart?: Parameters<RoleHerdrReporterPort["onAgentStart"]>[0];
  agentSettled?: Parameters<RoleHerdrReporterPort["onAgentSettled"]>[0];
  sessionShutdown?: Parameters<RoleHerdrReporterPort["onSessionShutdown"]>[0];
  blocked?: Parameters<RoleHerdrReporterPort["onBlocked"]>[0];
  wakeSource?: Parameters<RoleHerdrReporterPort["onWakeSource"]>[0];
  continuationHold?: Parameters<RoleHerdrReporterPort["onContinuationHold"]>[0];
  monitors?: Parameters<RoleHerdrReporterPort["onMonitors"]>[0];
  republish?: Parameters<RoleHerdrReporterPort["onRepublish"]>[0];

  onSessionStart(handler: Parameters<RoleHerdrReporterPort["onSessionStart"]>[0]): void {
    this.sessionStart = handler;
  }
  onMessageStart(handler: Parameters<RoleHerdrReporterPort["onMessageStart"]>[0]): void {
    this.messageStart = handler;
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
  onWakeSource(handler: Parameters<RoleHerdrReporterPort["onWakeSource"]>[0]): void {
    this.wakeSource = handler;
  }
  onContinuationHold(handler: Parameters<RoleHerdrReporterPort["onContinuationHold"]>[0]): void {
    this.continuationHold = handler;
  }
  onMonitors(handler: Parameters<RoleHerdrReporterPort["onMonitors"]>[0]): void {
    this.monitors = handler;
  }
  onRepublish(handler: Parameters<RoleHerdrReporterPort["onRepublish"]>[0]): void {
    this.republish = handler;
  }
}

function session(mode: RoleSessionContext["mode"] = "rpc") {
  return {
    mode,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-parent",
      getSessionFile: () => "/sessions/parent.jsonl",
    },
  } satisfies RoleSessionContext;
}

function role(overrides: Partial<Binding> = {}): Binding {
  return {
    id: "parent",
    designationId: "designation",
    assignment: { role: "parent", initiativeId: null, projectId: "project", ownerBindingId: null },
    durableSessionId: "session-parent",
    cwd: "/repo",
    checkout: null,
    herdrSocket: "/tmp/herdr.sock",
    omoSocket: "/tmp/omo.sock",
    workspaceId: "workspace",
    paneId: "pane-parent",
    sessionPath: "/sessions/parent.jsonl",
    launchState: "ready",
    contactState: "active",
    initialization: { state: "accepted", text: "brief" },
    ...overrides,
  };
}

interface Sent {
  socket: string;
  pane: string;
  method: string;
  params: Record<string, unknown>;
}

function fixture(initial: Binding | undefined = role()) {
  const harness = new Harness();
  const sent: Sent[] = [];
  let binding: Binding | undefined = initial;
  let signal = Promise.withResolvers<void>();
  registerRoleHerdrReporter(harness, {
    hostRuntime: true,
    lookupBinding: () => binding,
    createClient: (socket, pane): RoleHerdrClient => ({
      send: async (method, params) => {
        sent.push({ socket, pane, method, params });
        signal.resolve();
      },
    }),
    debug: () => undefined,
  });
  return {
    harness,
    sent,
    setBinding(next: Binding | undefined) {
      binding = next;
    },
    async nextReport() {
      await signal.promise;
      signal = Promise.withResolvers<void>();
    },
  };
}

describe("OLW role Herdr reporter", () => {
  test("revalidates a binding after a delayed session report", async () => {
    const harness = new Harness();
    let binding = role();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent: Sent[] = [];
    const control = registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => binding,
      createClient: (socket, pane) => ({
        send: async (method, params) => {
          sent.push({ socket, pane, method, params });
          if (method === "pane.report_agent_session" && pane === "pane-parent") {
            entered.resolve();
            await release.promise;
          }
        },
      }),
      debug: () => undefined,
    });

    harness.sessionStart?.("new", session());
    await entered.promise;
    binding = role({ paneId: "pane-new", herdrSocket: "/tmp/new.sock" });
    release.resolve();
    await control.drained();

    expect(sent.map((item) => [item.pane, item.method])).toEqual([
      ["pane-parent", "pane.report_agent_session"],
      ["pane-new", "pane.report_agent_session"],
      ["pane-new", "pane.report_agent"],
    ]);
  });

  test("coalesces an outage burst and puts release last", async () => {
    const harness = new Harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const control = registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => role(),
      createClient: () => ({
        send: async (method, params) => {
          sent.push({ method, params });
          if (sent.length === 1) {
            entered.resolve();
            await release.promise;
          }
        },
      }),
      debug: () => undefined,
    });
    const ctx = session();
    harness.sessionStart?.("new", ctx);
    await entered.promise;
    for (let count = 1; count <= 10_000; count++)
      harness.wakeSource?.({ source: "senpi-codemode", activeCount: count });
    harness.sessionShutdown?.("quit", ctx);
    release.resolve();
    await control.drained();

    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent.at(-1)?.method).toBe("pane.release_agent");
    expect(sent.filter((item) => item.method === "pane.report_agent")).toHaveLength(0);
  });
  test("republishes retained blocked state to a reattached pane on request", async () => {
    const f = fixture();
    const ctx = session();
    f.harness.sessionStart?.("new", ctx);
    await f.nextReport();
    await f.nextReport();
    f.harness.continuationHold?.({ source: "olw-question", active: true });
    await f.nextReport();
    f.setBinding(role({ paneId: "pane-new" }));
    f.harness.republish?.("session-parent");
    await f.nextReport();
    await f.nextReport();
    expect(f.sent.slice(-2).map((item) => [item.pane, item.method, item.params["state"]])).toEqual([
      ["pane-new", "pane.report_agent_session", undefined],
      ["pane-new", "pane.report_agent", "blocked"],
    ]);
  });

  test("counts the initial state send in the three-attempt retry cap", async () => {
    const harness = new Harness();
    const sent: string[] = [];
    let failures = 2;
    const scheduled: Array<() => void> = [];
    const control = registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => role(),
      createClient: () => ({
        send: async (method, params) => {
          if (method !== "pane.report_agent") return;
          sent.push(String(params["state"]));
          if (failures-- > 0) throw new Error("offline");
        },
      }),
      debug: () => undefined,
      scheduleRetry: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
    });
    const ctx = session();
    harness.sessionStart?.("new", ctx);
    await control.drained();
    harness.agentStart?.(ctx);
    harness.agentSettled?.(ctx);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await control.drained();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await control.drained();
    expect(sent).toEqual(["idle", "idle", "idle"]);
    expect(scheduled).toHaveLength(0);
  });

  test("exhausts failed state publication after three total attempts", async () => {
    const harness = new Harness();
    const sent: string[] = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const control = registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => role(),
      createClient: () => ({
        send: async (method) => {
          if (method !== "pane.report_agent") return;
          sent.push(method);
          throw new Error("offline");
        },
      }),
      debug: () => undefined,
      scheduleRetry: (callback, delay) => {
        scheduled.push({ callback, delay });
        return () => undefined;
      },
    });
    harness.sessionStart?.("new", session());
    await control.drained();
    expect(scheduled.map(({ delay }) => delay)).toEqual([100]);
    scheduled.shift()?.callback();
    await control.drained();
    expect(scheduled.map(({ delay }) => delay)).toEqual([200]);
    scheduled.shift()?.callback();
    await control.drained();
    expect(sent).toHaveLength(3);
    expect(scheduled).toHaveLength(0);
  });

  test("quit retries only release to the same pane and never resurrects state", async () => {
    const harness = new Harness();
    let binding = role({ paneId: "pane-old" });
    const sent: Array<[string, string]> = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let releaseFailures = 1;
    const control = registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => binding,
      createClient: (_socket, pane) => ({
        send: async (method) => {
          sent.push([pane, method]);
          if (method === "pane.release_agent" && releaseFailures-- > 0) throw new Error("offline");
        },
      }),
      debug: () => undefined,
      scheduleRetry: (callback, delay) => {
        scheduled.push({ callback, delay });
        return () => undefined;
      },
    });
    const ctx = session();
    harness.sessionStart?.("new", ctx);
    await control.drained();
    harness.agentStart?.(ctx);
    await control.drained();
    sent.length = 0;

    harness.sessionShutdown?.("quit", ctx);
    await control.drained();
    expect(scheduled.map(({ delay }) => delay)).toEqual([100]);
    binding = role({ paneId: "pane-new" });
    scheduled.shift()?.callback();
    await control.drained();

    expect(sent).toEqual([["pane-old", "pane.release_agent"]]);
    harness.agentSettled?.(ctx);
    harness.republish?.("session-parent");
    await control.drained();
    expect(sent).toEqual([["pane-old", "pane.release_agent"]]);
  });

  test("exhausts a failed release after three total attempts", async () => {
    const harness = new Harness();
    const sent: string[] = [];
    const scheduled: Array<() => void> = [];
    const control = registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => role(),
      createClient: () => ({
        send: async (method) => {
          if (method !== "pane.release_agent") return;
          sent.push(method);
          throw new Error("offline");
        },
      }),
      debug: () => undefined,
      scheduleRetry: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
    });
    const ctx = session();
    harness.sessionStart?.("new", ctx);
    await control.drained();
    harness.sessionShutdown?.("quit", ctx);
    await control.drained();
    scheduled.shift()?.();
    await control.drained();
    scheduled.shift()?.();
    await control.drained();
    expect(sent).toHaveLength(3);
    expect(scheduled).toHaveLength(0);
  });

  test("reports a bound RPC role turn to its recorded pane", async () => {
    const f = fixture();
    const ctx = session();
    f.harness.sessionStart?.("new", ctx);
    await f.nextReport();
    await f.nextReport();
    f.harness.agentStart?.(ctx);
    await f.nextReport();
    f.harness.agentSettled?.(ctx);
    await f.nextReport();

    expect(
      f.sent.map(({ pane, method, params }) => ({ pane, method, state: params["state"] })),
    ).toEqual([
      { pane: "pane-parent", method: "pane.report_agent_session", state: undefined },
      { pane: "pane-parent", method: "pane.report_agent", state: "idle" },
      { pane: "pane-parent", method: "pane.report_agent", state: "working" },
      { pane: "pane-parent", method: "pane.report_agent", state: "idle" },
    ]);
  });

  test("follows a reattached pane and stops when the binding closes", async () => {
    const f = fixture();
    const ctx = session();
    f.harness.sessionStart?.("new", ctx);
    await f.nextReport();
    await f.nextReport();
    f.setBinding(role({ paneId: "pane-reattached", herdrSocket: "/tmp/new.sock" }));
    f.harness.agentStart?.(ctx);
    await f.nextReport();
    await f.nextReport();
    expect(f.sent.slice(-2).map((item) => [item.socket, item.pane, item.method])).toEqual([
      ["/tmp/new.sock", "pane-reattached", "pane.report_agent_session"],
      ["/tmp/new.sock", "pane-reattached", "pane.report_agent"],
    ]);

    f.setBinding(role({ launchState: "closed" }));
    f.harness.agentSettled?.(ctx);
    await Promise.resolve();
    expect(f.sent).toHaveLength(4);
  });

  test("reports OLW question waits as blocked and clears after settlement", async () => {
    const f = fixture();
    const ctx = session();
    f.harness.sessionStart?.("new", ctx);
    await f.nextReport();
    await f.nextReport();
    f.harness.agentStart?.(ctx);
    await f.nextReport();
    f.harness.continuationHold?.({ source: "olw-question", active: true });
    await f.nextReport();
    f.harness.agentSettled?.(ctx);
    await Promise.resolve();
    f.harness.wakeSource?.({ source: "olw-question", activeCount: 0 });
    await f.nextReport();
    expect(
      f.sent
        .filter((item) => item.method === "pane.report_agent")
        .map((item) => item.params["state"]),
    ).toEqual(["idle", "working", "blocked", "idle"]);
  });

  test("keeps event-driven background work working after the turn settles", async () => {
    const f = fixture();
    const ctx = session();
    f.harness.sessionStart?.("new", ctx);
    await f.nextReport();
    await f.nextReport();
    f.harness.wakeSource?.({ source: "senpi-codemode", activeCount: 1 });
    await f.nextReport();
    f.harness.monitors?.({ activeCount: 2 });
    await f.nextReport();
    expect(f.sent.at(-1)?.params).toMatchObject({
      state: "working",
      message: "2 monitors live + 1 detached eval cell",
    });
  });

  test("session start never waits for a silent transport", async () => {
    const harness = new Harness();
    const silent = Promise.withResolvers<void>();
    registerRoleHerdrReporter(harness, {
      hostRuntime: true,
      lookupBinding: () => role(),
      createClient: () => ({ send: () => silent.promise }),
      debug: () => undefined,
    });
    const returned = harness.sessionStart?.("new", session());
    expect(returned).toBeUndefined();
    silent.resolve();
  });

  test("does not report unbound, closed, or non-host sessions", async () => {
    for (const [hostRuntime, ctx, found] of [
      [true, session(), undefined],
      [true, session(), role({ launchState: "closed" })],
      [false, session("tui"), role()],
    ] as const) {
      const harness = new Harness();
      const sent: unknown[] = [];
      registerRoleHerdrReporter(harness, {
        hostRuntime,
        lookupBinding: () => found,
        createClient: () => ({ send: async (...args) => void sent.push(args) }),
        debug: () => undefined,
      });
      harness.sessionStart?.("new", ctx);
      harness.agentStart?.(ctx);
      await Promise.resolve();
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
      ) as unknown,
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
});
