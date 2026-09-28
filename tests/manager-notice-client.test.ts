import { expect, spyOn, test } from "bun:test";
import type { Binding, DeliveryRecord, Result } from "../src/core/contracts";
import {
  ManagerNoticeDeliveryError,
  type ManagerNoticeRpcClient,
  sendManagerNotice,
} from "../src/extension/manager-notice-client";

const target: Binding = {
  id: "manager",
  designationId: "manager-designation",
  assignment: { role: "manager" },
  durableSessionId: "session-manager",
  cwd: "/repo",
  checkout: null,
  herdrSocket: "/tmp/herdr.sock",
  omoSocket: "/tmp/omo.sock",
  workspaceId: "workspace-manager",
  paneId: "pane-manager",
  sessionPath: "/sessions/manager.jsonl",
  launchState: "ready",
  contactState: "active",
  initialization: { state: "accepted", text: "Fixture initialization" },
};

const rejected: Result<DeliveryRecord> = {
  ok: false,
  error: { code: "identity_mismatch", message: "manager identity changed" },
};
const admissionFailed = {
  phase: "admission_failed" as const,
  cause: rejected.error,
};

class FakeClient implements ManagerNoticeRpcClient {
  readonly calls: string[] = [];
  request: () => Promise<unknown> = async () => admissionFailed;
  stopRequest: () => Promise<void> = async () => {};

  async start(): Promise<void> {
    this.calls.push("start");
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
    await this.stopRequest();
  }
  async listSessions() {
    this.calls.push("listSessions");
    return [
      {
        status: "open",
        durableSessionId: target.durableSessionId,
        sessionPath: "/sessions/manager.jsonl",
        cwd: target.cwd,
        sessionId: "native-manager",
      },
    ];
  }
  async openSession() {
    this.calls.push("openSession");
    return { attached: true, sessionId: "native-manager" };
  }
  async closeSession(): Promise<void> {
    this.calls.push("closeSession");
  }
  async requestExtension(): Promise<unknown> {
    this.calls.push("requestExtension");
    return this.request();
  }
}

test("manager notice client returns target-owned admission phase proof", async () => {
  const client = new FakeClient();
  expect(
    await sendManagerNotice(target, { messageId: "message", nativeKey: "attempt" }, () => client),
  ).toEqual(admissionFailed);
  expect(client.calls).toEqual([
    "start",
    "listSessions",
    "openSession",
    "requestExtension",
    "stop",
  ]);
});

test("manager notice client types failures before requestExtension as retryable", async () => {
  const client = new FakeClient();
  client.listSessions = async () => [];
  const error = await sendManagerNotice(
    target,
    { messageId: "message", nativeKey: "attempt" },
    () => client,
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ManagerNoticeDeliveryError);
  expect(error).toMatchObject({ phase: "before_request" });
  expect(client.calls).not.toContain("requestExtension");
});

test("manager notice client types requestExtension failure as uncertain", async () => {
  const client = new FakeClient();
  client.request = async () => {
    throw new Error("reply lost");
  };
  const error = await sendManagerNotice(
    target,
    { messageId: "message", nativeKey: "attempt" },
    () => client,
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ManagerNoticeDeliveryError);
  expect(error).toMatchObject({ phase: "request_uncertain" });
  expect(client.calls).toContain("requestExtension");
});

test("manager notice client preserves admission proof when stop fails", async () => {
  const client = new FakeClient();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  client.stopRequest = async () => {
    throw new Error("disconnect failed");
  };
  try {
    expect(
      await sendManagerNotice(target, { messageId: "message", nativeKey: "attempt" }, () => client),
    ).toEqual(admissionFailed);
    expect(stderr).toHaveBeenCalledWith(
      "OLW manager notice client cleanup failed",
      expect.any(Error),
    );
  } finally {
    stderr.mockRestore();
  }
});
