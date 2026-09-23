import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";
import type { Checkout } from "../core/contracts";
import {
  absolutePathSchema,
  envSchema,
  eventFrameSchema,
  nonEmptyStringSchema,
  okResultSchema,
  snapshotResultSchema,
  subscriptionStartedSchema,
  successFrameSchema,
  upstreamErrorSchema,
  workspaceResultSchema,
  worktreeRemovedSchema,
} from "./schema";

const REQUEST_TIMEOUT_MS = 6_000;
const MAX_FRAME_BUFFER_BYTES = 1024 * 1024;
const SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
].map((type) => ({ type }));

export interface Workspace {
  readonly workspaceId: string;
  readonly rootPaneId: string;
  readonly cwd: string;
  readonly label?: string;
}
export interface Pane {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly sessionPath: string | null;
}
export interface Snapshot {
  readonly focusedWorkspaceId: string | null;
  readonly focusedTabId: string | null;
  readonly focusedPaneId: string | null;
  readonly workspaces: readonly Workspace[];
  readonly panes: readonly Pane[];
}
export interface HerdrClient {
  createWorkspace(cwd: string, label: string): Promise<Workspace>;
  createWorktree(checkout: Checkout, label: string): Promise<Workspace>;
  run(
    paneId: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<void>;
  reportSession(paneId: string, sessionPath: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  subscribe(listener: (event: unknown) => void): Promise<() => void>;
  closeWorkspace(id: string): Promise<void>;
  removeWorktree(id: string): Promise<void>;
  close(): void;
}
export class HerdrError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

class SocketHerdrClient implements HerdrClient {
  readonly #socketPath: string;
  readonly #connect: (path: string) => Socket;
  readonly #sockets = new Set<Socket>();
  #closed = false;

  public constructor(socketPath: string, connect: (path: string) => Socket) {
    this.#socketPath = nonEmptyStringSchema.parse(socketPath);
    this.#connect = connect;
  }

  public async createWorkspace(cwd: string, label: string): Promise<Workspace> {
    const result = workspaceResultSchema.parse(
      await this.#request("workspace.create", {
        cwd: absolutePathSchema.parse(cwd),
        label: nonEmptyStringSchema.parse(label),
        focus: false,
        env: {},
      }),
    );
    const replyCwd = result.root_pane.cwd;
    if (replyCwd === null || replyCwd === undefined)
      throw new HerdrError("invalid_response", "workspace reply omitted root pane cwd");
    return {
      workspaceId: result.workspace.workspace_id,
      rootPaneId: result.root_pane.pane_id,
      cwd: replyCwd,
    };
  }

  public async createWorktree(checkout: Checkout, label: string): Promise<Workspace> {
    const result = workspaceResultSchema.parse(
      await this.#request("worktree.create", {
        cwd: absolutePathSchema.parse(checkout.originalRepoRoot),
        branch: nonEmptyStringSchema.parse(checkout.branch),
        base: nonEmptyStringSchema.parse(checkout.baseBranch),
        path: absolutePathSchema.parse(checkout.path),
        label: nonEmptyStringSchema.parse(label),
        focus: false,
        trust_repository: false,
      }),
    );
    if (result.worktree === undefined)
      throw new HerdrError("invalid_response", "worktree reply omitted worktree data");
    return {
      workspaceId: result.workspace.workspace_id,
      rootPaneId: result.root_pane.pane_id,
      cwd: result.worktree.path,
    };
  }

  public async run(
    paneId: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    const parsedArgv = z.array(z.string()).min(1).parse(argv);
    const parsedEnv = envSchema.parse(env);
    const words = [
      "env",
      ...Object.entries(parsedEnv).map(([key, value]) => `${key}=${value}`),
      ...parsedArgv,
    ];
    await this.#expectOk("pane.send_input", {
      pane_id: nonEmptyStringSchema.parse(paneId),
      text: words.map(shellQuote).join(" "),
      keys: ["Enter"],
    });
  }

  public async reportSession(paneId: string, sessionPath: string): Promise<void> {
    await this.#expectOk("pane.report_agent_session", {
      pane_id: nonEmptyStringSchema.parse(paneId),
      source: "omo-initiative",
      agent: "omo",
      agent_session_path: absolutePathSchema.parse(sessionPath),
    });
  }
  public async closeWorkspace(id: string): Promise<void> {
    await this.#expectOk("workspace.close", {
      workspace_id: nonEmptyStringSchema.parse(id),
      close_group: false,
    });
  }
  public async removeWorktree(id: string): Promise<void> {
    worktreeRemovedSchema.parse(
      await this.#request("worktree.remove", {
        workspace_id: nonEmptyStringSchema.parse(id),
        force: false,
        trust_repository: false,
      }),
    );
  }

  public async snapshot(): Promise<Snapshot> {
    const result = snapshotResultSchema.parse(await this.#request("session.snapshot", {}));
    const panes = result.snapshot.panes.map((source) => ({
      paneId: source.pane_id,
      workspaceId: source.workspace_id,
      revision: source.revision,
      sessionPath: source.agent_session?.kind === "path" ? source.agent_session.value : null,
    }));
    const workspaces = result.snapshot.workspaces.map((source): Workspace => {
      const layout = result.snapshot.layouts.find(
        (candidate) =>
          candidate.workspace_id === source.workspace_id &&
          candidate.tab_id === source.active_tab_id,
      );
      const root = layout?.panes[0];
      const rootPane =
        root === undefined
          ? undefined
          : result.snapshot.panes.find((candidate) => candidate.pane_id === root.pane_id);
      if (root === undefined || rootPane?.cwd === null || rootPane?.cwd === undefined) {
        throw new HerdrError(
          "invalid_response",
          `snapshot omitted root pane cwd for workspace ${source.workspace_id}`,
        );
      }
      return {
        workspaceId: source.workspace_id,
        rootPaneId: root.pane_id,
        cwd: rootPane.cwd,
        ...(source.label === undefined ? {} : { label: source.label }),
      };
    });
    return {
      focusedWorkspaceId: result.snapshot.focused_workspace_id,
      focusedTabId: result.snapshot.focused_tab_id,
      focusedPaneId: result.snapshot.focused_pane_id,
      workspaces,
      panes,
    };
  }

  public subscribe(listener: (event: unknown) => void): Promise<() => void> {
    if (this.#closed)
      return Promise.reject(new HerdrError("client_closed", "Herdr client is closed"));
    const id = requestId();
    return new Promise((resolve, reject) => {
      const socket = this.#openSocket();
      let buffer = "";
      let acknowledged = false;
      let stopped = false;
      const timeout = setTimeout(
        () => fail(new HerdrError("request_timeout", "Herdr events.subscribe timed out")),
        REQUEST_TIMEOUT_MS,
      );
      timeout.unref();
      const stop = () => {
        stopped = true;
        clearTimeout(timeout);
        this.#sockets.delete(socket);
        socket.destroy();
      };
      const fail = (error: HerdrError) => {
        if (stopped) return;
        stop();
        if (acknowledged) {
          if (!this.#closed) {
            listener({
              event: "connection.error",
              data: { code: error.code, message: error.message },
            });
          }
        } else reject(error);
      };
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: SUBSCRIPTIONS } })}\n`,
        ),
      );
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME_BUFFER_BYTES) {
          fail(new HerdrError("frame_too_large", "Herdr subscription frame exceeded limit"));
          return;
        }
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseJson(line);
          if (!parsed.ok) {
            fail(parsed.error);
            return;
          }
          const value = parsed.value;
          const error = upstreamErrorSchema.safeParse(value);
          if (error.success && error.data.id === id) {
            fail(new HerdrError(error.data.error.code, error.data.error.message));
            return;
          }
          const success = successFrameSchema.safeParse(value);
          if (success.success && success.data.id === id) {
            const ack = subscriptionStartedSchema.safeParse(success.data.result);
            if (!ack.success) {
              fail(
                new HerdrError(
                  "invalid_response",
                  "Herdr returned an invalid subscription acknowledgement",
                ),
              );
              return;
            }
            if (!acknowledged) {
              acknowledged = true;
              clearTimeout(timeout);
              resolve(stop);
            }
            continue;
          }
          const event = eventFrameSchema.safeParse(value);
          if (acknowledged && event.success) listener(event.data);
        }
      });
      socket.once("error", (error) => fail(new HerdrError("connection_error", error.message)));
      socket.once("close", () =>
        fail(new HerdrError("connection_closed", "Herdr subscription connection closed")),
      );
    });
  }

  public close(): void {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }

  async #expectOk(method: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    okResultSchema.parse(await this.#request(method, params));
  }
  #request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new HerdrError("client_closed", "Herdr client is closed"));
    const id = requestId();
    return new Promise((resolve, reject) => {
      const socket = this.#openSocket();
      let buffer = "";
      let settled = false;
      const finish = (outcome: { readonly value: unknown } | { readonly error: HerdrError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#sockets.delete(socket);
        socket.destroy();
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const timeout = setTimeout(
        () => finish({ error: new HerdrError("request_timeout", `Herdr ${method} timed out`) }),
        REQUEST_TIMEOUT_MS,
      );
      timeout.unref();
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME_BUFFER_BYTES) {
          finish({ error: new HerdrError("frame_too_large", "Herdr response exceeded limit") });
          return;
        }
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseJson(line);
          if (!parsed.ok) {
            finish({ error: parsed.error });
            return;
          }
          const value = parsed.value;
          const upstream = upstreamErrorSchema.safeParse(value);
          if (upstream.success && upstream.data.id === id) {
            finish({
              error: new HerdrError(upstream.data.error.code, upstream.data.error.message),
            });
            return;
          }
          const success = successFrameSchema.safeParse(value);
          if (success.success && success.data.id === id) {
            finish({ value: success.data.result });
            return;
          }
        }
      });
      socket.once("error", (error) =>
        finish({ error: new HerdrError("connection_error", error.message) }),
      );
      socket.once("close", () =>
        finish({
          error: new HerdrError(
            "connection_closed",
            `Herdr ${method} connection closed before a response`,
          ),
        }),
      );
    });
  }
  #openSocket(): Socket {
    const socket = this.#connect(this.#socketPath);
    socket.setEncoding("utf8");
    this.#sockets.add(socket);
    return socket;
  }
}

function requestId(): string {
  return `omo-initiative:${randomUUID()}`;
}
function parseJson(
  line: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: HerdrError } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, error: new HerdrError("invalid_json", "Herdr returned invalid JSONL") };
  }
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
export function createHerdrClient(
  socketPath: string,
  connect: (path: string) => Socket = createConnection,
): HerdrClient {
  return new SocketHerdrClient(socketPath, connect);
}
