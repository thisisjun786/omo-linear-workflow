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
  onSessionStart(handler: (reason: string, ctx: RoleSessionContext) => void): void;
  onMessageStart(handler: (ctx: RoleSessionContext) => void): void;
  onAgentStart(handler: (ctx: RoleSessionContext) => void): void;
  onAgentSettled(handler: (ctx: RoleSessionContext) => void): void;
  onSessionShutdown(handler: (reason: string, ctx: RoleSessionContext) => void): void;
  onBlocked(handler: (event: BlockedEvent) => void): void;
  onWakeSource(handler: (event: WakeSourceEvent) => void): void;
  onContinuationHold(handler: (event: ContinuationHoldEvent) => void): void;
  onMonitors(handler: (event: MonitorEvent) => void): void;
}
interface BlockedEvent {
  readonly active: boolean;
  readonly id: string;
  readonly label?: string;
}
export interface WakeSourceEvent {
  readonly source: string;
  readonly activeCount: number;
}
export interface ContinuationHoldEvent {
  readonly source: string;
  readonly active: boolean;
}
export interface MonitorEvent {
  readonly activeCount: number;
}
export interface RoleHerdrReporterDependencies {
  readonly hostRuntime: boolean;
  lookupBinding(sessionId: string): Binding | undefined;
  createClient(socketPath: string, paneId: string): RoleHerdrClient;
  debug(message: string): void;
}
interface Target {
  readonly socket: string;
  readonly pane: string;
  readonly client: RoleHerdrClient;
}
interface Reporter {
  readonly sessionManager: RoleSessionContext["sessionManager"];
  target: Target | undefined;
  turnActive: boolean;
  readonly blocked: Map<string, string | undefined>;
  readonly wakeSources: Map<string, number>;
  monitorCount: number;
  lastReport: string | undefined;
  queue: Promise<void>;
  stopped: boolean;
  sessionSource: string;
}
const representedWakeSources = new Set(["terminal-monitors", "senpi-task", "ask-user"]);
const wakeLabels: Readonly<Record<string, readonly [string, string]>> = {
  "terminal-background-sessions": ["background session", "background sessions"],
  "senpi-codemode": ["detached eval cell", "detached eval cells"],
  "omo-dag": ["DAG run", "DAG runs"],
  "loop-guard-hard-stop": ["loop-guard recovery pending", "loop-guard recoveries pending"],
};

function selectedReport(reporter: Reporter) {
  if (reporter.blocked.size > 0) {
    const message = reporter.blocked.values().next().value;
    return { state: "blocked" as const, ...(message === undefined ? {} : { message }) };
  }
  const parts: string[] = [];
  const children = reporter.wakeSources.get("senpi-task") ?? 0;
  if (children > 0) parts.push(`${children} subagent${children === 1 ? "" : "s"} running`);
  if (reporter.monitorCount > 0)
    parts.push(`${reporter.monitorCount} monitor${reporter.monitorCount === 1 ? "" : "s"} live`);
  for (const [source, count] of [...reporter.wakeSources].sort(([a], [b]) => a.localeCompare(b))) {
    if (representedWakeSources.has(source)) continue;
    const label = wakeLabels[source];
    parts.push(
      label === undefined ? `${count} ${source}` : `${count} ${count === 1 ? label[0] : label[1]}`,
    );
  }
  return reporter.turnActive || parts.length > 0
    ? { state: "working" as const, ...(parts.length === 0 ? {} : { message: parts.join(" + ") }) }
    : { state: "idle" as const };
}

export function registerRoleHerdrReporter(
  port: RoleHerdrReporterPort,
  dependencies: RoleHerdrReporterDependencies,
): void {
  const reporters = new Map<string, Reporter>();
  let currentSessionId: string | undefined;
  const live = (binding: Binding | undefined): binding is Binding & { paneId: string } =>
    binding !== undefined &&
    binding.paneId !== null &&
    binding.launchState !== "closing" &&
    binding.launchState !== "closed";
  const sessionRef = (reporter: Reporter) => {
    const path = reporter.sessionManager.getSessionFile();
    return path
      ? { agent_session_path: path }
      : { agent_session_id: reporter.sessionManager.getSessionId() };
  };
  function enqueue(reporter: Reporter, work: () => Promise<void>): void {
    reporter.queue = reporter.queue.then(work).catch((cause: unknown) => {
      dependencies.debug(cause instanceof Error ? cause.message : "Herdr transport failed");
    });
  }
  async function target(reporter: Reporter): Promise<Target | undefined> {
    if (reporter.stopped) return undefined;
    let binding: Binding | undefined;
    try {
      binding = dependencies.lookupBinding(reporter.sessionManager.getSessionId());
    } catch (cause) {
      dependencies.debug(cause instanceof Error ? cause.message : "Herdr binding lookup failed");
      return undefined;
    }
    if (!live(binding)) {
      reporter.target = undefined;
      reporter.lastReport = undefined;
      return undefined;
    }
    if (reporter.target?.socket === binding.herdrSocket && reporter.target.pane === binding.paneId)
      return reporter.target;
    reporter.target = {
      socket: binding.herdrSocket,
      pane: binding.paneId,
      client: dependencies.createClient(binding.herdrSocket, binding.paneId),
    };
    reporter.lastReport = undefined;
    await reporter.target.client.send("pane.report_agent_session", {
      agent: "pi",
      ...sessionRef(reporter),
      session_start_source: reporter.sessionSource,
    });
    reporter.sessionSource = "resume";
    return reporter.target;
  }
  function publish(reporter: Reporter): void {
    enqueue(reporter, async () => {
      const next = selectedReport(reporter);
      const key = JSON.stringify(next);
      const destination = await target(reporter);
      if (destination === undefined || reporter.lastReport === key) return;
      await destination.client.send("pane.report_agent", {
        agent: "pi",
        ...sessionRef(reporter),
        ...next,
      });
      reporter.lastReport = key;
    });
  }
  function ensureReporter(ctx: RoleSessionContext, reason: string): Reporter | undefined {
    if (!dependencies.hostRuntime || ctx.mode === "tui") return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = reporters.get(sessionId);
    if (existing !== undefined) return existing;
    const reporter: Reporter = {
      sessionManager: ctx.sessionManager,
      target: undefined,
      turnActive: !ctx.isIdle(),
      blocked: new Map(),
      wakeSources: new Map(),
      monitorCount: 0,
      lastReport: undefined,
      queue: Promise.resolve(),
      stopped: false,
      sessionSource: reason,
    };
    reporters.set(sessionId, reporter);
    currentSessionId = sessionId;
    return reporter;
  }
  port.onSessionStart((reason, ctx) => {
    const reporter = ensureReporter(ctx, reason);
    if (reporter !== undefined) publish(reporter);
  });
  port.onMessageStart((ctx) => {
    const reporter = ensureReporter(ctx, "resume");
    if (reporter !== undefined) currentSessionId = ctx.sessionManager.getSessionId();
  });
  port.onAgentStart((ctx) => {
    const reporter = ensureReporter(ctx, "resume");
    if (reporter === undefined) return;
    currentSessionId = ctx.sessionManager.getSessionId();
    reporter.turnActive = true;
    publish(reporter);
  });
  port.onAgentSettled((ctx) => {
    const reporter = reporters.get(ctx.sessionManager.getSessionId());
    if (reporter === undefined) return;
    reporter.turnActive = false;
    publish(reporter);
  });
  port.onBlocked((event) => {
    const reporter = currentSessionId === undefined ? undefined : reporters.get(currentSessionId);
    if (reporter === undefined) return;
    if (event.active) reporter.blocked.set(event.id, event.label);
    else reporter.blocked.delete(event.id);
    publish(reporter);
  });
  port.onContinuationHold((event) => {
    const reporter = currentSessionId === undefined ? undefined : reporters.get(currentSessionId);
    if (reporter === undefined || event.source !== "olw-question") return;
    if (event.active) reporter.blocked.set(event.source, "waiting for OLW answer");
    else reporter.blocked.delete(event.source);
    publish(reporter);
  });
  port.onWakeSource((event) => {
    const reporter = currentSessionId === undefined ? undefined : reporters.get(currentSessionId);
    if (reporter === undefined) return;
    if (event.source === "olw-question") {
      if (event.activeCount === 0) reporter.blocked.delete(event.source);
      else reporter.blocked.set(event.source, "waiting for OLW answer");
    } else if (event.activeCount > 0) reporter.wakeSources.set(event.source, event.activeCount);
    else reporter.wakeSources.delete(event.source);
    publish(reporter);
  });
  port.onMonitors((event) => {
    const reporter = currentSessionId === undefined ? undefined : reporters.get(currentSessionId);
    if (reporter === undefined) return;
    reporter.monitorCount = event.activeCount;
    publish(reporter);
  });
  port.onSessionShutdown((reason, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const reporter = reporters.get(sessionId);
    if (reporter === undefined) return;
    if (reason === "quit")
      enqueue(reporter, async () => {
        const binding = dependencies.lookupBinding(sessionId);
        if (live(binding)) {
          const destination =
            reporter.target?.socket === binding.herdrSocket &&
            reporter.target.pane === binding.paneId
              ? reporter.target
              : {
                  socket: binding.herdrSocket,
                  pane: binding.paneId,
                  client: dependencies.createClient(binding.herdrSocket, binding.paneId),
                };
          await destination.client.send("pane.release_agent", { agent: "pi" });
        }
        reporter.stopped = true;
      });
    else reporter.stopped = true;
    reporters.delete(sessionId);
    if (currentSessionId === sessionId) currentSessionId = undefined;
  });
}

let sequence = 0;
export function roleHerdrRequest(
  method: RoleHerdrMethod,
  params: Record<string, unknown>,
  paneId: string,
  seq: number,
) {
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
