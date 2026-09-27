import { createConnection, type Socket } from "node:net";
import { win32 } from "node:path";
import type { Binding } from "../core/contracts";

export type RoleHerdrMethod =
  | "pane.report_agent"
  | "pane.report_agent_session"
  | "pane.release_agent";

export interface RoleHerdrClient {
  send(method: RoleHerdrMethod, params: Record<string, unknown>): Promise<void>;
}

export interface RoleSessionContext {
  readonly mode: "tui" | "rpc" | "app-server" | "json" | "print";
  isIdle(): boolean;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
}

export interface RoleHerdrReporterPort {
  onSessionStart(handler: (reason: string, ctx: RoleSessionContext) => Promise<void> | void): void;
  onAgentStart(handler: (ctx: RoleSessionContext) => Promise<void> | void): void;
  onAgentSettled(handler: (ctx: RoleSessionContext) => Promise<void> | void): void;
  onSessionShutdown(
    handler: (reason: string, ctx: RoleSessionContext) => Promise<void> | void,
  ): void;
  onBlocked(
    handler: (event: { active: boolean; id: string; label?: string }) => Promise<void> | void,
  ): void;
}

export interface RoleHerdrReporterDependencies {
  readonly hostRuntime: boolean;
  lookupBinding(sessionId: string): Binding | undefined;
  createClient(socketPath: string, paneId: string): RoleHerdrClient;
  debug(message: string): void;
}

interface Reporter {
  readonly client: RoleHerdrClient;
  readonly sessionManager: RoleSessionContext["sessionManager"];
  turnActive: boolean;
  blocked: Map<string, string | undefined>;
  lastReport: string | undefined;
}

function report(reporter: Reporter): { state: "working" | "idle" | "blocked"; message?: string } {
  if (reporter.blocked.size > 0) {
    const message = reporter.blocked.values().next().value;
    return { state: "blocked", ...(message === undefined ? {} : { message }) };
  }
  return { state: reporter.turnActive ? "working" : "idle" };
}

export function registerRoleHerdrReporter(
  port: RoleHerdrReporterPort,
  dependencies: RoleHerdrReporterDependencies,
): void {
  const reporters = new Map<string, Reporter>();
  let active: Reporter | undefined;

  const sessionRef = (reporter: Reporter) => {
    const path = reporter.sessionManager.getSessionFile();
    return path
      ? { agent_session_path: path }
      : { agent_session_id: reporter.sessionManager.getSessionId() };
  };
  async function send(
    reporter: Reporter,
    method: RoleHerdrMethod,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await reporter.client.send(method, params);
      return true;
    } catch (cause) {
      dependencies.debug(cause instanceof Error ? cause.message : "Herdr transport failed");
      return false;
    }
  }
  async function publish(reporter: Reporter): Promise<void> {
    const next = report(reporter);
    const key = JSON.stringify(next);
    if (key === reporter.lastReport) return;
    reporter.lastReport = key;
    if (
      !(await send(reporter, "pane.report_agent", {
        agent: "pi",
        ...sessionRef(reporter),
        ...next,
      }))
    )
      reporter.lastReport = undefined;
  }

  port.onSessionStart(async (reason, ctx) => {
    if (
      !dependencies.hostRuntime ||
      ctx.mode === "tui" ||
      reporters.has(ctx.sessionManager.getSessionId())
    )
      return;
    let binding: Binding | undefined;
    let client: RoleHerdrClient;
    try {
      binding = dependencies.lookupBinding(ctx.sessionManager.getSessionId());
      if (binding?.paneId === null || binding?.paneId === undefined) return;
      client = dependencies.createClient(binding.herdrSocket, binding.paneId);
    } catch (cause) {
      dependencies.debug(cause instanceof Error ? cause.message : "Herdr reporter setup failed");
      return;
    }
    const reporter: Reporter = {
      client,
      sessionManager: ctx.sessionManager,
      turnActive: !ctx.isIdle(),
      blocked: new Map(),
      lastReport: undefined,
    };
    reporters.set(ctx.sessionManager.getSessionId(), reporter);
    await send(reporter, "pane.report_agent_session", {
      agent: "pi",
      ...sessionRef(reporter),
      session_start_source: reason,
    });
    await publish(reporter);
  });
  port.onAgentStart(async (ctx) => {
    const reporter = reporters.get(ctx.sessionManager.getSessionId());
    if (reporter === undefined) return;
    active = reporter;
    reporter.turnActive = true;
    await publish(reporter);
  });
  port.onAgentSettled(async (ctx) => {
    const reporter = reporters.get(ctx.sessionManager.getSessionId());
    if (reporter === undefined) return;
    reporter.turnActive = false;
    await publish(reporter);
    if (active === reporter && !reporter.turnActive) active = undefined;
  });
  port.onBlocked(async (event) => {
    if (active === undefined) return;
    if (event.active) active.blocked.set(event.id, event.label);
    else active.blocked.delete(event.id);
    await publish(active);
  });
  port.onSessionShutdown(async (reason, ctx) => {
    const reporter = reporters.get(ctx.sessionManager.getSessionId());
    if (reporter === undefined) return;
    if (reason === "quit") await send(reporter, "pane.release_agent", { agent: "pi" });
    reporters.delete(ctx.sessionManager.getSessionId());
    if (active === reporter) active = undefined;
  });
}

let sequence = 0;

export function roleHerdrRequest(
  method: RoleHerdrMethod,
  params: Record<string, unknown>,
  paneId: string,
  seq: number,
): {
  id: string;
  method: RoleHerdrMethod;
  params: Record<string, unknown>;
} {
  return {
    id: `custom:senpi:${seq}`,
    method,
    params: { ...params, pane_id: paneId, source: "custom:senpi", seq },
  };
}

class SocketRoleHerdrClient implements RoleHerdrClient {
  readonly #queue: Array<{
    request: ReturnType<typeof roleHerdrRequest>;
    resolve: () => void;
    reject: (cause: Error) => void;
  }> = [];
  readonly #target: string;
  readonly #paneId: string;
  readonly #connect: (path: string) => Socket;
  #draining = false;

  public constructor(socketPath: string, paneId: string, connect: (path: string) => Socket) {
    this.#target =
      process.platform !== "win32" || /^\\\\[.?]\\pipe\\/i.test(socketPath)
        ? socketPath
        : win32.join("\\\\.\\pipe\\", socketPath);
    this.#paneId = paneId;
    this.#connect = connect;
  }

  public send(method: RoleHerdrMethod, params: Record<string, unknown>): Promise<void> {
    sequence = Math.max(sequence + 1, Date.now() * 1000);
    const request = roleHerdrRequest(method, params, this.#paneId, sequence);
    return new Promise((resolve, reject) => {
      this.#queue.push({ request, resolve, reject });
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const next = this.#queue.shift();
        if (next === undefined) return;
        if ((await this.#attempt(next.request, 500)) || (await this.#attempt(next.request, 1_500)))
          next.resolve();
        else
          next.reject(new Error(`Herdr request failed after two attempts: ${next.request.method}`));
      }
    } finally {
      this.#draining = false;
    }
  }

  #attempt(request: ReturnType<typeof roleHerdrRequest>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let socket: Socket;
      try {
        socket = this.#connect(this.#target);
      } catch {
        resolve(false);
        return;
      }
      let finished = false;
      let buffer = "";
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(success);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref();
      socket.on("error", () => finish(false));
      socket.on("end", () => finish(false));
      socket.on("close", () => finish(false));
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 65_536) return finish(false);
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response: unknown = JSON.parse(buffer.slice(0, newline));
          finish(
            typeof response === "object" &&
              response !== null &&
              "id" in response &&
              response.id === request.id &&
              "result" in response &&
              !("error" in response),
          );
        } catch {
          finish(false);
        }
      });
    });
  }
}

export function createRoleHerdrClient(
  socketPath: string,
  paneId: string,
  connect: (path: string) => Socket = createConnection,
): RoleHerdrClient {
  return new SocketRoleHerdrClient(socketPath, paneId, connect);
}
