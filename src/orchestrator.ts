import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RpcClient, SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import type {
  Assignment,
  Binding,
  Checkout,
  DeliveryRecord,
  Designation,
  Envelope,
  Registry,
  Result,
  ScopeSnapshot,
} from "./core/contracts";
import { initializationMessageId, matchesRuntime, modelForRole } from "./core/policy";
import { openRegistry } from "./core/store";
import { createHerdrClient, type HerdrClient } from "./herdr";
import { createHostProfile } from "./host-profile";
import { buildRoleBrief, readScopeSnapshot } from "./linear";
import { removeReadiness, subscribeReadiness } from "./readiness";
import { attachBinding, type NativeSession } from "./transport";

const normalizedPaneSchema = z.strictObject({
  paneId: z.string(),
  sessionPath: z.string().nullable(),
});
const herdrPaneEventSchema = z.object({
  data: z.object({
    pane: z.object({
      pane_id: z.string(),
      agent_session: z
        .object({ kind: z.literal("path"), value: z.string() })
        .nullable()
        .optional(),
    }),
  }),
});
const herdrConnectionErrorSchema = z.strictObject({
  event: z.literal("connection.error"),
  data: z.strictObject({ code: z.string(), message: z.string() }),
});

export interface CreateSupervisorInput {
  readonly initiativeId: string;
  readonly scopeDigest: string;
  readonly designationId: string;
  readonly execute: boolean;
  readonly fixture: boolean;
}
export interface CreateParentInput {
  readonly supervisorId: string;
  readonly projectId: string;
  readonly repo: string;
  readonly base: string;
}
export interface CreateChildInput {
  readonly parentId: string;
  readonly issueId: string;
}
export interface SendInput {
  readonly fromId: string;
  readonly toId: string;
  readonly messageId: string;
  readonly kind: "instruction" | "coordination";
  readonly text: string;
}
export interface ReportInput {
  readonly fromId: string;
  readonly messageId: string;
  readonly outcome: "completed" | "blocked" | "failed";
  readonly evidence: readonly string[];
  readonly text: string;
}
export interface CreationResult {
  readonly binding: Binding;
  readonly expectedModel: ReturnType<typeof modelForRole>;
  readonly readiness: "ready";
  readonly execution: "not_started" | "brief_accepted";
  readonly ancestry: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseCommit: string;
  } | null;
}
export interface OrchestratorDependencies {
  readonly openRegistry: (path: string) => Registry;
  readonly createHerdrClient: (socket: string) => HerdrClient;
  readonly attachBinding: (binding: Binding) => Promise<NativeSession>;
  readonly terminateBinding: (binding: Binding) => Promise<void>;
  readonly ensureHost: (root: string, socket: string) => Promise<void>;
  readonly prompt: (binding: Binding, text: string) => Promise<void>;
  readonly gitTip: (repo: string, revision: string) => Promise<string>;
  readonly now: () => string;
  readonly uuid: () => string;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function failure<T>(code: string, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Decode either P2's normalized pane callback or Herdr's pane.updated envelope. */
export function readSessionPath(event: unknown, paneId: string): string | null {
  const normalized = normalizedPaneSchema.safeParse(event);
  if (normalized.success) {
    return normalized.data.paneId === paneId ? normalized.data.sessionPath : null;
  }
  const source = herdrPaneEventSchema.safeParse(event);
  if (!source.success || source.data.data.pane.pane_id !== paneId) return null;
  return source.data.data.pane.agent_session?.value ?? null;
}

async function defaultEnsureHost(root: string, socket: string): Promise<void> {
  const profile = await createHostProfile(root);
  const process = Bun.spawn(
    [
      join(root, "node_modules/.bin/omo"),
      "host",
      "ensure",
      "--socket",
      socket,
      "--launch-spec",
      profile,
      "--policy",
      "never",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`omo host ensure failed (${code}): ${stderr.trim()}`);
}

async function defaultPrompt(binding: Binding, text: string): Promise<void> {
  if (binding.sessionPath === null)
    throw new Error("Cannot prompt a binding without a session path");
  const client = new RpcClient({ socketPath: binding.omoSocket });
  await client.start();
  try {
    const sessions = await client.listSessions();
    const found = sessions.find(
      (session) =>
        session.status === "open" &&
        session.durableSessionId === binding.durableSessionId &&
        session.sessionPath === binding.sessionPath &&
        session.cwd === binding.cwd,
    );
    if (found === undefined) throw new Error("Exact durable native session is not open for prompt");
    const opened = await client.openSession({
      sessionPath: binding.sessionPath,
      cwd: binding.cwd,
      retain_on_disconnect: true,
    });
    if (opened.sessionId !== found.sessionId || opened.attached !== true) {
      throw new Error("Native host did not attach the exact existing session for prompt");
    }
    await client.prompt(text);
  } finally {
    await client.stop();
  }
}

async function defaultGitTip(repo: string, revision: string): Promise<string> {
  const process = Bun.spawn(["git", "-C", repo, "rev-parse", `${revision}^{commit}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git rev-parse failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

async function defaultTerminateBinding(binding: Binding): Promise<void> {
  if (binding.sessionPath === null) return;
  const client = new RpcClient({ socketPath: binding.omoSocket });
  await client.start();
  try {
    const sessions = await client.listSessions();
    const matches = sessions.filter(
      (session) =>
        session.durableSessionId === binding.durableSessionId ||
        session.sessionPath === binding.sessionPath,
    );
    if (matches.length > 1) throw new Error("Multiple native sessions claim the closing identity");
    const session = matches[0];
    if (session === undefined) {
      if (
        sessions.some(
          (candidate) => candidate.status === "opening" && candidate.cwd === binding.cwd,
        )
      ) {
        throw new Error("Native startup is still opening; reconcile closure after it settles");
      }
      return;
    }
    if (
      session.cwd !== binding.cwd ||
      session.sessionPath !== binding.sessionPath ||
      (session.durableSessionId !== undefined &&
        session.durableSessionId !== binding.durableSessionId)
    )
      throw new Error("Refusing to close a different native identity");
    const opened = await client.openSession({
      sessionPath: binding.sessionPath,
      cwd: binding.cwd,
      retain_on_disconnect: false,
    });
    if (opened.attached !== true || opened.sessionId !== session.sessionId) {
      if (opened.attached === false) await client.closeSession(opened.sessionId);
      throw new Error("Native identity changed during closure");
    }
    await client.abort();
    await client.closeSession(session.sessionId);
    if (
      (await client.listSessions()).some(
        (candidate) => candidate.durableSessionId === binding.durableSessionId,
      )
    ) {
      throw new Error(
        "Native role still has another attachment; disconnect it before completing closure",
      );
    }
  } finally {
    await client.stop();
  }
}

const defaults: OrchestratorDependencies = {
  openRegistry,
  createHerdrClient,
  attachBinding,
  terminateBinding: defaultTerminateBinding,
  ensureHost: defaultEnsureHost,
  prompt: defaultPrompt,
  gitTip: defaultGitTip,
  now: () => new Date().toISOString(),
  uuid: () => crypto.randomUUID(),
};

export class Orchestrator {
  readonly #root: string;
  readonly #herdrSocket: string;
  readonly #omoSocket: string;
  readonly #dbPath: string;
  readonly #deps: OrchestratorDependencies;

  public constructor(
    root: string,
    herdrSocket?: string,
    dependencies: OrchestratorDependencies = defaults,
  ) {
    this.#root = resolve(root);
    this.#herdrSocket =
      herdrSocket ??
      process.env["HERDR_SOCKET_PATH"] ??
      join(process.env["HOME"] ?? this.#root, ".config/herdr/herdr.sock");
    this.#omoSocket = join(this.#root, ".omo/state/omo.sock");
    this.#dbPath = join(this.#root, ".omo/state/registry.sqlite");
    this.#deps = dependencies;
  }

  public paths() {
    return {
      root: this.#root,
      herdrSocket: this.#herdrSocket,
      omoSocket: this.#omoSocket,
      registry: this.#dbPath,
    };
  }

  public async importScope(
    file: string,
    fixture: boolean,
  ): Promise<Result<{ readonly digest: string }>> {
    const snapshot = await readScopeSnapshot(file);
    if (!snapshot.ok) return snapshot;
    if (fixture !== (snapshot.value.source === "fixture")) {
      return failure("source_mismatch", "--fixture must exactly match the snapshot source");
    }
    return this.#withRegistry((registry) => registry.importScope(snapshot.value));
  }

  public async createSupervisor(input: CreateSupervisorInput): Promise<Result<CreationResult>> {
    const scope = this.#withRegistry((registry) => registry.scope(input.scopeDigest));
    if (!scope.ok) return scope;
    if (scope.value.initiative.id !== input.initiativeId)
      return failure("scope_violation", "Initiative does not match scope");
    if (input.fixture !== (scope.value.source === "fixture"))
      return failure("source_mismatch", "--fixture must exactly match scope source");
    const previous = this.#withRegistry((registry) => registry.designation(input.designationId));
    if (!previous.ok && previous.error.code !== "not_found") return previous;
    if (
      previous.ok &&
      (previous.value.snapshotDigest !== input.scopeDigest ||
        previous.value.execute !== input.execute)
    ) {
      return failure("designation_conflict", "Existing designation has different approval");
    }
    const designation: Designation = previous.ok
      ? previous.value
      : {
          id: input.designationId,
          snapshotDigest: input.scopeDigest,
          designatedBy: process.env["USER"] ?? "local-user",
          designatedAt: this.#deps.now(),
          execute: input.execute,
          create: true,
          contact: true,
        };
    return this.#create(
      { role: "supervisor", initiativeId: input.initiativeId },
      designation,
      scope.value,
      this.#root,
      null,
    );
  }

  public async createParent(input: CreateParentInput): Promise<Result<CreationResult>> {
    const owner = this.#binding(input.supervisorId);
    if (!owner.ok) return owner;
    if (owner.value.assignment.role !== "supervisor")
      return failure("owner_mismatch", "Parent owner must be a supervisor");
    if (owner.value.launchState !== "ready" || owner.value.contactState !== "active")
      return failure("owner_unavailable", "Supervisor is not available for role creation");
    const context = await this.#context(owner.value);
    if (!context.ok) return context;
    const originalRepoRoot = resolve(input.repo);
    const baseCommit = await this.#deps.gitTip(originalRepoRoot, input.base);
    const bindingId = this.#deps.uuid();
    const checkout: Checkout = {
      originalRepoRoot,
      path: join(this.#root, ".omo/worktrees", bindingId),
      branch: `omo/${owner.value.designationId}/projects/${input.projectId}-${bindingId}`,
      baseBranch: input.base,
      baseCommit,
    };
    const assignment: Assignment = {
      role: "parent",
      initiativeId: owner.value.assignment.initiativeId,
      projectId: input.projectId,
      ownerBindingId: owner.value.id,
    };
    return this.#create(
      assignment,
      context.value.designation,
      context.value.snapshot,
      checkout.path,
      checkout,
      bindingId,
    );
  }

  public async createChild(input: CreateChildInput): Promise<Result<CreationResult>> {
    const owner = this.#binding(input.parentId);
    if (!owner.ok) return owner;
    if (owner.value.assignment.role !== "parent" || owner.value.checkout === null)
      return failure("owner_mismatch", "Child owner must be a parent worktree");
    if (owner.value.launchState !== "ready" || owner.value.contactState !== "active")
      return failure("owner_unavailable", "Parent is not available for role creation");
    const context = await this.#context(owner.value);
    if (!context.ok) return context;
    const baseCommit = await this.#deps.gitTip(
      owner.value.checkout.originalRepoRoot,
      owner.value.checkout.branch,
    );
    const bindingId = this.#deps.uuid();
    const checkout: Checkout = {
      originalRepoRoot: owner.value.checkout.originalRepoRoot,
      path: join(this.#root, ".omo/worktrees", bindingId),
      branch: `omo/${owner.value.designationId}/issues/${input.issueId}-${bindingId}`,
      baseBranch: owner.value.checkout.branch,
      baseCommit,
    };
    const assignment: Assignment = {
      role: "child",
      initiativeId: owner.value.assignment.initiativeId,
      projectId: owner.value.assignment.projectId,
      issueId: input.issueId,
      ownerBindingId: owner.value.id,
    };
    return this.#create(
      assignment,
      context.value.designation,
      context.value.snapshot,
      checkout.path,
      checkout,
      bindingId,
    );
  }

  public async send(input: SendInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    const context = await this.#context(sender.value);
    if (!context.ok) return context;
    return this.#deliver(sender.value, {
      version: 1,
      id: input.messageId,
      fromBindingId: sender.value.id,
      toBindingId: input.toId,
      designationId: sender.value.designationId,
      snapshotDigest: context.value.designation.snapshotDigest,
      kind: input.kind,
      text: input.text,
      outcome: null,
      evidence: [],
    });
  }

  public async report(input: ReportInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    if (sender.value.assignment.role === "supervisor")
      return failure("route_denied", "Supervisor has no owner to report to");
    const context = await this.#context(sender.value);
    if (!context.ok) return context;
    return this.#deliver(sender.value, {
      version: 1,
      id: input.messageId,
      fromBindingId: sender.value.id,
      toBindingId: sender.value.assignment.ownerBindingId,
      designationId: sender.value.designationId,
      snapshotDigest: context.value.designation.snapshotDigest,
      kind: "report",
      text: input.text,
      outcome: input.outcome,
      evidence: [...input.evidence],
    });
  }

  public status(initiativeId?: string): Result<Binding[]> {
    return this.#withRegistry((registry) => {
      const listed = registry.list();
      if (!listed.ok || initiativeId === undefined) return listed;
      return ok(listed.value.filter((binding) => binding.assignment.initiativeId === initiativeId));
    });
  }

  public setPaused(bindingId: string, paused: boolean): Result<Binding> {
    return this.#withRegistry((registry) =>
      registry.setContactState(bindingId, paused ? "paused" : "active"),
    );
  }

  public async close(bindingId: string, confirmAbsent = false): Promise<Result<Binding>> {
    const closing = this.#withRegistry((registry) => registry.beginClose(bindingId));
    if (!closing.ok || closing.value.launchState === "closed") return closing;
    const binding = closing.value;
    const herdr = this.#deps.createHerdrClient(binding.herdrSocket);
    try {
      const snapshot = await herdr.snapshot();
      const workspaces = snapshot.workspaces.filter((workspace) =>
        binding.workspaceId === null
          ? workspace.label === `omo-${binding.assignment.role}-${binding.id}` &&
            workspace.cwd === binding.cwd
          : workspace.workspaceId === binding.workspaceId,
      );
      if (workspaces.length > 1)
        return failure("identity_mismatch", "Multiple workspaces claim this role");
      const workspace = workspaces[0];
      if (
        workspace === undefined &&
        binding.workspaceId === null &&
        binding.sessionPath === null &&
        !confirmAbsent
      ) {
        return failure(
          "closure_uncertain",
          "Inspect Herdr, then use --confirm-absent if no workspace was created",
        );
      }
      if (workspace !== undefined) {
        if (
          workspace.cwd !== binding.cwd ||
          workspace.label !== `omo-${binding.assignment.role}-${binding.id}`
        ) {
          return failure(
            "identity_mismatch",
            "Owned workspace identity changed; inspect it before closing",
          );
        }
        await herdr.closeWorkspace(workspace.workspaceId);
      }
      if (binding.sessionPath !== null) {
        await this.#deps.ensureHost(this.#root, binding.omoSocket);
        await this.#deps.terminateBinding(binding);
      }
      await removeReadiness(this.#root, binding.id);
      return this.#withRegistry((registry) => registry.finishClose(binding.id));
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Closure is incomplete; ownership remains held",
        messageOf(cause),
      );
    } finally {
      herdr.close();
    }
  }

  public async reconcile(
    initiativeId: string,
  ): Promise<Result<{ readonly observed: number; readonly bindings: Binding[] }>> {
    const listed = this.status(initiativeId);
    if (!listed.ok) return listed;
    const herdr = this.#deps.createHerdrClient(this.#herdrSocket);
    try {
      const snapshot = await herdr.snapshot();
      let observed = 0;
      const issues: Array<{ bindingId: string; code: string; message: string }> = [];
      const lost = (binding: Binding, code: string, message: string) => {
        const marked = this.#withRegistry((registry) =>
          registry.setLaunchState(binding.id, "uncertain"),
        );
        issues.push({ bindingId: binding.id, ...(marked.ok ? { code, message } : marked.error) });
        if (marked.ok && binding.launchState !== "uncertain") observed += 1;
      };
      for (const binding of listed.value) {
        if (binding.launchState === "closed") continue;
        if (binding.launchState === "closing") {
          const closed = await this.close(binding.id);
          if (closed.ok) observed += 1;
          else issues.push({ bindingId: binding.id, ...closed.error });
          continue;
        }
        const workspace = snapshot.workspaces.find(
          (candidate) => candidate.workspaceId === binding.workspaceId,
        );
        if (
          !workspace ||
          workspace.cwd !== binding.cwd ||
          workspace.label !== `omo-${binding.assignment.role}-${binding.id}` ||
          !snapshot.panes.some(
            (pane) => pane.paneId === binding.paneId && pane.workspaceId === binding.workspaceId,
          )
        ) {
          lost(
            binding,
            "workspace_unavailable",
            "The assigned Herdr workspace or pane is not present",
          );
          continue;
        }
        try {
          if (binding.launchState === "ready") {
            const session = await this.#deps.attachBinding(binding);
            try {
              const identity = await session.describe();
              if (!identity.ok) lost(binding, identity.error.code, identity.error.message);
              else if (!matchesRuntime(binding, identity.value))
                lost(
                  binding,
                  "identity_mismatch",
                  "Live role no longer matches its native identity or model",
                );
            } finally {
              await session.close();
            }
            continue;
          }
          if (binding.sessionPath === null) {
            lost(
              binding,
              "startup_incomplete",
              "No native session was allocated; inspect and close the incomplete role",
            );
            continue;
          }
          if (binding.launchState !== "provisioning") {
            const resumed = this.#withRegistry((registry) =>
              registry.setLaunchState(binding.id, "provisioning"),
            );
            if (!resumed.ok) {
              issues.push({ bindingId: binding.id, ...resumed.error });
              continue;
            }
          }
          const currentBinding = this.#binding(binding.id);
          if (!currentBinding.ok) {
            issues.push({ bindingId: binding.id, ...currentBinding.error });
            continue;
          }
          const ready = await this.#verifyAndActivate(currentBinding.value);
          if (!ready.ok) {
            lost(binding, ready.error.code, ready.error.message);
            continue;
          }
          const context = await this.#context(ready.value);
          if (!context.ok) {
            issues.push({ bindingId: binding.id, ...context.error });
            continue;
          }
          const initialized = await this.#initialize(ready.value, context.value.snapshot);
          if (!initialized.ok) issues.push({ bindingId: binding.id, ...initialized.error });
          else observed += 1;
        } catch (cause) {
          lost(binding, "runtime_unavailable", messageOf(cause));
        }
      }
      const current = this.status(initiativeId);
      if (!current.ok) return current;
      return issues.length === 0
        ? ok({ observed, bindings: current.value })
        : failure(
            "reconciliation_uncertain",
            "Some roles require intervention; no role was relaunched",
            { observed, bindings: current.value, issues },
          );
    } catch (cause) {
      for (const binding of listed.value) {
        if (binding.launchState !== "closed" && binding.launchState !== "closing") {
          this.#withRegistry((registry) => registry.setLaunchState(binding.id, "uncertain"));
        }
      }
      return failure("runtime_unavailable", "Reconciliation observation failed", messageOf(cause));
    } finally {
      herdr.close();
    }
  }

  async #create(
    assignment: Assignment,
    designation: Designation,
    snapshot: ScopeSnapshot,
    cwd: string,
    checkout: Checkout | null,
    fixedBindingId?: string,
  ): Promise<Result<CreationResult>> {
    const bindingId = fixedBindingId ?? this.#deps.uuid();
    const reserved = this.#withRegistry((registry) =>
      registry.reserve({
        bindingId,
        durableSessionId: this.#deps.uuid(),
        designation,
        snapshot,
        assignment,
        cwd,
        checkout,
        herdrSocket: this.#herdrSocket,
        omoSocket: this.#omoSocket,
      }),
    );
    if (!reserved.ok) return reserved;
    try {
      await this.#deps.ensureHost(this.#root, this.#omoSocket);
    } catch (cause) {
      this.#withRegistry((registry) => {
        const closing = registry.beginClose(bindingId);
        return closing.ok ? registry.finishClose(bindingId) : closing;
      });
      return failure("runtime_unavailable", "Native host launch failed", messageOf(cause));
    }

    const herdr = this.#deps.createHerdrClient(this.#herdrSocket);
    let stop: (() => void) | undefined;
    let stopReadiness: (() => void) | undefined;
    try {
      const readySignal = Promise.withResolvers<string>();
      const readinessOutcome = readySignal.promise.then(
        (value) => ({ ok: true, value }) as const,
        (reason: unknown) => ({ ok: false, reason }) as const,
      );
      stop = await herdr.subscribe((event) => {
        const connectionError = herdrConnectionErrorSchema.safeParse(event);
        if (connectionError.success) {
          readySignal.reject(
            new Error(
              `Herdr subscription ${connectionError.data.data.code}: ${connectionError.data.data.message}`,
            ),
          );
          return;
        }
      });
      const workspace =
        checkout === null
          ? await herdr.createWorkspace(cwd, `omo-${assignment.role}-${bindingId}`)
          : await herdr.createWorktree(checkout, `omo-${assignment.role}-${bindingId}`);
      const provisioned = this.#withRegistry((registry) =>
        registry.provision(bindingId, workspace.workspaceId, workspace.rootPaneId),
      );
      if (!provisioned.ok) return provisioned;
      if (checkout !== null) {
        const observedHead = await this.#deps.gitTip(checkout.path, "HEAD");
        if (observedHead !== checkout.baseCommit) {
          throw new Error(
            `Worktree ancestry conflict: expected ${checkout.baseCommit}, observed ${observedHead}`,
          );
        }
      }
      const model = modelForRole(assignment.role);
      const manager = SessionManager.create(cwd, join(this.#root, ".omo/state/sessions"), {
        id: reserved.value.durableSessionId,
      });
      manager.appendModelChange(model.provider, model.modelId);
      manager.appendThinkingLevelChange(model.thinking);
      const seedPath = manager.getSessionFile();
      const header = manager.getHeader();
      if (seedPath === undefined || header === null) {
        throw new Error("Native session manager did not allocate a session identity");
      }
      const entries = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry));
      await writeFile(seedPath, `${entries.join("\n")}\n`, { mode: 0o600, flag: "wx" });
      const allocated = this.#withRegistry((registry) =>
        registry.observeSession(bindingId, seedPath),
      );
      if (!allocated.ok) return allocated;
      const readiness = await subscribeReadiness(this.#root, provisioned.value);
      stopReadiness = readiness.close;
      void readiness.promise.then(
        (receipt) => readySignal.resolve(receipt.sessionPath),
        (cause: unknown) => readySignal.reject(cause),
      );
      await herdr.run(
        workspace.rootPaneId,
        [
          "env",
          "-u",
          "OMO_INITIATIVE_HOST",
          `OMO_ENABLE_SHARED_HOST=1`,
          `OMO_RPC_SOCKET=${this.#omoSocket}`,
          `OMO_INITIATIVE_ROOT=${this.#root}`,
          join(this.#root, "node_modules/.bin/omo"),
          "-e",
          join(this.#root, "dist/extension/index.js"),
          "--session",
          seedPath,
          "--name",
          `omo-${assignment.role}-${bindingId}`,
          "--model",
          `${model.provider}/${model.modelId}`,
          "--thinking",
          model.thinking,
          "--no-model-fallback",
          "--no-recommended-models",
        ],
        {},
      );
      const timeout = setTimeout(
        () => readySignal.reject(new Error("Timed out awaiting OMO TUI readiness")),
        15_000,
      );
      timeout.unref();
      let sessionPath: string;
      try {
        const outcome = await readinessOutcome;
        if (!outcome.ok) throw outcome.reason;
        sessionPath = outcome.value;
      } finally {
        clearTimeout(timeout);
      }
      const observed = this.#withRegistry((registry) =>
        registry.observeSession(bindingId, sessionPath),
      );
      if (!observed.ok) return observed;
      const activated = await this.#verifyAndActivate(observed.value);
      if (!activated.ok) return activated;
      const initialized = await this.#initialize(activated.value, snapshot);
      if (!initialized.ok) return initialized;
      return ok({
        binding: initialized.value,
        expectedModel: model,
        readiness: "ready",
        execution: "brief_accepted",
        ancestry:
          checkout === null
            ? null
            : {
                branch: checkout.branch,
                baseBranch: checkout.baseBranch,
                baseCommit: checkout.baseCommit,
              },
      });
    } catch (cause) {
      this.#withRegistry((registry) => registry.setLaunchState(bindingId, "uncertain"));
      return failure(
        "runtime_unavailable",
        "Role creation became uncertain; reconcile before retrying",
        messageOf(cause),
      );
    } finally {
      stopReadiness?.();
      stop?.();
      herdr.close();
    }
  }

  async #verifyAndActivate(binding: Binding): Promise<Result<Binding>> {
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(binding);
      await session.configure(modelForRole(binding.assignment.role));
      const identity = await session.describe();
      if (!identity.ok) return identity;
      return this.#withRegistry((registry) => registry.activate(binding.id, identity.value));
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Could not verify native runtime identity",
        messageOf(cause),
      );
    } finally {
      await session?.close();
    }
  }

  #finishInitialization(
    bindingId: string,
    outcome: "accepted" | "rejected" | "uncertain",
    details?: unknown,
  ): Result<Binding> {
    const finished = this.#withRegistry((registry) =>
      registry.finishInitialization(bindingId, outcome),
    );
    if (!finished.ok) return finished;
    if (finished.value.initialization.state === "accepted") {
      return finished.value.launchState === "ready"
        ? finished
        : failure(
            "runtime_unavailable",
            "Instruction was accepted but runtime identity requires reconciliation",
            finished.value,
          );
    }
    return failure(
      outcome === "rejected" ? "brief_rejected" : "brief_uncertain",
      "Initial role instruction was not confirmed accepted; no automatic resend",
      details ?? finished.value,
    );
  }

  async #initialize(binding: Binding, snapshot: ScopeSnapshot): Promise<Result<Binding>> {
    const text = binding.initialization.text ?? buildRoleBrief(binding, snapshot);
    const claim = this.#withRegistry((registry) => registry.beginInitialization(binding.id, text));
    if (!claim.ok) return claim;
    if (claim.value.disposition === "replay") return ok(claim.value.binding);
    const messageId = initializationMessageId(binding.id);
    try {
      if (claim.value.disposition === "in_progress") {
        if (binding.assignment.role === "supervisor") {
          const session = await this.#deps.attachBinding(binding);
          try {
            if (await session.hasUserMessage(text))
              return this.#finishInitialization(binding.id, "accepted");
          } finally {
            await session.close();
          }
        } else {
          const delivery = this.#withRegistry((registry) => registry.delivery(messageId));
          if (
            delivery.ok &&
            (delivery.value.state === "accepted" || delivery.value.state === "rejected")
          ) {
            return this.#finishInitialization(binding.id, delivery.value.state, delivery.value);
          }
          if (!delivery.ok && delivery.error.code !== "not_found") return delivery;
        }
        return this.#finishInitialization(binding.id, "uncertain");
      }
      if (binding.assignment.role === "supervisor") {
        await this.#deps.prompt(binding, text);
        return this.#finishInitialization(binding.id, "accepted");
      }
      const owner = this.#binding(binding.assignment.ownerBindingId);
      if (!owner.ok) return this.#finishInitialization(binding.id, "uncertain", owner.error);
      const context = await this.#context(binding);
      if (!context.ok) return this.#finishInitialization(binding.id, "uncertain", context.error);
      const delivery = await this.#deliver(owner.value, {
        version: 1,
        id: messageId,
        fromBindingId: owner.value.id,
        toBindingId: binding.id,
        designationId: binding.designationId,
        snapshotDigest: context.value.designation.snapshotDigest,
        kind: "instruction",
        text,
        outcome: null,
        evidence: [],
      });
      if (!delivery.ok) return this.#finishInitialization(binding.id, "uncertain", delivery.error);
      return this.#finishInitialization(
        binding.id,
        delivery.value.state === "accepted"
          ? "accepted"
          : delivery.value.state === "rejected"
            ? "rejected"
            : "uncertain",
        delivery.value,
      );
    } catch (cause) {
      return this.#finishInitialization(binding.id, "uncertain", messageOf(cause));
    }
  }

  async #deliver(sender: Binding, envelope: Envelope): Promise<Result<DeliveryRecord>> {
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(sender);
      return await session.send(envelope);
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Native delivery failed without a safe retry",
        messageOf(cause),
      );
    } finally {
      await session?.close();
    }
  }

  #binding(id: string): Result<Binding> {
    return this.#withRegistry((registry) => registry.get(id));
  }

  async #context(
    binding: Binding,
  ): Promise<Result<{ readonly designation: Designation; readonly snapshot: ScopeSnapshot }>> {
    const designation = this.#withRegistry((registry) =>
      registry.designation(binding.designationId),
    );
    if (!designation.ok) return designation;
    const snapshot = this.#withRegistry((registry) =>
      registry.scope(designation.value.snapshotDigest),
    );
    if (!snapshot.ok) return snapshot;
    return ok({ designation: designation.value, snapshot: snapshot.value });
  }

  #withRegistry<T>(operation: (registry: Registry) => Result<T>): Result<T> {
    mkdirSync(join(this.#root, ".omo/state"), { recursive: true, mode: 0o700 });
    const registry = this.#deps.openRegistry(this.#dbPath);
    try {
      return operation(registry);
    } finally {
      registry.close();
    }
  }
}
