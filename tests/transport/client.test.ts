import { describe, expect, test } from "bun:test";
import type { RpcClientEvent } from "@code-yeongyu/senpi";
import type { Binding, DeliveryRecord, Envelope } from "../../src/core/contracts";
import {
  attachBindingWithClient,
  NativeSessionNotReadyError,
  probeBindingSessionWithClient,
  type RpcPort,
} from "../../src/transport/client";

const sessionPath = "/sessions/parent.jsonl";

const binding: Binding = {
  id: "parent",
  designationId: "designation-1",
  assignment: {
    role: "parent",
    initiativeId: "initiative-1",
    projectId: "project-1",
    ownerBindingId: "supervisor",
  },
  durableSessionId: "durable-parent",
  cwd: "/repo/parent",
  checkout: null,
  herdrSocket: "/tmp/herdr.sock",
  omoSocket: "/tmp/omo.sock",
  workspaceId: "workspace-parent",
  paneId: "pane-parent",
  sessionPath,
  launchState: "ready",
  initialization: { state: "accepted", text: "Fixture initialization" },
  contactState: "active",
};

const envelope: Envelope = {
  version: 1,
  id: "message-1",
  fromBindingId: "supervisor",
  toBindingId: "parent",
  designationId: "designation-1",
  snapshotDigest: "digest",
  kind: "instruction",
  text: "payload",
  outcome: null,
  evidence: [],
};

const record: DeliveryRecord = {
  envelope,
  state: "accepted",
  receipt: {
    kind: "ok",
    thread_id: binding.durableSessionId,
    message_seq: 1,
    deduplicated: false,
    delivery: { kind: "started", turn_id: "turn-1" },
  },
};

class FakeRpc implements RpcPort {
  messages: unknown[] = [];
  async getMessages(): Promise<unknown[]> {
    return this.messages;
  }
  configuration: string[] = [];
  async setModel(provider: string, modelId: string): Promise<void> {
    this.configuration.push(`${provider}/${modelId}`);
  }
  async setThinkingLevel(level: string): Promise<void> {
    this.configuration.push(level);
  }
  started = 0;
  stopped = 0;
  destroyed = 0;
  destroy(): void {
    this.destroyed += 1;
  }
  closeSessionCalls = 0;
  sessions: Array<{
    sessionId: string;
    durableSessionId: string;
    sessionPath: string;
    cwd: string;
    status: "opening" | "open" | "closing" | "closed";
  }> = [
    {
      sessionId: "host-row-parent",
      durableSessionId: binding.durableSessionId,
      sessionPath,
      cwd: binding.cwd,
      status: "open",
    },
  ];
  opened = { sessionId: "host-row-parent", attached: true };
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  async closeSession(_sessionId?: string): Promise<void> {
    this.closeSessionCalls += 1;
  }
  async listSessions() {
    return this.sessions;
  }
  async openSession(_options: {
    readonly sessionPath?: string;
    readonly cwd?: string;
    readonly retain_on_disconnect?: boolean;
  }) {
    return this.opened;
  }
  async requestExtension(name: string): Promise<unknown> {
    const value: unknown =
      name === "omo.initiative.describe"
        ? {
            ok: true,
            value: {
              durableSessionId: binding.durableSessionId,
              sessionPath,
              cwd: binding.cwd,
              provider: "opencodex",
              modelId: "kimi-k3",
              thinking: "max",
              extensionProtocol: 1,
            },
          }
        : { ok: true, value: record };
    return Promise.resolve(value);
  }
  onEvent(_listener: (event: RpcClientEvent) => void): () => void {
    return () => {};
  }
}

describe("native session client", () => {
  test("attaches only an exact existing durable id, path, and cwd", async () => {
    const missing = new FakeRpc();
    missing.start = () => Promise.reject(new Error("host unavailable"));
    await expect(attachBindingWithClient(binding, missing)).rejects.toThrow("host unavailable");

    const wrong = new FakeRpc();
    wrong.sessions = [
      {
        sessionId: "host-row-parent",
        durableSessionId: binding.durableSessionId,
        sessionPath,
        cwd: "/wrong",
        status: "open",
      },
    ];
    await expect(attachBindingWithClient(binding, wrong)).rejects.toThrow(
      "Exact durable native session is not open",
    );
    expect(wrong.stopped).toBe(1);

    const created = new FakeRpc();
    created.opened = { sessionId: "different", attached: false };
    await expect(attachBindingWithClient(binding, created)).rejects.toThrow(
      "did not attach the exact existing session",
    );
    expect(created.stopped).toBe(1);
    expect(created.closeSessionCalls).toBe(1);

    const duplicate = new FakeRpc();
    duplicate.sessions.push({
      sessionId: "duplicate-row",
      durableSessionId: binding.durableSessionId,
      sessionPath,
      cwd: binding.cwd,
      status: "open",
    });
    await expect(attachBindingWithClient(binding, duplicate)).rejects.toThrow(
      "exactly one durable native session",
    );
    expect(duplicate.stopped).toBe(1);
  });

  test.each(["opening", "closing"] as const)(
    "reports an exact %s session as present but not ready",
    async (status) => {
      const rpc = new FakeRpc();
      const exact = rpc.sessions[0];
      if (exact === undefined) throw new Error("Missing exact session fixture");
      rpc.sessions[0] = { ...exact, status };
      await expect(attachBindingWithClient(binding, rpc)).rejects.toBeInstanceOf(
        NativeSessionNotReadyError,
      );
      expect(rpc.stopped).toBe(1);
      expect(rpc.opened).toEqual({ sessionId: "host-row-parent", attached: true });
    },
  );

  test("bounded probing stops the client on timeout", async () => {
    const rpc = new FakeRpc();
    const never = Promise.withResolvers<void>();
    rpc.start = () => never.promise;
    const timers: Array<() => void> = [];
    const result = await probeBindingSessionWithClient(binding, rpc, 1, (expire) => {
      timers.push(expire);
      queueMicrotask(expire);
      return () => {};
    });
    expect(timers).toHaveLength(2);
    expect(result).toEqual({ state: "unknown", reason: "Native session probe timed out" });
    expect(rpc.stopped).toBe(1);
  });

  test("probe cleanup is bounded when RPC stop stalls", async () => {
    const rpc = new FakeRpc();
    rpc.start = () => Promise.reject(new Error("host unavailable"));
    rpc.stop = () => new Promise<void>(() => {});
    rpc.destroy = () => {
      rpc.destroyed += 1;
    };
    const timers: Array<() => void> = [];
    const result = await probeBindingSessionWithClient(binding, rpc, 1, (expire) => {
      timers.push(expire);
      if (timers.length === 2) queueMicrotask(expire);
      return () => {};
    });
    expect(result).toEqual({ state: "unknown", reason: "host unavailable" });
    expect(timers).toHaveLength(2);
    expect(rpc.destroyed).toBe(1);
  });

  test("validates extension replies and close only disconnects the client", async () => {
    const rpc = new FakeRpc();
    const session = await attachBindingWithClient(binding, rpc);
    rpc.messages = [
      { role: "assistant", content: "not-user" },
      { role: "user", content: [{ type: "text", text: "recorded" }] },
    ];
    expect(await session.hasUserMessage("recorded")).toBe(true);
    expect(await session.hasUserMessage("not-user")).toBe(false);
    await session.configure({ provider: "opencodex", modelId: "kimi-k3", thinking: "max" });
    expect(rpc.configuration).toEqual(["opencodex/kimi-k3", "max"]);
    expect(await session.describe()).toEqual({
      ok: true,
      value: {
        durableSessionId: binding.durableSessionId,
        sessionPath,
        cwd: binding.cwd,
        provider: "opencodex",
        modelId: "kimi-k3",
        thinking: "max",
        extensionProtocol: 1,
      },
    });
    expect(await session.send(envelope)).toEqual({ ok: true, value: record });
    await session.close();
    expect(rpc.stopped).toBe(1);
    expect(rpc.closeSessionCalls).toBe(0);
  });
});
