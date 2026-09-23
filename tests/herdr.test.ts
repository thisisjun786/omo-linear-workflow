import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrClient, HerdrError } from "../src/herdr";

interface Request {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}
type Reply = (socket: Socket, request: Request) => void;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function isRequest(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "method" in value &&
    typeof value.method === "string" &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null
  );
}
function listening(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}
function closing(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
async function fixture(reply: Reply) {
  const directory = await mkdtemp(join(tmpdir(), "omo-herdr-"));
  const path = join(directory, "socket");
  const requests: Request[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const value: unknown = JSON.parse(buffer.slice(0, newline));
      if (!isRequest(value)) throw new Error("bad fixture request");
      requests.push(value);
      reply(socket, value);
    });
  });
  await listening(server, path);
  cleanups.push(async () => {
    await closing(server);
    await rm(directory, { recursive: true, force: true });
  });
  return { path, requests };
}
const workspace = (id: string, tab: string) => ({
  workspace_id: id,
  number: 1,
  label: id,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: tab,
  agent_status: "unknown",
  tokens: {},
});
const pane = (id: string, ws: string, tab: string, cwd: string, revision = 0) => ({
  pane_id: id,
  terminal_id: `terminal:${id}`,
  workspace_id: ws,
  tab_id: tab,
  focused: false,
  cwd,
  agent_status: "unknown",
  state_labels: {},
  tokens: {},
  revision,
});
const ok = (
  socket: Socket,
  id: string,
  result: Readonly<Record<string, unknown>> = { type: "ok" },
) => socket.end(`${JSON.stringify({ id, result })}\n`);

describe("HerdrClient", () => {
  test("reports a disconnected subscription after its acknowledgement", async () => {
    const socket = new Socket();
    const write = spyOn(socket, "write").mockImplementation((chunk: unknown) => {
      const request: unknown = JSON.parse(String(chunk));
      if (!isRequest(request)) throw new Error("Invalid fixture request");
      socket.push(
        `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
      );
      return true;
    });
    const disconnected = Promise.withResolvers<unknown>();
    const deadline = setTimeout(
      () => disconnected.reject(new Error("Subscription close was not reported")),
      1000,
    );
    const client = createHerdrClient("/test/socket", () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    cleanups.push(() => {
      clearTimeout(deadline);
      client.close();
      write.mockRestore();
    });
    await client.subscribe(disconnected.resolve);
    socket.destroy();
    await expect(disconnected.promise).resolves.toMatchObject({
      event: "connection.error",
      data: { code: "connection_closed" },
    });
  });

  test("preserves a Korean path when socket chunks split inside a UTF-8 character", async () => {
    const socket = new Socket();
    const write = spyOn(socket, "write").mockImplementation((chunk: unknown) => {
      const request: unknown = JSON.parse(String(chunk));
      if (!isRequest(request)) throw new Error("Invalid fixture request");
      const bytes = Buffer.from(
        `${JSON.stringify({
          id: request.id,
          result: {
            type: "workspace_created",
            workspace: { workspace_id: "ws" },
            root_pane: { pane_id: "pane", cwd: "/tmp/한글" },
          },
        })}\n`,
      );
      const split = bytes.indexOf(Buffer.from("한")) + 1;
      socket.push(bytes.subarray(0, split));
      socket.push(bytes.subarray(split));
      return true;
    });
    const client = createHerdrClient("/test/socket", () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    cleanups.push(() => {
      client.close();
      write.mockRestore();
    });
    await expect(client.createWorkspace("/tmp/한글", "Korean path")).resolves.toMatchObject({
      cwd: "/tmp/한글",
    });
  });

  test("uses source-backed create params/replies and correlates fragmented/coalesced JSONL", async () => {
    const server = await fixture((socket, request) => {
      const type = request.method === "workspace.create" ? "workspace_created" : "worktree_created";
      const result = {
        type,
        workspace: workspace("ws-reply", "tab-reply"),
        tab: { tab_id: "tab-reply" },
        root_pane: pane("pane-reply", "ws-reply", "tab-reply", "/reply/path"),
        ...(type === "worktree_created" ? { worktree: { path: "/reply/path" } } : {}),
      };
      const line = JSON.stringify({ id: request.id, result });
      socket.write(
        `${JSON.stringify({ id: "other", result: { type: "ok" } })}\n${line.slice(0, 31)}`,
      );
      socket.end(`${line.slice(31)}\n`);
    });
    const client = createHerdrClient(server.path);
    cleanups.push(() => client.close());
    await expect(client.createWorkspace("/requested", "supervisor")).resolves.toEqual({
      workspaceId: "ws-reply",
      rootPaneId: "pane-reply",
      cwd: "/reply/path",
    });
    const checkout = {
      originalRepoRoot: "/repo",
      path: "/worktree",
      branch: "child",
      baseBranch: "parent",
      baseCommit: "abc",
    };
    await expect(client.createWorktree(checkout, "child")).resolves.toEqual({
      workspaceId: "ws-reply",
      rootPaneId: "pane-reply",
      cwd: "/reply/path",
    });
    expect(server.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "workspace.create",
        params: { cwd: "/requested", label: "supervisor", focus: false, env: {} },
      },
      {
        method: "worktree.create",
        params: {
          cwd: "/repo",
          branch: "child",
          base: "parent",
          path: "/worktree",
          label: "child",
          focus: false,
          trust_repository: false,
        },
      },
    ]);
  });

  test("quotes hostile argv/env once and uses explicit pane.send_input", async () => {
    let command = "";
    const server = await fixture((socket, request) => {
      const { text } = request.params;
      command = String(text);
      ok(socket, request.id);
    });
    const client = createHerdrClient(server.path);
    cleanups.push(() => client.close());
    const directory = await mkdtemp(join(tmpdir(), "omo-herdr-run-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "out.json");
    const fixturePath = join(import.meta.dir, "herdr", "argv-fixture.ts");
    const arg = "space ' $HOME ; $(echo no)\nline";
    const value = "env ' $PATH && no\nline";
    await client.run("pane-id", [fixturePath, arg, ""], {
      HERDR_FIXTURE_OUTPUT: output,
      HOSTILE_VALUE: value,
    });
    expect(server.requests[0]).toMatchObject({
      method: "pane.send_input",
      params: { pane_id: "pane-id", keys: ["Enter"] },
    });
    const process = Bun.spawn(["/bin/sh", "-c", command], { stderr: "pipe" });
    expect(await process.exited).toBe(0);
    expect(await Bun.file(output).json()).toEqual({ argv: [arg, ""], value });
  });

  test("awaits a separate subscription ACK and emits parsed event envelopes", async () => {
    let ack: (() => void) | undefined;
    let subscription: Socket | undefined;
    const gate = new Promise<void>((resolve) => {
      ack = resolve;
    });
    let eventResolve: ((event: unknown) => void) | undefined;
    const eventSeen = new Promise<unknown>((resolve) => {
      eventResolve = resolve;
    });
    const server = await fixture((socket, request) => {
      if (request.method !== "events.subscribe") {
        ok(socket, request.id);
        return;
      }
      subscription = socket;
      void gate.then(() =>
        socket.write(
          `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n` +
            `${JSON.stringify({ event: "workspace.created", data: { workspace_id: "new" } })}\n`,
        ),
      );
    });
    const client = createHerdrClient(server.path);
    cleanups.push(() => client.close());
    let resolved = false;
    const pending = client
      .subscribe((event) => {
        eventResolve?.(event);
      })
      .then((stop) => {
        resolved = true;
        return stop;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);
    ack?.();
    const stop = await pending;
    expect(await eventSeen).toEqual({ event: "workspace.created", data: { workspace_id: "new" } });
    await client.closeWorkspace("old");
    expect(subscription?.destroyed).toBe(false);
    expect(server.requests.filter(({ method }) => method === "events.subscribe")).toHaveLength(1);
    stop();
  });

  test("maps snapshots, reports identity, and sends bounded cleanup requests", async () => {
    const server = await fixture((socket, request) => {
      if (request.method === "worktree.remove") {
        ok(socket, request.id, {
          type: "worktree_removed",
          workspace_id: "child",
          path: "/worktrees/child",
          forced: false,
        });
        return;
      }
      if (request.method !== "session.snapshot") {
        ok(socket, request.id);
        return;
      }
      ok(socket, request.id, {
        type: "session_snapshot",
        snapshot: {
          version: "1",
          protocol: 1,
          focused_workspace_id: "ws",
          focused_tab_id: "tab",
          focused_pane_id: "pane",
          workspaces: [workspace("ws", "tab")],
          tabs: [],
          panes: [
            {
              ...pane("pane", "ws", "tab", "/cwd", 42),
              agent_session: { source: "x", agent: "omo", kind: "path", value: "/session" },
            },
          ],
          layouts: [
            {
              workspace_id: "ws",
              tab_id: "tab",
              focused_pane_id: "pane",
              panes: [{ pane_id: "pane" }],
            },
          ],
          agents: [],
        },
      });
    });
    const client = createHerdrClient(server.path);
    cleanups.push(() => client.close());
    await expect(client.snapshot()).resolves.toEqual({
      focusedWorkspaceId: "ws",
      focusedTabId: "tab",
      focusedPaneId: "pane",
      workspaces: [{ workspaceId: "ws", rootPaneId: "pane", cwd: "/cwd", label: "ws" }],
      panes: [{ paneId: "pane", workspaceId: "ws", revision: 42, sessionPath: "/session" }],
    });
    await client.reportSession("pane", "/session");
    await client.removeWorktree("child");
    expect(server.requests.slice(1).map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "pane.report_agent_session",
        params: {
          pane_id: "pane",
          source: "omo-initiative",
          agent: "omo",
          agent_session_path: "/session",
        },
      },
      {
        method: "worktree.remove",
        params: { workspace_id: "child", force: false, trust_repository: false },
      },
    ]);
  });

  test("preserves upstream errors and rejects disconnects", async () => {
    let first = true;
    const server = await fixture((socket, request) => {
      if (first) {
        first = false;
        socket.end(
          `${JSON.stringify({ id: request.id, error: { code: "dirty_worktree_requires_force", message: "checkout has changes" } })}\n`,
        );
      } else socket.destroy();
    });
    const client = createHerdrClient(server.path);
    cleanups.push(() => client.close());
    const failure = client.removeWorktree("dirty");
    await expect(failure).rejects.toBeInstanceOf(HerdrError);
    await expect(failure).rejects.toMatchObject({
      code: "dirty_worktree_requires_force",
      message: "checkout has changes",
    });
    await expect(client.closeWorkspace("gone")).rejects.toMatchObject({
      code: "connection_closed",
    });
  });
});
