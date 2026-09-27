import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { RpcClient, SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import type {
  Assignment,
  Binding,
  Checkout,
  ChildStage,
  Deliverable,
  DeliveryRecord,
  Designation,
  Envelope,
  Registry,
  Result,
  ScopeFilter,
  ScopeSnapshot,
  StageHandoff,
} from "./core/contracts";
import {
  canRetryDelivery,
  initializationMessageId,
  type ManagerModelResolution,
  ManagerSettingsError,
  matchesRuntime,
  modelForBinding,
  modelForLaunch,
  questionRecipient,
  type RoleModel,
  resolveManagerModel,
} from "./core/policy";
import { envelopeSchema } from "./core/schema";
import { openRegistry } from "./core/store";
import { createHerdrClient, type HerdrClient } from "./herdr";
import { resolveHerdrArtifact } from "./herdr/artifact";
import {
  assertHostProtocol,
  createHostProfile,
  HostProfileMismatchError,
  runtimeCacheEnvironment,
} from "./host-profile";
import { buildRoleBrief, readScopeSnapshot, roleLabel } from "./linear";
import { ensureRouting, globalOmo } from "./proxy/routing-launch";
import { type Readiness, removeReadiness, subscribeReadiness } from "./readiness";
import {
  checkoutGit,
  cloneCheckout,
  initializeCheckout,
  ownedCheckoutPath,
  unpushedCommits,
} from "./repo/checkout";
import { fetchMirror } from "./repo/mirror";
import { mergePr, type OpenPrInput, openPr } from "./repo/pr";
import { attachBinding, type NativeSession, NativeSessionAbsentError } from "./transport";
import {
  checkUpdates,
  systemUpdateTimer,
  type UpdateCheck,
  type UpdateTimer,
} from "./update/check";
import { type PrepareResult, prepareUpdate } from "./update/prepare";

const herdrConnectionErrorSchema = z.strictObject({
  event: z.literal("connection.error"),
  data: z.strictObject({ code: z.string(), message: z.string() }),
});

const paneUpdatedExitSchema = z.object({
  event: z.enum(["pane.updated", "pane_updated"]),
  data: z.object({
    pane: z.object({
      pane_id: z.string(),
      agent: z.string().nullish(),
      agent_session: z.unknown().optional(),
    }),
  }),
});
const paneExitedSchema = z.object({
  event: z.enum(["pane.exited", "pane_exited"]),
  data: z.object({ pane_id: z.string() }),
});
function hasLiveTui(pane: {
  readonly agent?: string | null | undefined;
  readonly sessionPath?: unknown;
}): boolean {
  return pane.agent === "omo" || pane.agent === "pi" || pane.sessionPath != null;
}

const paneAgentReleasedSchema = z.object({
  event: z.enum(["pane.agent_detected", "pane_agent_detected"]),
  data: z.object({ pane_id: z.string(), released: z.literal(true) }),
});
export function planPaneExited(event: unknown, paneId: string): boolean {
  const released = paneAgentReleasedSchema.safeParse(event);
  if (released.success) return released.data.data.pane_id === paneId;
  const exited = paneExitedSchema.safeParse(event);
  if (exited.success) return exited.data.data.pane_id === paneId;
  const updated = paneUpdatedExitSchema.safeParse(event);
  return (
    updated.success &&
    updated.data.data.pane.pane_id === paneId &&
    !hasLiveTui({
      agent: updated.data.data.pane.agent,
      sessionPath: updated.data.data.pane.agent_session,
    })
  );
}

export interface CreateSupervisorInput {
  readonly initiativeId: string;
  readonly scopeDigest: string;
  readonly designationId: string;
  readonly execute: boolean;
  readonly fixture: boolean;
}
const parentLocation = {
  projectId: z.string().min(1),
  repo: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
};
const createParentInputSchema = z.union([
  z.strictObject({ ...parentLocation, supervisorId: z.string().min(1) }),
  z.strictObject({
    ...parentLocation,
    scopeDigest: z.string().min(1),
    designationId: z.string().min(1),
    execute: z.boolean(),
    fixture: z.boolean(),
    noManager: z.boolean().optional(),
  }),
]);
export type CreateParentInput = z.infer<typeof createParentInputSchema>;
export const MANAGER_DESIGNATION_ID = "manager";
/** A launch claim older than this is presumed abandoned by a crashed owner. */
const LAUNCH_CLAIM_LEASE_MS = 120_000;
const managerSnapshot: ScopeSnapshot = {
  version: 1,
  source: "linear-export",
  initiative: null,
  projects: [],
  decisionRefs: [],
};
export type ManagerLinkReason =
  | "linked"
  | "opted_out"
  | "no_manager"
  | "manager_paused"
  | "manager_closed"
  | "manager_unavailable";
export interface ManageResult {
  /** `reattaching`: another `olw manage` call owns the in-flight reattachment. */
  readonly action: "created" | "focused" | "reattached" | "reattaching";
  readonly binding: Binding;
  readonly updateCheck: UpdateCheck;
  readonly routingAdvice: NonNullable<UpdateCheck["routingAdvice"]>;
  readonly modelSource: ManagerModelResolution["source"] | "existing";
}
export type ChildCreateMode = "direct" | "planned" | "research";
export interface CreateChildInput {
  readonly parentId: string;
  readonly issueId: string;
  readonly mode?: ChildCreateMode;
  readonly deliverable?: Deliverable | undefined;
}
export interface SendInput {
  readonly fromId: string;
  readonly toId: string;
  readonly messageId: string;
  readonly kind: "instruction" | "coordination";
  readonly text: string;
}
export interface StageCompleteInput {
  readonly fromId: string;
  readonly planPath: string;
  readonly head: string;
  readonly messageId: string;
  readonly text: string;
}
export interface StageStartInput {
  readonly fromId: string;
  readonly stage: "execute";
  readonly parentId: string;
  readonly messageId: string;
}
export interface ReportInput {
  readonly toUser?: boolean;
  readonly fromId: string;
  readonly messageId: string;
  readonly outcome: "completed" | "blocked" | "failed";
  readonly evidence: readonly string[];
  readonly text: string;
  readonly delivery?: Envelope["delivery"];
}
export interface AskInput {
  readonly toUser?: boolean;
  readonly fromId: string;
  readonly messageId: string;
  readonly text: string;
  readonly questions?: Envelope["question"] | undefined;
}
export interface AnswerInput {
  readonly fromId: string;
  readonly questionId: string;
  readonly text: string;
  readonly answers?: NonNullable<Envelope["answer"]>["answers"] | undefined;
  readonly unanswered?: readonly string[] | undefined;
}
export interface UserAnswerInput {
  readonly questionId: string;
  readonly text: string;
  readonly answers?: NonNullable<Envelope["answer"]>["answers"] | undefined;
  readonly unanswered?: readonly string[] | undefined;
}
export interface ListedQuestion {
  readonly record: DeliveryRecord;
  readonly answered: boolean;
  readonly answer: DeliveryRecord | null;
}
export type StatusBinding = Binding & {
  readonly mode?: ChildCreateMode;
  readonly stage?: ChildStage;
  readonly stageBindings?: ReadonlyArray<{
    readonly bindingId: string;
    readonly stage: ChildStage;
    readonly launchState: Binding["launchState"];
  }>;
  readonly openQuestions?: number;
};
export interface CreationResult {
  readonly binding: Binding;
  readonly expectedModel: RoleModel;
  readonly readiness: "ready" | "launching";
  readonly execution: "not_started" | "brief_accepted";
  readonly stage?: ChildStage;
  readonly mode?: ChildCreateMode;
  readonly managerLink?: {
    readonly bindingId: string | null;
    readonly reason: ManagerLinkReason;
  };
  readonly ancestry: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseCommit: string;
  } | null;
}
export interface OrchestratorDependencies {
  readonly openRegistry: (path: string, options?: { readonly readonly?: boolean }) => Registry;
  readonly createHerdrClient: (socket: string) => HerdrClient;
  readonly attachBinding: (binding: Binding) => Promise<NativeSession>;
  readonly terminateBinding: (binding: Binding) => Promise<void>;
  readonly resolveHerdrArtifact: (root: string) => Promise<{ readonly artifactDir: string }>;
  readonly ensureHost: (
    root: string,
    socket: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<void>;
  readonly checkHostProfile?: (
    root: string,
    socket: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<void>;
  readonly prompt: (binding: Binding, text: string) => Promise<void>;
  readonly gitTip: (repo: string, revision: string) => Promise<string>;
  /** Settings file read for the manager's default model; defaults to ~/.omo/agent/settings.json. */
  readonly managerSettingsPath?: string;
  readonly updateCheck?: () => Promise<UpdateCheck>;
  readonly updateTimer?: UpdateTimer;
  readonly now: () => string;
  readonly uuid: () => string;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function legacyParentCreationError(parent: Binding): Result<never> {
  return failure(
    "legacy_parent_unsupported",
    "Cannot create a child or successor for a legacy linked-worktree parent. Close or migrate the legacy parent with user approval, or keep using the retained patched OLW/Herdr stack for it per docs/operations.md#one-release-rollback.",
    {
      bindingId: parent.id,
      checkoutKind: parent.checkout?.kind ?? "legacy",
      rollback: "docs/operations.md#one-release-rollback",
    },
  );
}

function failure<T>(code: string, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

export function planPathForIssueKey(key: string | undefined): Result<string> {
  return key === undefined || !/^[A-Z][A-Z0-9]*-\d+$/.test(key)
    ? failure("invalid_input", "Planned children require a valid Linear issue key")
    : ok(`.omo/plans/${key}.md`);
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function managedHerdrPath(artifactDir: string): string {
  const inheritedPath = process.env["PATH"];
  if (!inheritedPath) return artifactDir;
  return `${artifactDir}${process.platform === "win32" ? ";" : ":"}${inheritedPath}`;
}
function launchEnvironment(
  root: string,
  managedPath: string,
): Readonly<Record<string, string | undefined>> {
  return { ...process.env, PATH: managedPath, ...runtimeCacheEnvironment(root) };
}

async function defaultEnsureHost(
  root: string,
  socket: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await ensureRouting(root);
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
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
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
  resolveHerdrArtifact,
  ensureHost: defaultEnsureHost,
  checkHostProfile: assertHostProtocol,
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
  #currentUpdateCheck: UpdateCheck | null = null;

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

  #approval(
    input: Omit<CreateSupervisorInput, "initiativeId">,
  ): Result<{ readonly designation: Designation; readonly snapshot: ScopeSnapshot }> {
    const scope = this.#withRegistry((registry) => registry.scope(input.scopeDigest));
    if (!scope.ok) return scope;
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
    return ok({ designation, snapshot: scope.value });
  }

  public async createSupervisor(input: CreateSupervisorInput): Promise<Result<CreationResult>> {
    const context = this.#approval(input);
    if (!context.ok) return context;
    if (context.value.snapshot.initiative?.id !== input.initiativeId)
      return failure("scope_violation", "Supervisor requires a designated initiative");
    return this.#create(
      { role: "supervisor", initiativeId: input.initiativeId },
      context.value.designation,
      context.value.snapshot,
      this.#root,
      null,
    );
  }

  public async createParent(inputValue: CreateParentInput): Promise<Result<CreationResult>> {
    const parsed = createParentInputSchema.safeParse(inputValue);
    if (!parsed.success)
      return failure(
        "invalid_arguments",
        "Choose supervisor approval or explicit standalone approval",
        parsed.error.issues,
      );
    const input = parsed.data;
    if (!("supervisorId" in input) && !input.execute)
      return failure("execute_denied", "Standalone parent creation requires --execute");
    if (input.repo !== undefined)
      return failure(
        "legacy_parent_unsupported",
        "Linked-worktree parent creation is unsupported. Use an approved scope repository mapping for an owned-clone parent, or keep using the retained patched OLW/Herdr stack per docs/operations.md#one-release-rollback.",
        { projectId: input.projectId, rollback: "docs/operations.md#one-release-rollback" },
      );
    let ownerId: string | null = null;
    let managerLink: CreationResult["managerLink"];
    let context: Result<{ readonly designation: Designation; readonly snapshot: ScopeSnapshot }>;
    if ("supervisorId" in input) {
      const owner = this.#binding(input.supervisorId);
      if (!owner.ok) return owner;
      if (owner.value.assignment.role !== "supervisor")
        return failure("owner_mismatch", "Parent manager must be a supervisor");
      if (owner.value.launchState !== "ready" || owner.value.contactState !== "active")
        return failure("owner_unavailable", "Supervisor is not available for role creation");
      ownerId = owner.value.id;
      context = await this.#context(owner.value);
    } else {
      context = this.#approval(input);
      const link = this.#managerLink(input.noManager === true);
      if (!link.ok) return link;
      managerLink = link.value;
      ownerId = link.value.bindingId;
    }
    if (!context.ok) return context;
    const project = context.value.snapshot.projects.find(
      (entry) => entry.project.id === input.projectId,
    );
    if (project === undefined)
      return failure("scope_violation", "Project is outside the approved snapshot");
    if (project.repository === undefined)
      return failure(
        "invalid_arguments",
        "Parent creation requires an approved scope repository mapping",
      );
    const bindingId = this.#deps.uuid();
    const branch = `omo/${context.value.designation.id}/projects/${input.projectId}-${bindingId}`;
    const repository = project.repository;
    const mirror = await fetchMirror(this.#root, repository.remote);
    const base = input.base ?? repository.base ?? `refs/heads/${repository.defaultBranch}`;
    const revision = base.startsWith("origin/") ? `refs/heads/${base.slice(7)}` : base;
    const baseCommit = await checkoutGit(mirror.path, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]);
    const path = ownedCheckoutPath(
      this.#root,
      repository.remote,
      project.project.key ?? project.project.id,
      bindingId,
    );
    const checkout: Checkout = {
      kind: "owned-clone",
      remote: repository.remote,
      receiptPath: join(this.#root, ".omo/state/checkouts", `${bindingId}.json`),
      originalRepoRoot: path,
      path,
      branch,
      baseBranch: input.base ?? repository.base ?? `origin/${repository.defaultBranch}`,
      baseCommit,
    };
    const assignment: Assignment = {
      role: "parent",
      initiativeId: context.value.snapshot.initiative?.id ?? null,
      projectId: input.projectId,
      ownerBindingId: ownerId,
    };
    const created = await this.#create(
      assignment,
      context.value.designation,
      context.value.snapshot,
      checkout.path,
      checkout,
      { bindingId },
    );
    return created.ok && managerLink !== undefined
      ? ok({ ...created.value, managerLink })
      : created;
  }

  /** The one live manager, or the reason a standalone parent stays unlinked. */
  #managerLink(optedOut: boolean): Result<NonNullable<CreationResult["managerLink"]>> {
    if (optedOut) return ok({ bindingId: null, reason: "opted_out" });
    const listed = this.#withRegistry((registry) => registry.list());
    if (!listed.ok) return listed;
    const managers = listed.value.filter((binding) => binding.assignment.role === "manager");
    const live = managers.find((binding) => binding.launchState !== "closed");
    if (live === undefined)
      return ok({ bindingId: null, reason: managers.length > 0 ? "manager_closed" : "no_manager" });
    if (live.launchState !== "ready") return ok({ bindingId: null, reason: "manager_unavailable" });
    if (live.contactState !== "active") return ok({ bindingId: null, reason: "manager_paused" });
    return ok({ bindingId: live.id, reason: "linked" });
  }

  /** Prepare a dev pull request for the versions in the latest update check. */
  public async updatePrepare(
    options: { readonly remote?: string } = {},
  ): Promise<Result<PrepareResult>> {
    return prepareUpdate(this.#root, options);
  }

  /** Open, focus or reattach the single management session; never adopts a non-host session. */
  public async updateCheck(
    tags: Partial<Record<"omo-ai" | "@code-yeongyu/senpi", string>> = {},
  ): Promise<Result<UpdateCheck>> {
    try {
      const home = process.env["HOME"] ?? "";
      return ok(
        await checkUpdates(this.#root, {
          tags,
          routing: {
            upstream: globalOmo(),
            configPath: join(home, ".omo/omo.jsonc"),
            stateDir: join(home, ".omo/proxy-routing"),
            catalogPath: join(home, ".omo/agent/models.json"),
            managerSettingsPath: join(home, ".omo/agent/settings.json"),
            adopt: false,
            check: true,
            force: true,
          },
        }),
      );
    } catch (cause) {
      return ok({
        checkedAt: this.#deps.now(),
        state: "unavailable",
        packages: {
          "omo-ai": {
            state: "unknown",
            pinned: "unknown",
            available: null,
            tag: tags["omo-ai"] ?? "beta",
          },
          "@code-yeongyu/senpi": {
            state: "unknown",
            pinned: "unknown",
            available: null,
            tag: tags["@code-yeongyu/senpi"] ?? "latest",
          },
        },
        globalOmo: null,
        routingAdvice: { count: 0, line: "none", routes: [], catalog: [] },
        reason: messageOf(cause),
      });
    }
  }

  public async manage(): Promise<Result<ManageResult>> {
    let managerModel: ManagerModelResolution;
    try {
      managerModel = resolveManagerModel(
        this.#deps.managerSettingsPath ?? join(homedir(), ".omo/agent/settings.json"),
      );
    } catch (cause) {
      if (cause instanceof ManagerSettingsError)
        return failure(cause.code, cause.message, { settingsPath: cause.settingsPath });
      throw cause;
    }
    const updateCheck = await this.#runUpdateCheck();
    this.#currentUpdateCheck = updateCheck;
    const listed = this.#withRegistry((registry) => registry.list());
    if (!listed.ok) return listed;
    const existing = listed.value.find(
      (binding) => binding.assignment.role === "manager" && binding.launchState !== "closed",
    );
    if (existing !== undefined) return this.#reopenManager(existing, updateCheck);
    const scope = this.#withRegistry((registry) => registry.importScope(managerSnapshot));
    if (!scope.ok) return scope;
    const previous = this.#withRegistry((registry) => registry.designation(MANAGER_DESIGNATION_ID));
    if (!previous.ok && previous.error.code !== "not_found") return previous;
    if (previous.ok && previous.value.snapshotDigest !== scope.value.digest)
      return failure("designation_conflict", "Existing manager designation has a different scope");
    const designation: Designation = previous.ok
      ? previous.value
      : {
          id: MANAGER_DESIGNATION_ID,
          snapshotDigest: scope.value.digest,
          designatedBy: process.env["USER"] ?? "local-user",
          designatedAt: this.#deps.now(),
          execute: true,
          create: true,
          contact: true,
        };
    const created = await this.#create(
      { role: "manager" },
      designation,
      managerSnapshot,
      this.#root,
      null,
      { managerModel },
    );
    return created.ok
      ? ok({
          action: "created",
          binding: created.value.binding,
          updateCheck,
          routingAdvice: updateCheck.routingAdvice ?? {
            count: 0,
            line: "none",
            routes: [],
            catalog: [],
          },
          modelSource: managerModel.source,
        })
      : created;
  }

  #managerRoutingLine(): string {
    if (!this.#currentUpdateCheck) return "unavailable; run olw update check";
    return this.#currentUpdateCheck.routingAdvice?.line ?? "none";
  }

  #managerUpdateLine(): string {
    const check = this.#currentUpdateCheck;
    if (!check) return "unavailable; run olw update check";
    const versions = Object.entries(check.packages)
      .map(
        ([name, item]) =>
          `${name} pinned ${item.pinned}, ${item.tag} ${item.available ?? item.state}`,
      )
      .join("; ");
    return `${versions}; ${Object.values(check.packages).some((item) => item.state === "update_available") ? "run olw update prepare to prepare an update PR" : "run olw update check to refresh"}`;
  }

  async #runUpdateCheck(): Promise<UpdateCheck> {
    const timer = this.#deps.updateTimer ?? systemUpdateTimer;
    const startedAt = timer.now();
    const deadline = startedAt + 20_000;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadlineController = new AbortController();
    const makeUnknown = (reason: string): UpdateCheck => ({
      checkedAt: this.#deps.now(),
      state: "unknown",
      packages: {
        "omo-ai": { state: "unknown", pinned: "unknown", available: null, tag: "beta", reason },
        "@code-yeongyu/senpi": {
          state: "unknown",
          pinned: "unknown",
          available: null,
          tag: "latest",
          reason,
        },
      },
      globalOmo: null,
      routingAdvice: { count: 0, line: "none", routes: [], catalog: [] },
      reason,
    });
    try {
      const result = await Promise.race([
        (
          this.#deps.updateCheck ??
          (() =>
            checkUpdates(this.#root, {
              timer,
              signal: deadlineController.signal,
              routing: {
                upstream: globalOmo(),
                configPath: join(process.env["HOME"] ?? "", ".omo/omo.jsonc"),
                stateDir: join(process.env["HOME"] ?? "", ".omo/proxy-routing"),
                catalogPath: join(process.env["HOME"] ?? "", ".omo/agent/models.json"),
                managerSettingsPath: join(process.env["HOME"] ?? "", ".omo/agent/settings.json"),
                adopt: false,
                check: true,
                force: true,
              },
            }))
        )(),
        new Promise<UpdateCheck>((resolve) => {
          deadlineTimer = timer.setTimeout(
            () => {
              timedOut = true;
              deadlineController.abort();
              resolve(makeUnknown("Update check timed out"));
            },
            Math.max(0, deadline - timer.now()),
          );
        }),
      ]);
      return timedOut || timer.now() >= deadline ? makeUnknown("Update check timed out") : result;
    } catch (cause) {
      return {
        checkedAt: this.#deps.now(),
        state: "unavailable",
        packages: {
          "omo-ai": { state: "unknown", pinned: "unknown", available: null, tag: "beta" },
          "@code-yeongyu/senpi": {
            state: "unknown",
            pinned: "unknown",
            available: null,
            tag: "latest",
          },
        },
        globalOmo: null,
        routingAdvice: { count: 0, line: "none", routes: [], catalog: [] },
        reason: messageOf(cause),
      };
    } finally {
      if (deadlineTimer !== undefined) timer.clearTimeout(deadlineTimer);
      deadlineController.abort();
    }
  }

  async #reopenManager(binding: Binding, updateCheck: UpdateCheck): Promise<Result<ManageResult>> {
    const closeInstruction = `run olw close --binding ${binding.id} first`;
    if (binding.launchState === "uncertain")
      return failure(
        "manager_uncertain",
        `The recorded manager is uncertain; inspect it, then ${closeInstruction}`,
        { bindingId: binding.id },
      );
    if (
      binding.launchState !== "ready" ||
      binding.workspaceId === null ||
      binding.sessionPath === null
    )
      return failure(
        "manager_unavailable",
        `The recorded manager is ${binding.launchState}; ${closeInstruction}`,
        { bindingId: binding.id },
      );
    const host = await this.#checkHostProtocol(binding);
    if (host !== undefined) return host;
    const workspaceId = binding.workspaceId;
    const herdr = this.#deps.createHerdrClient(binding.herdrSocket);
    let token: string | undefined;
    try {
      const snapshot = await herdr.snapshot();
      const workspace = snapshot.workspaces.find(
        (candidate) => candidate.workspaceId === workspaceId,
      );
      if (workspace === undefined || workspace.cwd !== binding.cwd)
        return failure(
          "manager_unavailable",
          `The manager workspace is gone or changed; ${closeInstruction}`,
          { bindingId: binding.id, workspaceId },
        );
      // Official Herdr receives `pi` from Senpi's built-in reporter; older servers use `omo`.
      const recordedPane = snapshot.panes.find(
        (pane) => pane.paneId === binding.paneId && pane.workspaceId === workspaceId,
      );
      const tuiRunning = recordedPane !== undefined && hasLiveTui(recordedPane);
      const pending = this.#withRegistry((registry) => registry.reattachPending(binding.id));
      if (!pending.ok) return pending;
      if (tuiRunning && !pending.value) {
        await herdr.focusWorkspace(workspaceId);
        return ok({
          action: "focused",
          binding,
          updateCheck,
          routingAdvice: updateCheck.routingAdvice ?? {
            count: 0,
            line: "none",
            routes: [],
            catalog: [],
          },
          modelSource: "existing",
        });
      }
      const now = this.#deps.now();
      const claim = this.#withRegistry((registry) =>
        registry.beginReattach(
          binding.id,
          binding.paneId,
          now,
          new Date(Date.parse(now) - LAUNCH_CLAIM_LEASE_MS).toISOString(),
        ),
      );
      if (!claim.ok) return claim;
      if (!claim.value.claimed) {
        await herdr.focusWorkspace(workspaceId);
        return ok({
          action: "reattaching",
          binding: claim.value.binding,
          updateCheck,
          routingAdvice: updateCheck.routingAdvice ?? {
            count: 0,
            line: "none",
            routes: [],
            catalog: [],
          },
          modelSource: "existing",
        });
      }
      const owner = claim.value.token;
      token = owner;
      // Every Herdr side effect and the final clear re-check the token, so a caller whose lease
      // expired while it was suspended can neither launch a second TUI nor clear the new owner.
      const leaseLost = () =>
        failure<never>(
          "runtime_unavailable",
          "Another olw manage call took over this manager reattachment; nothing was launched",
          { reason: "lease_lost", bindingId: binding.id },
        );
      const stillOwner = (): Result<boolean> =>
        this.#withRegistry((registry) => registry.ownsReattach(binding.id, owner));
      const finish = (): Result<boolean> =>
        this.#withRegistry((registry) => registry.finishReattach(binding.id, owner));
      if (tuiRunning) {
        // An interrupted attempt's TUI did come up in the recorded pane; adopt it, launch nothing.
        const verified = await this.#verifyManagerSession(binding);
        if (!verified.ok) return verified;
        const finished = finish();
        if (!finished.ok) return finished;
        token = undefined;
        if (!finished.value) return leaseLost();
        await herdr.focusWorkspace(workspaceId);
        return ok({
          action: "focused",
          binding,
          updateCheck,
          routingAdvice: updateCheck.routingAdvice ?? {
            count: 0,
            line: "none",
            routes: [],
            catalog: [],
          },
          modelSource: "existing",
        });
      }
      const artifact = await this.#deps.resolveHerdrArtifact(this.#root);
      const managedPath = managedHerdrPath(artifact.artifactDir);
      const beforeTab = stillOwner();
      if (!beforeTab.ok) return beforeTab;
      if (!beforeTab.value) return leaseLost();
      // A pending attempt's pane that is still a plain shell is reused instead of adding a tab.
      const paneId =
        pending.value && recordedPane !== undefined && recordedPane.agent === undefined
          ? recordedPane.paneId
          : (await herdr.createTab(workspaceId, binding.cwd, "manager")).rootPaneId;
      // The TUI publishes readiness for the binding's recorded pane, so record it before launch;
      // the pending claim keeps later calls from reporting this pane as focused until verified.
      const moved = this.#withRegistry((registry) =>
        registry.recordReattachPane(binding.id, owner, paneId),
      );
      if (!moved.ok) return moved.error.code === "lease_lost" ? leaseLost() : moved;
      await removeReadiness(this.#root, binding.id);
      const readiness = await subscribeReadiness(this.#root, moved.value);
      try {
        const beforeRun = stillOwner();
        if (!beforeRun.ok) return beforeRun;
        if (!beforeRun.value) return leaseLost();
        await herdr.run(
          paneId,
          this.#tuiArgv(moved.value, binding.sessionPath, "manager", null),
          this.#tuiEnvironment(managedPath),
        );
        const expired = Promise.withResolvers<never>();
        const timeout = setTimeout(
          () => expired.reject(new Error("Timed out awaiting manager TUI readiness")),
          15_000,
        );
        timeout.unref();
        let receipt: Readiness;
        try {
          receipt = await Promise.race([readiness.promise, expired.promise]);
        } finally {
          clearTimeout(timeout);
        }
        if (receipt.sessionPath !== binding.sessionPath)
          throw new Error("Reattached TUI opened a different session");
      } finally {
        readiness.close();
      }
      const verified = await this.#verifyManagerSession(moved.value);
      if (!verified.ok) return verified;
      const finished = finish();
      if (!finished.ok) return finished;
      token = undefined;
      if (!finished.value) return leaseLost();
      await herdr.focusWorkspace(workspaceId);
      return ok({
        action: "reattached",
        binding: moved.value,
        updateCheck,
        routingAdvice: updateCheck.routingAdvice ?? {
          count: 0,
          line: "none",
          routes: [],
          catalog: [],
        },
        modelSource: "existing",
      });
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Manager workspace could not be focused or reattached",
        messageOf(cause),
      );
    } finally {
      const owner = token;
      if (owner !== undefined)
        this.#withRegistry((registry) => registry.releaseReattach(binding.id, owner));
      herdr.close();
    }
  }

  async #verifyManagerSession(binding: Binding): Promise<Result<true>> {
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(binding);
      const identity = await session.describe();
      if (!identity.ok) return identity;
      return matchesRuntime(binding, identity.value)
        ? ok(true)
        : failure("identity_mismatch", "Manager TUI does not match the recorded native session");
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Could not verify the manager's native session",
        messageOf(cause),
      );
    } finally {
      await session?.close();
    }
  }

  #tuiEnvironment(managedPath: string): Readonly<Record<string, string>> {
    return { PATH: managedPath, ...runtimeCacheEnvironment(this.#root) };
  }

  #tuiArgv(
    binding: Pick<Binding, "id" | "assignment">,
    sessionPath: string,
    label: string,
    model: RoleModel | null,
  ): string[] {
    const manager = binding.assignment.role === "manager";
    return [
      "env",
      "-u",
      "OMO_INITIATIVE_HOST",
      `OMO_ENABLE_SHARED_HOST=1`,
      `OMO_RPC_SOCKET=${this.#omoSocket}`,
      `OMO_INITIATIVE_ROOT=${this.#root}`,
      ...(manager ? [`OLW_MANAGER_BINDING=${binding.id}`] : []),
      join(this.#root, "node_modules/.bin/omo"),
      "-e",
      join(this.#root, "dist/extension/index.js"),
      "-e",
      join(this.#root, "dist/extension/model-catalog.js"),
      "--session",
      sessionPath,
      "--name",
      label,
      ...(model === null
        ? []
        : ["--model", `${model.provider}/${model.modelId}`, "--thinking", model.thinking]),
      ...(manager || model === null ? [] : ["--no-model-fallback", "--no-recommended-models"]),
    ];
  }

  public async createChild(input: CreateChildInput): Promise<Result<CreationResult>> {
    const owner = this.#binding(input.parentId);
    if (!owner.ok) return owner;
    if (owner.value.assignment.role !== "parent" || owner.value.checkout === null)
      return failure("owner_mismatch", "Child owner must be a parent worktree");
    if (owner.value.checkout.kind !== "owned-clone") return legacyParentCreationError(owner.value);
    if (owner.value.launchState !== "ready" || owner.value.contactState !== "active")
      return failure("owner_unavailable", "Parent is not available for role creation");
    const parentAssignment = owner.value.assignment;
    const context = await this.#context(owner.value);
    if (!context.ok) return context;
    const herdr = this.#deps.createHerdrClient(this.#herdrSocket);
    try {
      const parentWorkspace = (await herdr.snapshot()).workspaces.find(
        (workspace) => workspace.workspaceId === owner.value.workspaceId,
      );
      if (parentWorkspace === undefined || parentWorkspace.cwd !== owner.value.cwd)
        return failure("owner_unavailable", "Parent workspace identity does not match its binding");
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Parent workspace could not be observed",
        messageOf(cause),
      );
    } finally {
      herdr.close();
    }
    const baseCommit = await this.#deps.gitTip(
      owner.value.checkout.originalRepoRoot,
      owner.value.checkout.branch,
    );
    const bindingId = this.#deps.uuid();
    const checkout: Checkout = {
      kind: "linked-worktree",
      remote: owner.value.checkout.remote,
      receiptPath: join(this.#root, ".omo/state/checkouts", `${bindingId}.json`),
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
    const mode = input.mode ?? "direct";
    let planPath: string | undefined;
    if (mode === "planned") {
      const issue = context.value.snapshot.projects
        .find((entry) => entry.project.id === parentAssignment.projectId)
        ?.issues.find((entry) => entry.id === input.issueId);
      if (issue === undefined)
        return failure(
          "invalid_input",
          "Planned child issue is outside the approved project snapshot",
        );
      const resolved = planPathForIssueKey(issue.key);
      if (!resolved.ok) return resolved;
      planPath = resolved.value;
    }
    const stage: ChildStage =
      mode === "planned" ? "plan" : mode === "research" ? "research" : "direct";
    return this.#create(
      assignment,
      context.value.designation,
      context.value.snapshot,
      checkout.path,
      checkout,
      {
        bindingId,
        stage,
        mode,
        ...(planPath === undefined ? {} : { planPath }),
        deliverable: input.deliverable ?? (mode === "research" ? "report" : "pr"),
      },
    );
  }

  public async stageComplete(input: StageCompleteInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    const stage = this.#withRegistry((registry) => registry.stageOf(input.fromId));
    if (!stage.ok) return stage;
    if (stage.value?.stage !== "plan" || sender.value.checkout === null)
      return failure("handoff_not_allowed", "A plan child must complete its stage");
    const host = await this.#checkHostProtocol(sender.value);
    if (host !== undefined) return host;
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(sender.value);
      const identity = await session.describe();
      if (!identity.ok) return identity;
      if (!matchesRuntime(sender.value, identity.value))
        return failure("identity_mismatch", "Plan sender does not match the bound runtime");
      if (!isAbsolute(input.planPath))
        return failure("invalid_arguments", "Plan path must be absolute");
      const [directory, path] = await Promise.all([
        realpath(sender.value.checkout.path),
        realpath(input.planPath),
      ]);
      const inside = relative(directory, path);
      if (inside === "" || inside === ".." || inside.startsWith("../") || isAbsolute(inside))
        return failure("invalid_arguments", "Plan file must be inside the child worktree");
      const contents = await readFile(path);
      const head = await this.#deps.gitTip(directory, "HEAD");
      if (head !== input.head)
        return failure("head_mismatch", "Plan worktree HEAD differs from the supplied head");
      const planSha256 = createHash("sha256").update(contents).digest("hex");
      const handoff = stage.value.handoff;
      const recorded = this.#withRegistry((registry) =>
        registry.recordHandoff(sender.value.id, {
          planPath: path,
          planSha256,
          head,
          completedAt:
            handoff?.planPath === path && handoff.planSha256 === planSha256 && handoff.head === head
              ? handoff.completedAt
              : this.#deps.now(),
          completionReportId: input.messageId,
        }),
      );
      if (!recorded.ok) return recorded;
    } catch (cause) {
      return failure("runtime_unavailable", "Could not verify plan handoff", messageOf(cause));
    } finally {
      await session?.close();
    }
    return this.report({
      fromId: input.fromId,
      messageId: input.messageId,
      outcome: "completed",
      evidence: [input.planPath],
      text: input.text,
    });
  }

  public async stageStart(input: StageStartInput): Promise<Result<CreationResult>> {
    if (input.stage !== "execute") return failure("invalid_stage", "Only execute can follow plan");
    const plan = this.#binding(input.fromId);
    if (!plan.ok) return plan;
    if (plan.value.assignment.role !== "child" || plan.value.checkout === null)
      return failure("invalid_stage", "Stage start requires a planned child");
    const stage = this.#withRegistry((registry) => registry.stageOf(plan.value.id));
    if (!stage.ok) return stage;
    if (stage.value?.stage !== "plan") return failure("invalid_stage", "Not a plan stage");
    if (input.parentId !== plan.value.assignment.ownerBindingId)
      return failure("owner_mismatch", "Named parent does not own the plan child");
    const owner = this.#binding(input.parentId);
    if (!owner.ok) return owner;
    if (owner.value.assignment.role !== "parent" || owner.value.launchState !== "ready")
      return failure("owner_mismatch", "Named parent is not ready");
    if (owner.value.checkout?.kind !== "owned-clone") return legacyParentCreationError(owner.value);
    const host = await this.#checkHostProtocol(owner.value);
    if (host !== undefined) return host;
    const planHost = await this.#checkHostProtocol(plan.value);
    if (planHost !== undefined) return planHost;
    const ownerContext = await this.#context(owner.value);
    if (!ownerContext.ok) return ownerContext;
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(owner.value);
      const identity = await session.describe();
      if (!identity.ok) return identity;
      if (!matchesRuntime(owner.value, identity.value))
        return failure("identity_mismatch", "Stage sender is not the bound parent runtime");
    } catch (cause) {
      return failure("runtime_unavailable", "Could not verify stage owner", messageOf(cause));
    } finally {
      await session?.close();
    }
    const handoff = stage.value.handoff;
    if (handoff === null) return failure("handoff_missing", "Plan has no handoff");
    const chain = this.#withRegistry((registry) => registry.lineageFor(plan.value.id));
    if (!chain.ok) return chain;
    const next = chain.value.stages.find((entry) => entry.ordinal === 1);
    if (next !== undefined) {
      const successor = this.#binding(next.bindingId);
      if (!successor.ok) return successor;
      const context = await this.#context(plan.value);
      if (!context.ok) return context;
      return this.#resumeSuccessor(successor.value, context.value.snapshot, handoff);
    }
    if (handoff.completionReportId !== undefined) {
      const report = this.#withRegistry((registry) =>
        registry.delivery(handoff.completionReportId ?? ""),
      );
      if (
        !report.ok ||
        report.value.state !== "accepted" ||
        report.value.envelope.fromBindingId !== plan.value.id ||
        report.value.envelope.outcome !== "completed" ||
        !report.value.envelope.evidence.includes(handoff.planPath)
      )
        return failure(
          "plan_report_not_accepted",
          "Plan completion report has not been natively accepted",
        );
    }
    const checkout = plan.value.checkout;
    let head: string;
    try {
      if (handoff.completionReportId !== undefined) {
        const [checkoutPath, planPath] = await Promise.all([
          realpath(checkout.path),
          realpath(handoff.planPath),
        ]);
        const inside = relative(checkoutPath, planPath);
        if (inside === "" || inside === ".." || inside.startsWith("../") || isAbsolute(inside))
          return failure("plan_changed", "Plan path no longer resolves inside the child worktree");
        const digest = createHash("sha256")
          .update(await readFile(planPath))
          .digest("hex");
        if (digest !== handoff.planSha256)
          return failure("plan_changed", "Plan file changed since the accepted handoff");
      }
      head = await this.#deps.gitTip(checkout.path, "HEAD");
    } catch (cause) {
      return failure("plan_changed", "Could not verify the handed-off plan file", messageOf(cause));
    }
    if (head !== handoff.head)
      return failure("head_mismatch", "Worktree HEAD changed since plan handoff");
    if (plan.value.paneId === null || plan.value.workspaceId === null)
      return failure("runtime_unavailable", "Plan has no Herdr pane or workspace");
    const context = await this.#context(plan.value);
    if (!context.ok) return context;
    const herdr = this.#deps.createHerdrClient(plan.value.herdrSocket);
    try {
      const snapshot = await herdr.snapshot();
      const pane = snapshot.panes.find(
        (item) => item.paneId === plan.value.paneId && item.workspaceId === plan.value.workspaceId,
      );
      if (
        !snapshot.workspaces.some(
          (item) => item.workspaceId === plan.value.workspaceId && item.cwd === checkout.path,
        ) ||
        pane === undefined
      )
        return failure("runtime_unavailable", "Plan workspace or pane is missing");
      // The retained native engine may still be open after its TUI has exited.
      // Only the pane attachment determines whether another /quit is needed.
      if (hasLiveTui(pane)) {
        const native = await this.#deps.attachBinding(plan.value);
        try {
          const identity = await native.describe();
          if (!identity.ok) return identity;
          if (!matchesRuntime(plan.value, identity.value))
            return failure("identity_mismatch", "Plan runtime identity changed");
        } finally {
          await native.close();
        }
        const stopped = await this.#stopStageSession(plan.value, herdr);
        if (!stopped.ok) return stopped;
      } else {
        await this.#deps.terminateBinding(plan.value);
      }
    } catch (cause) {
      return failure("runtime_unavailable", "Plan session could not be stopped", messageOf(cause));
    } finally {
      herdr.close();
    }
    return this.#create(
      plan.value.assignment,
      context.value.designation,
      context.value.snapshot,
      checkout.path,
      checkout,
      {
        bindingId: this.#deps.uuid(),
        stage: "execute",
        mode: "planned",
        deliverable: plan.value.deliverable,
        successor: {
          previousId: plan.value.id,
          workspaceId: plan.value.workspaceId,
          head: handoff.head,
          planPath: handoff.planPath,
        },
      },
    );
  }

  async #resumeSuccessor(
    binding: Binding,
    snapshot: ScopeSnapshot,
    handoff: StageHandoff,
  ): Promise<Result<CreationResult>> {
    if (binding.checkout === null)
      return failure("runtime_unavailable", "Successor checkout is missing");
    const herdr = this.#deps.createHerdrClient(binding.herdrSocket);
    try {
      const state = await herdr.snapshot();
      if (
        binding.workspaceId !== null &&
        !state.workspaces.some(
          (workspace) =>
            workspace.workspaceId === binding.workspaceId && workspace.cwd === binding.cwd,
        )
      )
        return failure("runtime_unavailable", "Successor workspace is missing");
      if (binding.paneId !== null) {
        const pane = state.panes.find(
          (item) => item.paneId === binding.paneId && item.workspaceId === binding.workspaceId,
        );
        if (pane === undefined) return failure("runtime_unavailable", "Successor pane is missing");
        const observedIntent = this.#withRegistry((registry) =>
          registry.successorLaunchIntent(binding.id),
        );
        if (!observedIntent.ok) return observedIntent;
        let session: NativeSession | undefined;
        let sessionAbsent = false;
        try {
          session = await this.#deps.attachBinding(binding);
          if (binding.launchState !== "ready") await session.configure(modelForBinding(binding));
          const identity = await session.describe();
          if (!identity.ok) return identity;
          if (binding.launchState === "ready" && !matchesRuntime(binding, identity.value))
            return failure("identity_mismatch", "Execute runtime identity changed");
        } catch (cause) {
          if (!(cause instanceof NativeSessionAbsentError))
            return failure(
              "runtime_unavailable",
              "Could not inspect execute session",
              messageOf(cause),
            );
          sessionAbsent = true;
        } finally {
          await session?.close();
        }
        if (!sessionAbsent) {
          if (binding.launchState === "ready" && binding.initialization.state === "accepted")
            return ok(this.#creationResult(binding));
          const identitySession = await this.#deps.attachBinding(binding);
          let identity: Result<import("./core/contracts").RuntimeIdentity>;
          try {
            identity = await identitySession.describe();
          } finally {
            await identitySession.close();
          }
          if (!identity.ok) return identity;
          if (
            observedIntent.value !== null &&
            (observedIntent.value.state === "claimed" ||
              observedIntent.value.state === "dispatching")
          ) {
            const currentIntent = this.#withRegistry((registry) =>
              registry.successorLaunchIntent(binding.id),
            );
            if (!currentIntent.ok) return currentIntent;
            if (
              currentIntent.value?.attemptId !== observedIntent.value.attemptId ||
              currentIntent.value.state !== observedIntent.value.state
            )
              return failure("lease_lost", "Execute recovery attempt changed during observation");
            return ok({
              ...this.#creationResult(binding),
              readiness: "launching",
              execution: "not_started",
            });
          }
          if (observedIntent.value === null || observedIntent.value.state !== "uncertain")
            return failure("invalid_transition", "Execute recovery is not reconcilable");
          const recovered = this.#withRegistry((registry) =>
            registry.reconcileSuccessorLaunch(
              binding.id,
              observedIntent.value?.attemptId ?? "",
              "uncertain",
              identity.value,
            ),
          );
          if (!recovered.ok) return recovered;
          const initialized = await this.#initialize(recovered.value, snapshot);
          if (!initialized.ok) return initialized;
          const finished = this.#withRegistry((registry) =>
            registry.finishSuccessorLaunch(
              binding.id,
              observedIntent.value?.attemptId ?? "",
              "ready",
            ),
          );
          return finished.ok ? ok(this.#creationResult(finished.value)) : finished;
        }
        if (hasLiveTui(pane))
          return failure(
            "runtime_unavailable",
            "Execute pane still has a live TUI but its native session could not be found",
          );
      }
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Could not inspect execute workspace",
        messageOf(cause),
      );
    } finally {
      herdr.close();
    }
    const now = this.#deps.now();
    const claim = this.#withRegistry((registry) =>
      registry.beginSuccessorLaunch(
        binding.id,
        binding.paneId,
        now,
        new Date(Date.parse(now) - LAUNCH_CLAIM_LEASE_MS).toISOString(),
      ),
    );
    if (!claim.ok) return claim;
    if (!claim.value.claimed) {
      if (claim.value.state === "uncertain")
        return failure(
          "recovery_uncertain",
          "Execute launch was dispatched but its outcome is uncertain; inspect before retrying",
          { bindingId: binding.id },
        );
      return ok({
        ...this.#creationResult(claim.value.binding),
        readiness: "launching",
        execution: "not_started",
      });
    }
    return this.#launchSuccessor(claim.value.binding, snapshot, handoff, claim.value.token);
  }

  async #launchSuccessor(
    binding: Binding,
    snapshot: ScopeSnapshot,
    handoff: StageHandoff,
    owner: string,
  ): Promise<Result<CreationResult>> {
    const result = await this.#runSuccessorLaunch(binding, snapshot, handoff, owner);
    if (!result.ok) {
      const settled = this.#withRegistry((registry) =>
        registry.failSuccessorLaunch(binding.id, owner),
      );
      if (
        !settled.ok &&
        settled.error.code !== "lease_lost" &&
        settled.error.code !== "invalid_transition"
      )
        return settled;
    }
    return result;
  }

  async #runSuccessorLaunch(
    binding: Binding,
    snapshot: ScopeSnapshot,
    handoff: StageHandoff,
    owner: string,
  ): Promise<Result<CreationResult>> {
    const checkout = binding.checkout;
    if (checkout === null) return failure("invalid_stage", "Successor has no checkout");
    const stillOwner = (): Result<boolean> =>
      this.#withRegistry((registry) => registry.ownsSuccessorLaunch(binding.id, owner));
    const leaseLost = () =>
      failure<never>(
        "runtime_unavailable",
        "Another stage start call took over execute recovery; nothing was launched",
        { reason: "lease_lost", bindingId: binding.id },
      );
    let dispatched = false;
    let managedPath: string;
    try {
      const ownership = stillOwner();
      if (!ownership.ok) return ownership;
      if (!ownership.value) return leaseLost();
      if (binding.paneId !== null) {
        const observer = this.#deps.createHerdrClient(binding.herdrSocket);
        let native: NativeSession | undefined;
        try {
          const herdrSnapshot = await observer.snapshot();
          const pane = herdrSnapshot.panes.find(
            (candidate) =>
              candidate.paneId === binding.paneId && candidate.workspaceId === binding.workspaceId,
          );
          if (pane === undefined)
            return failure("runtime_unavailable", "Successor pane is missing");
          try {
            native = await this.#deps.attachBinding(binding);
            await native.configure(modelForBinding(binding));
            const identity = await native.describe();
            if (!identity.ok) return identity;
            const recovered = this.#withRegistry((registry) =>
              registry.reconcileSuccessorLaunch(binding.id, owner, "claimed", identity.value),
            );
            if (!recovered.ok) return recovered;
            const initialized = await this.#initialize(recovered.value, snapshot);
            if (!initialized.ok) {
              const settled = this.#withRegistry((registry) =>
                registry.finishSuccessorLaunch(binding.id, owner, "uncertain"),
              );
              if (!settled.ok && settled.error.code !== "lease_lost") return settled;
              return initialized;
            }
            const finished = this.#withRegistry((registry) =>
              registry.finishSuccessorLaunch(binding.id, owner, "ready"),
            );
            return finished.ok ? ok(this.#creationResult(finished.value)) : finished;
          } catch (cause) {
            if (!(cause instanceof NativeSessionAbsentError))
              return failure(
                "runtime_unavailable",
                "Could not inspect execute session under launch ownership",
                messageOf(cause),
              );
          } finally {
            await native?.close();
          }
          if (hasLiveTui(pane))
            return failure(
              "recovery_uncertain",
              "Execute pane has a live TUI without an observable native session",
              { bindingId: binding.id },
            );
        } finally {
          observer.close();
        }
      }
      const artifact = await this.#deps.resolveHerdrArtifact(this.#root);
      managedPath = managedHerdrPath(artifact.artifactDir);
      await this.#deps.checkHostProfile?.(
        this.#root,
        binding.omoSocket,
        launchEnvironment(this.#root, managedPath),
      );
      await this.#deps.ensureHost(
        this.#root,
        binding.omoSocket,
        launchEnvironment(this.#root, managedPath),
      );
      if ((await this.#deps.gitTip(checkout.path, "HEAD")) !== handoff.head)
        return failure("head_mismatch", "Worktree HEAD changed since plan handoff");
    } catch (cause) {
      if (cause instanceof HostProfileMismatchError)
        return failure("runtime_unavailable", cause.message, {
          reason: "host_profile_mismatch",
          ...cause.details,
        });
      return failure("runtime_unavailable", "Successor host unavailable", messageOf(cause));
    }
    const herdr = this.#deps.createHerdrClient(binding.herdrSocket);
    let stop: (() => void) | undefined;
    let stopReadiness: (() => void) | undefined;
    try {
      const readySignal = Promise.withResolvers<string>();
      const outcome = readySignal.promise.then(
        (path) => ({ ok: true, path }) as const,
        (reason: unknown) => ({ ok: false, reason }) as const,
      );
      stop = await herdr.subscribe((event) => {
        const disconnected = herdrConnectionErrorSchema.safeParse(event);
        if (disconnected.success) readySignal.reject(new Error(disconnected.data.data.message));
      });
      let current = binding;
      let paneId = current.paneId;
      if (paneId === null) {
        const ownership = stillOwner();
        if (!ownership.ok) return ownership;
        if (!ownership.value) return leaseLost();
        const predecessor = this.#withRegistry((registry) => registry.stageOf(current.id));
        if (
          !predecessor.ok ||
          predecessor.value?.previousBindingId === null ||
          predecessor.value?.previousBindingId === undefined
        )
          throw new Error("Successor predecessor missing");
        const previous = this.#binding(predecessor.value.previousBindingId);
        if (!previous.ok) return previous;
        const workspaceId = previous.value.workspaceId;
        // The predecessor's workspace is supplied by the caller when reservation has no pane yet.
        if (workspaceId === null) throw new Error("Successor workspace is missing");
        paneId = (await herdr.createTab(workspaceId, checkout.path, "execute")).rootPaneId;
        const provisioned = this.#withRegistry((registry) =>
          registry.provisionSuccessorLaunch(current.id, owner, workspaceId, paneId ?? ""),
        );
        if (!provisioned.ok) return provisioned;
        current = provisioned.value;
      }
      if (current.launchState !== "provisioning") {
        const resumed = this.#withRegistry((registry) =>
          registry.prepareSuccessorLaunch(current.id, owner),
        );
        if (!resumed.ok) return resumed;
        current = resumed.value;
      }
      const model = modelForLaunch("child", "execute");
      let seedPath = current.sessionPath;
      if (seedPath === null) {
        const manager = SessionManager.create(
          checkout.path,
          join(this.#root, ".omo/state/sessions"),
          { id: current.durableSessionId },
        );
        manager.appendModelChange(model.provider, model.modelId);
        manager.appendThinkingLevelChange(model.thinking);
        seedPath = manager.getSessionFile() ?? null;
        const header = manager.getHeader();
        if (seedPath === undefined || seedPath === null || header === null)
          throw new Error("Native session seed missing");
        await writeFile(
          seedPath,
          `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          { mode: 0o600, flag: "wx" },
        );
        const observed = this.#withRegistry((registry) =>
          registry.observeSuccessorSession(current.id, owner, seedPath ?? ""),
        );
        if (!observed.ok) return observed;
        current = observed.value;
      }
      await removeReadiness(this.#root, current.id);
      const readiness = await subscribeReadiness(this.#root, current);
      stopReadiness = readiness.close;
      void readiness.promise.then(
        (receipt) => readySignal.resolve(receipt.sessionPath),
        (cause: unknown) => readySignal.reject(cause),
      );
      const label = roleLabel(current.assignment, snapshot, current.id);
      const dispatch = this.#withRegistry((registry) =>
        registry.dispatchSuccessorLaunch(current.id, owner),
      );
      if (!dispatch.ok) return dispatch.error.code === "lease_lost" ? leaseLost() : dispatch;
      current = dispatch.value;
      dispatched = true;
      await herdr.run(
        paneId,
        [
          "env",
          "-u",
          "OMO_INITIATIVE_HOST",
          "OMO_ENABLE_SHARED_HOST=1",
          `OMO_RPC_SOCKET=${binding.omoSocket}`,
          `OMO_INITIATIVE_ROOT=${this.#root}`,
          join(this.#root, "node_modules/.bin/omo"),
          "-e",
          join(this.#root, "dist/extension/index.js"),
          "-e",
          join(this.#root, "dist/extension/model-catalog.js"),
          "--session",
          seedPath,
          "--name",
          label,
          "--model",
          `${model.provider}/${model.modelId}`,
          "--thinking",
          model.thinking,
          "--no-model-fallback",
          "--no-recommended-models",
        ],
        { PATH: managedPath, ...runtimeCacheEnvironment(this.#root) },
      );
      const timeout = setTimeout(
        () => readySignal.reject(new Error("Timed out awaiting OMO TUI readiness")),
        15_000,
      );
      timeout.unref();
      try {
        const received = await outcome;
        if (!received.ok) throw received.reason;
        const observed = this.#withRegistry((registry) =>
          registry.observeSuccessorSession(current.id, owner, received.path),
        );
        if (!observed.ok) return observed;
        current = observed.value;
      } finally {
        clearTimeout(timeout);
      }
      const activated = await this.#verifyAndActivateSuccessor(current, owner);
      if (!activated.ok) return activated;
      const initialized = await this.#initialize(activated.value, snapshot);
      if (!initialized.ok) {
        this.#withRegistry((registry) =>
          registry.finishSuccessorLaunch(binding.id, owner, "uncertain"),
        );
        return initialized;
      }
      const finished = this.#withRegistry((registry) =>
        registry.finishSuccessorLaunch(binding.id, owner, "ready"),
      );
      return finished.ok ? ok(this.#creationResult(finished.value)) : finished;
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        dispatched
          ? "Execute launch outcome is uncertain; inspect before retrying"
          : "Successor launch failed before dispatch; retry stage start",
        messageOf(cause),
      );
    } finally {
      stopReadiness?.();
      stop?.();
      herdr.close();
    }
  }

  #creationResult(binding: Binding): CreationResult {
    return {
      binding,
      expectedModel: modelForLaunch("child", "execute"),
      readiness: "ready",
      execution: "brief_accepted",
      stage: "execute",
      mode: "planned",
      ancestry:
        binding.checkout === null
          ? null
          : {
              branch: binding.checkout.branch,
              baseBranch: binding.checkout.baseBranch,
              baseCommit: binding.checkout.baseCommit,
            },
    };
  }

  public async send(input: SendInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    const host = await this.#checkHostProtocol(sender.value);
    if (host !== undefined) return host;
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
      ...this.#packetDeliverable(input.toId, input.kind),
      text: input.text,
      outcome: null,
      evidence: [],
    });
  }

  #packetDeliverable(targetId: string, kind: SendInput["kind"]): Pick<Envelope, "deliverable"> {
    const target = this.#binding(targetId);
    return kind === "instruction" && target.ok && target.value.assignment.role === "child"
      ? { deliverable: target.value.deliverable ?? "pr" }
      : {};
  }

  public async report(input: ReportInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    const host = await this.#checkHostProtocol(sender.value);
    if (host !== undefined) return host;
    if (sender.value.assignment.role === "supervisor" || sender.value.assignment.role === "manager")
      return failure("route_denied", "Management role has no owner to report to");
    const context = await this.#context(sender.value);
    if (!context.ok) return context;
    if (input.toUser && sender.value.assignment.role !== "parent")
      return failure("route_denied", "Only parents report to the user inbox");
    const existing = this.#withRegistry((registry) => registry.delivery(input.messageId));
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    let targetId = sender.value.assignment.ownerBindingId;
    // A replay is a read of the original attempt, never a new routing decision.
    if (existing.ok) targetId = existing.value.envelope.toBindingId;
    else if (sender.value.assignment.role === "parent" && targetId !== null && !input.toUser) {
      const manager = this.#binding(targetId);
      if (!manager.ok && manager.error.code !== "not_found") return manager;
      if (!manager.ok || manager.value.launchState !== "ready") targetId = null;
    }
    if (input.toUser) targetId = null;
    const envelope: Envelope = {
      version: 1,
      id: input.messageId,
      fromBindingId: sender.value.id,
      toBindingId: targetId,
      designationId: sender.value.designationId,
      snapshotDigest: context.value.designation.snapshotDigest,
      kind: "report",
      text: input.text,
      outcome: input.outcome,
      evidence: [...input.evidence],
      ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    };
    if (existing.ok) {
      if (
        JSON.stringify(existing.value.envelope) !== JSON.stringify(envelopeSchema.parse(envelope))
      )
        return failure("message_conflict", "Message ID is bound to a different immutable payload");
      if (canRetryDelivery(existing.value)) return this.#deliver(sender.value, envelope);
      return existing.value.state === "sending" || existing.value.state === "uncertain"
        ? failure(
            "delivery_in_progress",
            "Original delivery requires inspection; no resend or recipient migration",
            existing.value,
          )
        : existing;
    }
    if (targetId !== null) return this.#deliver(sender.value, envelope);
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(sender.value);
      const identity = await session.describe();
      if (!identity.ok) return identity;
      if (!matchesRuntime(sender.value, identity.value))
        return failure("identity_mismatch", "User report sender does not match the bound runtime");
      return this.#withRegistry((registry) =>
        registry.post(sender.value.durableSessionId, envelope),
      );
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Could not verify user report sender",
        messageOf(cause),
      );
    } finally {
      await session?.close();
    }
  }

  async #checkHostProtocol(binding: Binding): Promise<Result<never> | undefined> {
    try {
      const artifact = await this.#deps.resolveHerdrArtifact(this.#root);
      await this.#deps.checkHostProfile?.(
        this.#root,
        binding.omoSocket,
        launchEnvironment(this.#root, managedHerdrPath(artifact.artifactDir)),
      );
      return undefined;
    } catch (cause) {
      if (cause instanceof HostProfileMismatchError)
        return failure("runtime_unavailable", cause.message, {
          reason: "host_profile_mismatch",
          ...cause.details,
        });
      return failure("runtime_unavailable", "Native host protocol check failed", messageOf(cause));
    }
  }

  public async ask(input: AskInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    const host = await this.#checkHostProtocol(sender.value);
    if (host !== undefined) return host;
    if (sender.value.assignment.role !== "child" && sender.value.assignment.role !== "parent")
      return failure("route_denied", "Only children and parents ask questions");
    const context = await this.#context(sender.value);
    if (!context.ok) return context;
    if (input.toUser && sender.value.assignment.role !== "parent")
      return failure("route_denied", "Only parents ask the user inbox");
    const messageId = input.messageId.startsWith(`question:${sender.value.id}:`)
      ? input.messageId
      : `question:${sender.value.id}:${input.messageId}`;
    const existing = this.#withRegistry((registry) => registry.delivery(messageId));
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    const ownerId = sender.value.assignment.ownerBindingId;
    const owner = ownerId === null || existing.ok || input.toUser ? null : this.#binding(ownerId);
    if (owner !== null && !owner.ok && owner.error.code !== "not_found") return owner;
    const targetId = input.toUser
      ? null
      : questionRecipient(
          sender.value.assignment.role,
          existing.ok ? existing.value : null,
          owner?.ok ? owner.value : null,
        );
    const envelope: Envelope = {
      version: 1,
      id: messageId,
      fromBindingId: sender.value.id,
      toBindingId: targetId,
      designationId: sender.value.designationId,
      snapshotDigest: context.value.designation.snapshotDigest,
      kind: "question",
      text: input.text,
      outcome: null,
      evidence: [],
      question: input.questions ?? {
        questions: [
          { id: "text", question: input.text, options: [{ label: "text" }], multiSelect: false },
        ],
        escalates: null,
      },
    };
    if (existing.ok) {
      if (
        JSON.stringify(existing.value.envelope) !== JSON.stringify(envelopeSchema.parse(envelope))
      )
        return failure("message_conflict", "Message ID is bound to a different immutable payload");
      if (canRetryDelivery(existing.value)) return this.#deliver(sender.value, envelope);
      return existing.value.state === "sending" || existing.value.state === "uncertain"
        ? failure(
            "delivery_in_progress",
            "Original delivery requires inspection; no resend or recipient migration",
            existing.value,
          )
        : existing;
    }
    if (targetId !== null) return this.#deliver(sender.value, envelope);
    return this.#postInbox(sender.value, envelope, "Could not verify question sender");
  }

  public async answer(input: AnswerInput): Promise<Result<unknown>> {
    const sender = this.#binding(input.fromId);
    if (!sender.ok) return sender;
    const host = await this.#checkHostProtocol(sender.value);
    if (host !== undefined) return host;
    const context = await this.#context(sender.value);
    if (!context.ok) return context;
    const source = this.#withRegistry((registry) => registry.delivery(input.questionId));
    if (!source.ok) {
      return source.error.code === "not_found"
        ? failure("question_unknown", "No question with this id exists")
        : source;
    }
    if (source.value.envelope.kind !== "question" || source.value.envelope.fromBindingId === null)
      return failure("question_unknown", "No question with this id exists");
    if (source.value.state !== "accepted" && source.value.state !== "posted")
      return failure("question_unknown", "Question is not accepted");
    if (source.value.envelope.toBindingId !== sender.value.id)
      return failure("question_unknown", "No accepted question from this recipient exists");
    const envelope: Envelope = {
      version: 1,
      id: `answer:${input.questionId}`,
      fromBindingId: sender.value.id,
      toBindingId: source.value.envelope.fromBindingId,
      designationId: sender.value.designationId,
      snapshotDigest: context.value.designation.snapshotDigest,
      kind: "answer",
      text: input.text,
      outcome: null,
      evidence: [],
      answer: {
        questionId: input.questionId,
        answers: input.answers ?? { text: { selected: [], text: input.text } },
        unanswered: [...(input.unanswered ?? [])],
      },
    };
    return this.#deliver(sender.value, envelope);
  }

  public async answerAsUser(input: UserAnswerInput): Promise<Result<unknown>> {
    const source = this.#withRegistry((registry) => registry.delivery(input.questionId));
    if (!source.ok) {
      return source.error.code === "not_found"
        ? failure("question_unknown", "No question with this id exists")
        : source;
    }
    if (
      source.value.envelope.kind !== "question" ||
      source.value.state !== "posted" ||
      source.value.envelope.toBindingId !== null ||
      source.value.envelope.fromBindingId === null
    )
      return failure("question_not_in_inbox", "Question is not posted to the user inbox");
    const parent = this.#binding(source.value.envelope.fromBindingId);
    if (!parent.ok) return parent;
    const host = await this.#checkHostProtocol(parent.value);
    if (host !== undefined) return host;
    const context = await this.#context(parent.value);
    if (!context.ok) return context;
    const envelope: Envelope = {
      version: 1,
      id: `answer:${input.questionId}`,
      fromBindingId: null,
      toBindingId: parent.value.id,
      designationId: parent.value.designationId,
      snapshotDigest: context.value.designation.snapshotDigest,
      kind: "answer",
      text: input.text,
      outcome: null,
      evidence: [],
      answer: {
        questionId: input.questionId,
        answers: input.answers ?? { text: { selected: [], text: input.text } },
        unanswered: [...(input.unanswered ?? [])],
      },
    };
    const claimed = this.#withRegistry((registry) =>
      registry.answerFromUser(input.questionId, envelope),
    );
    if (!claimed.ok) return claimed;
    if (claimed.value.disposition === "replay") return ok(claimed.value.record);
    if (claimed.value.disposition === "in_progress")
      return failure(
        "delivery_in_progress",
        "Original delivery requires inspection; no resend",
        claimed.value.record,
      );
    if (claimed.value.target === null)
      return failure("route_denied", "User answer has no parent target");
    return this.#finishUserAnswer(parent.value, claimed.value);
  }

  async #finishUserAnswer(
    parent: Binding,
    claim: {
      readonly record: DeliveryRecord;
      readonly nativeKey?: string | undefined;
    },
  ): Promise<Result<DeliveryRecord>> {
    const nativeKey = claim.nativeKey ?? claim.record.envelope.id;
    let session: NativeSession | undefined;
    const unresolved = (reason: string): Result<DeliveryRecord> => {
      const marked = this.#withRegistry((registry) =>
        registry.uncertain(claim.record.envelope.id, reason, nativeKey),
      );
      return marked.ok
        ? failure("delivery_uncertain", "Native delivery did not return a receipt", marked.value)
        : marked;
    };
    try {
      session = await this.#deps.attachBinding(parent);
      const delivered = await session.deliverUserAnswer(claim.record.envelope.id);
      if (!delivered.ok) return unresolved(delivered.error.message);
      return delivered;
    } catch (cause) {
      const marked = this.#withRegistry((registry) =>
        registry.uncertain(
          claim.record.envelope.id,
          `Native send did not return: ${messageOf(cause)}`,
          nativeKey,
        ),
      );
      return marked.ok
        ? failure("runtime_unavailable", "Could not deliver the user answer", messageOf(cause))
        : marked;
    } finally {
      await session?.close();
    }
  }

  async #postInbox(
    sender: Binding,
    envelope: Envelope,
    unavailable: string,
  ): Promise<Result<DeliveryRecord>> {
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(sender);
      const identity = await session.describe();
      if (!identity.ok) return identity;
      if (!matchesRuntime(sender, identity.value))
        return failure("identity_mismatch", "Sender does not match the bound runtime");
      return this.#withRegistry((registry) => registry.post(sender.durableSessionId, envelope));
    } catch (cause) {
      return failure("runtime_unavailable", unavailable, messageOf(cause));
    } finally {
      await session?.close();
    }
  }

  public questions(filter: ScopeFilter = {}): Result<ListedQuestion[]> {
    if (!existsSync(this.#dbPath)) return ok([]);
    const registry = this.#deps.openRegistry(this.#dbPath, { readonly: true });
    try {
      return registry.questions(filter);
    } finally {
      registry.close();
    }
  }

  public reports(filter: ScopeFilter = {}): Result<DeliveryRecord[]> {
    return this.#readDeliveryRecords("reports", filter);
  }

  public notices(filter: ScopeFilter = {}): Result<DeliveryRecord[]> {
    return this.#readDeliveryRecords("notices", filter);
  }

  #readDeliveryRecords(view: "reports" | "notices", filter: ScopeFilter): Result<DeliveryRecord[]> {
    if (!existsSync(this.#dbPath)) return ok([]);
    const registry = this.#deps.openRegistry(this.#dbPath, { readonly: true });
    try {
      return view === "reports"
        ? registry.postedReports(filter)
        : registry.operationalNotices(filter);
    } finally {
      registry.close();
    }
  }

  public linkParent(parentId: string, supervisorId: string): Result<Binding> {
    return this.#withRegistry((registry) => registry.setOwner(parentId, supervisorId));
  }

  public unlinkParent(parentId: string): Result<Binding> {
    return this.#withRegistry((registry) => registry.setOwner(parentId, null));
  }

  public status(filter: string | ScopeFilter = {}): Result<StatusBinding[]> {
    const scope = typeof filter === "string" ? { initiativeId: filter } : filter;
    return this.#withRegistry((registry) => {
      const listed = registry.list();
      if (!listed.ok) return listed;
      const questions = registry.questions({});
      if (!questions.ok) return questions;
      const rows: StatusBinding[] = [];
      for (const binding of listed.value.filter(
        ({ assignment }) =>
          (scope.initiativeId === undefined ||
            (assignment.role !== "manager" && assignment.initiativeId === scope.initiativeId)) &&
          (scope.projectId === undefined ||
            ((assignment.role === "parent" || assignment.role === "child") &&
              assignment.projectId === scope.projectId)),
      )) {
        if (binding.assignment.role !== "child") {
          rows.push(binding);
          continue;
        }
        const stage = registry.stageOf(binding.id);
        if (!stage.ok) return stage;
        if (stage.value === null) {
          rows.push(binding);
          continue;
        }
        const lineage = registry.lineageFor(binding.id);
        if (!lineage.ok) return lineage;
        rows.push({
          ...binding,
          mode:
            lineage.value.mode === "planned"
              ? "planned"
              : lineage.value.mode === "research"
                ? "research"
                : "direct",
          stage:
            lineage.value.stages.findLast((entry) => entry.launchState !== "closed")?.stage ??
            lineage.value.stages.at(-1)?.stage ??
            stage.value.stage,
          stageBindings: lineage.value.stages.map(({ bindingId, stage, launchState }) => ({
            bindingId,
            stage,
            launchState,
          })),
          openQuestions: questions.value.filter(
            ({ record, answered }) =>
              !answered &&
              (record.envelope.fromBindingId === binding.id ||
                record.envelope.toBindingId === binding.id),
          ).length,
        });
      }
      return ok(rows);
    });
  }

  public setPaused(bindingId: string, paused: boolean): Result<Binding> {
    return this.#withRegistry((registry) =>
      registry.setContactState(bindingId, paused ? "paused" : "active"),
    );
  }

  public async prOpen(input: OpenPrInput): Promise<Result<unknown>> {
    const registry = this.#deps.openRegistry(this.#dbPath);
    try {
      return await openPr(registry, input);
    } finally {
      registry.close();
    }
  }

  public async prMerge(parentId: string, reference: string): Promise<Result<unknown>> {
    const registry = this.#deps.openRegistry(this.#dbPath);
    try {
      return await mergePr(registry, parentId, reference);
    } finally {
      registry.close();
    }
  }

  public async close(
    bindingId: string,
    confirmAbsent = false,
    discard = false,
  ): Promise<Result<Binding & { readonly unpushedCommits?: readonly string[] }>> {
    const target = this.#binding(bindingId);
    if (!target.ok) return target;
    let guarded = target.value.checkout?.kind === "owned-clone";
    if (target.value.assignment.role === "child" && (target.value.deliverable ?? "pr") === "pr") {
      const owner = this.#binding(target.value.assignment.ownerBindingId);
      if (!owner.ok) return owner;
      guarded = owner.value.checkout?.kind === "owned-clone";
    }
    const inspectUnpushed = async (): Promise<Result<readonly string[] | undefined>> => {
      if (!guarded || target.value.checkout === null || discard) return ok(undefined);
      if (confirmAbsent && !existsSync(target.value.checkout.path)) return ok([]);
      try {
        await checkoutGit(target.value.checkout.path, ["fetch", "--prune", "origin"]);
        return ok(
          await unpushedCommits(target.value.checkout, target.value.assignment.role === "child"),
        );
      } catch (cause) {
        return failure(
          "runtime_unavailable",
          "Could not inspect unpushed commits; checkout preserved",
          messageOf(cause),
        );
      }
    };
    const withUnpushed = (
      result: Result<Binding>,
      commits: readonly string[] | undefined,
    ): Result<Binding & { readonly unpushedCommits?: readonly string[] }> =>
      result.ok && commits !== undefined
        ? ok({ ...result.value, unpushedCommits: commits })
        : result;
    const inspected = await inspectUnpushed();
    if (!inspected.ok) return inspected;
    if (inspected.value !== undefined && inspected.value.length > 0)
      return failure(
        "unpushed_commits",
        "Close refused: publish commits to origin or explicitly use --discard; checkout preserved",
        { unpushedCommits: inspected.value },
      );
    if (target.value.assignment.role === "child") {
      const stage = this.#withRegistry((registry) => registry.stageOf(bindingId));
      if (!stage.ok) return stage;
      if (stage.value !== null) return this.#closeLineage(target.value, confirmAbsent);
    }
    const closing = this.#withRegistry((registry) => registry.beginClose(bindingId));
    if (!closing.ok) return closing;
    if (closing.value.launchState === "closed") return withUnpushed(closing, inspected.value);
    const binding = closing.value;
    const context = await this.#context(binding);
    // Bindings created before readable labels used the legacy `omo-<role>-<id>` name.
    const launchLabels = new Set([
      `omo-${binding.assignment.role}-${binding.id}`,
      ...(context.ok ? [roleLabel(binding.assignment, context.value.snapshot, binding.id)] : []),
    ]);
    const herdr = this.#deps.createHerdrClient(binding.herdrSocket);
    try {
      const snapshot = await herdr.snapshot();
      const workspaces = snapshot.workspaces.filter((workspace) =>
        binding.workspaceId === null
          ? workspace.label !== undefined &&
            launchLabels.has(workspace.label) &&
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
          (binding.workspaceId === null &&
            (workspace.label === undefined || !launchLabels.has(workspace.label)))
        ) {
          return failure(
            "identity_mismatch",
            "Owned workspace identity changed; inspect it before closing",
          );
        }
        await herdr.closeWorkspace(workspace.workspaceId);
      }
      if (binding.sessionPath !== null) {
        const artifact = await this.#deps.resolveHerdrArtifact(this.#root);
        const managedPath = managedHerdrPath(artifact.artifactDir);
        await this.#deps.ensureHost(
          this.#root,
          binding.omoSocket,
          launchEnvironment(this.#root, managedPath),
        );
        await this.#deps.terminateBinding(binding);
      }
      await removeReadiness(this.#root, binding.id);
      return withUnpushed(
        this.#withRegistry((registry) => registry.finishClose(binding.id)),
        inspected.value,
      );
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

  async #closeLineage(target: Binding, confirmAbsent: boolean): Promise<Result<Binding>> {
    const lineage = this.#withRegistry((registry) => registry.lineageFor(target.id));
    if (!lineage.ok) return lineage;
    const members: Binding[] = [];
    for (const entry of lineage.value.stages) {
      const member = this.#binding(entry.bindingId);
      if (!member.ok) return member;
      members.push(member.value);
    }
    const live = members.filter((member) => member.launchState !== "closed");
    if (live.length > 1)
      return failure("identity_mismatch", "Multiple live stages claim this child");
    const active = live[0];
    const closing =
      active === undefined
        ? ok(target)
        : this.#withRegistry((registry) => registry.beginClose(active.id));
    if (!closing.ok) return closing;
    const binding = closing.value;
    const knownIds = new Set(
      members.flatMap((member) => (member.workspaceId === null ? [] : [member.workspaceId])),
    );
    if (knownIds.size > 1)
      return failure("identity_mismatch", "Stage members claim different workspaces");
    const recordedWorkspaceId = knownIds.values().next().value;
    const herdr = this.#deps.createHerdrClient(binding.herdrSocket);
    try {
      const snapshot = await herdr.snapshot();
      const context = await this.#context(members[0] ?? binding);
      if (!context.ok) return context;
      const labels = new Set(
        members.flatMap((member) => [
          `omo-child-${member.id}`,
          roleLabel(member.assignment, context.value.snapshot, member.id),
        ]),
      );
      const workspaces = snapshot.workspaces.filter((workspace) =>
        recordedWorkspaceId === undefined
          ? workspace.cwd === binding.cwd &&
            workspace.label !== undefined &&
            labels.has(workspace.label)
          : workspace.workspaceId === recordedWorkspaceId,
      );
      if (workspaces.length > 1)
        return failure("identity_mismatch", "Multiple workspaces claim this child");
      const workspace = workspaces[0];
      if (
        workspace === undefined &&
        recordedWorkspaceId === undefined &&
        binding.sessionPath === null &&
        !confirmAbsent
      )
        return failure(
          "closure_uncertain",
          "Inspect Herdr, then use --confirm-absent if no workspace was created",
        );
      if (
        workspace !== undefined &&
        (workspace.cwd !== binding.cwd ||
          (recordedWorkspaceId === undefined &&
            (workspace.label === undefined || !labels.has(workspace.label))))
      )
        return failure(
          "identity_mismatch",
          "Owned workspace identity changed; inspect it before closing",
        );
      if (binding.sessionPath !== null && active !== undefined) {
        const artifact = await this.#deps.resolveHerdrArtifact(this.#root);
        await this.#deps.ensureHost(
          this.#root,
          binding.omoSocket,
          launchEnvironment(this.#root, managedHerdrPath(artifact.artifactDir)),
        );
        const pane = snapshot.panes.find(
          (item) => item.paneId === binding.paneId && item.workspaceId === binding.workspaceId,
        );
        if (workspace !== undefined && pane !== undefined && hasLiveTui(pane)) {
          const stopped = await this.#stopStageSession(binding, herdr);
          if (!stopped.ok) return stopped;
        } else {
          await this.#deps.terminateBinding(binding);
        }
      }
      if (workspace !== undefined) await herdr.closeWorkspace(workspace.workspaceId);
      for (const member of members) {
        if (member.launchState !== "closed") {
          await removeReadiness(this.#root, member.id);
          const finished = this.#withRegistry((registry) => registry.finishClose(member.id));
          if (!finished.ok) return finished;
        }
      }
      return this.#binding(target.id);
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

  async #stopStageSession(binding: Binding, herdr: HerdrClient): Promise<Result<void>> {
    if (binding.paneId === null) return failure("runtime_unavailable", "Stage has no Herdr pane");
    let stop: (() => void) | undefined;
    try {
      const exited = Promise.withResolvers<void>();
      const outcome = exited.promise.then(
        () => true,
        () => false,
      );
      stop = await herdr.subscribe((event) => {
        if (planPaneExited(event, binding.paneId ?? "")) exited.resolve();
        const disconnected = herdrConnectionErrorSchema.safeParse(event);
        if (disconnected.success) exited.reject(new Error(disconnected.data.data.message));
      });
      const timeout = setTimeout(() => exited.reject(new Error("Stage pane did not exit")), 30_000);
      timeout.unref();
      try {
        await herdr.sendKeys(binding.paneId, "/quit", ["Enter"]);
        if (!(await outcome)) return failure("runtime_unavailable", "Stage pane did not exit");
      } finally {
        clearTimeout(timeout);
      }
      await this.#deps.terminateBinding(binding);
      return ok(undefined);
    } finally {
      stop?.();
    }
  }

  public async reconcile(
    filter: string | ScopeFilter,
  ): Promise<Result<{ readonly observed: number; readonly bindings: Binding[] }>> {
    const listed = this.status(filter);
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
          const launchIntent = this.#withRegistry((registry) =>
            registry.successorLaunchIntent(binding.id),
          );
          if (!launchIntent.ok) {
            issues.push({ bindingId: binding.id, ...launchIntent.error });
            continue;
          }
          if (launchIntent.value?.state === "uncertain") {
            let session: NativeSession | undefined;
            try {
              session = await this.#deps.attachBinding(binding);
              await session.configure(modelForBinding(binding));
              const identity = await session.describe();
              if (!identity.ok) {
                issues.push({ bindingId: binding.id, ...identity.error });
                continue;
              }
              const settled = this.#withRegistry((registry) =>
                registry.reconcileSuccessorLaunch(
                  binding.id,
                  launchIntent.value?.attemptId ?? "",
                  "uncertain",
                  identity.value,
                ),
              );
              if (!settled.ok) {
                issues.push({ bindingId: binding.id, ...settled.error });
                continue;
              }
              const context = await this.#context(settled.value);
              if (!context.ok) {
                issues.push({ bindingId: binding.id, ...context.error });
                continue;
              }
              const initialized = await this.#initialize(settled.value, context.value.snapshot);
              if (!initialized.ok) {
                issues.push({ bindingId: binding.id, ...initialized.error });
                continue;
              }
              const finished = this.#withRegistry((registry) =>
                registry.finishSuccessorLaunch(
                  binding.id,
                  launchIntent.value?.attemptId ?? "",
                  "ready",
                ),
              );
              if (!finished.ok) issues.push({ bindingId: binding.id, ...finished.error });
              else observed += 1;
              continue;
            } catch (cause) {
              issues.push({
                bindingId: binding.id,
                code: "runtime_unavailable",
                message: messageOf(cause),
              });
              continue;
            } finally {
              await session?.close();
            }
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
      const current = this.status(filter);
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
    target?: {
      readonly bindingId?: string;
      readonly stage?: ChildStage;
      readonly mode?: ChildCreateMode;
      readonly planPath?: string;
      readonly deliverable?: Deliverable | undefined;
      readonly managerModel?: ManagerModelResolution;
      readonly successor?: {
        readonly previousId: string;
        readonly workspaceId: string;
        readonly head: string;
        readonly planPath: string;
      };
    },
  ): Promise<Result<CreationResult>> {
    let managedPath: string;
    try {
      const artifact = await this.#deps.resolveHerdrArtifact(this.#root);
      managedPath = managedHerdrPath(artifact.artifactDir);
    } catch (cause) {
      return failure(
        "runtime_unavailable",
        "Managed Herdr runtime is unavailable",
        messageOf(cause),
      );
    }
    const environment = launchEnvironment(this.#root, managedPath);
    const bindingId = target?.bindingId ?? this.#deps.uuid();
    if (target?.successor !== undefined) {
      const reserved = this.#withRegistry((registry) =>
        registry.successorReservation(
          target.successor?.previousId ?? "",
          {
            bindingId,
            durableSessionId: this.#deps.uuid(),
            designation,
            snapshot,
            assignment,
            deliverable: target?.deliverable,
            cwd,
            checkout,
            herdrSocket: this.#herdrSocket,
            omoSocket: this.#omoSocket,
          },
          "execute",
        ),
      );
      if (!reserved.ok) return reserved;
      return this.#resumeSuccessor(reserved.value, snapshot, {
        planPath: target.successor.planPath,
        head: target.successor.head,
        planSha256: "",
        completedAt: "",
      });
    }
    const reserved = this.#withRegistry((registry) =>
      registry.reserve({
        bindingId,
        durableSessionId: this.#deps.uuid(),
        designation,
        snapshot,
        assignment,
        deliverable: target?.deliverable,
        cwd,
        checkout,
        herdrSocket: this.#herdrSocket,
        omoSocket: this.#omoSocket,
      }),
    );
    if (!reserved.ok) return reserved;
    const launchStage = target?.stage;
    if (
      launchStage !== undefined &&
      assignment.role === "child" &&
      target?.successor === undefined
    ) {
      const existingStage = this.#withRegistry((registry) => registry.stageOf(bindingId));
      if (!existingStage.ok) return existingStage;
      if (existingStage.value === null) {
        const recorded = this.#withRegistry((registry) =>
          registry.recordStage(bindingId, assignment.issueId, launchStage, 0, null),
        );
        if (!recorded.ok) {
          this.#withRegistry((registry) => {
            const closing = registry.beginClose(bindingId);
            return closing.ok ? registry.finishClose(bindingId) : closing;
          });
          return recorded;
        }
      }
    }
    try {
      await this.#deps.checkHostProfile?.(this.#root, this.#omoSocket, environment);
      await this.#deps.ensureHost(this.#root, this.#omoSocket, environment);
    } catch (cause) {
      if (target?.successor === undefined)
        this.#withRegistry((registry) => {
          const closing = registry.beginClose(bindingId);
          return closing.ok ? registry.finishClose(bindingId) : closing;
        });
      if (cause instanceof HostProfileMismatchError)
        return failure("runtime_unavailable", cause.message, {
          reason: "host_profile_mismatch",
          ...cause.details,
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
      const label = roleLabel(assignment, snapshot, bindingId);
      if (checkout?.kind === "owned-clone") await cloneCheckout(this.#root, checkout);
      const workspace =
        checkout === null || checkout.kind === "owned-clone"
          ? await herdr.createWorkspace(cwd, label)
          : await herdr.createWorktree(checkout, label);
      const provisioned = this.#withRegistry((registry) =>
        registry.provision(bindingId, workspace.workspaceId, workspace.rootPaneId),
      );
      if (!provisioned.ok) return provisioned;
      if (target?.mode === "planned") {
        let rootTabId = workspace.rootTabId;
        if (rootTabId === undefined) {
          const observed = (await herdr.snapshot()).workspaces.find(
            (candidate) => candidate.workspaceId === workspace.workspaceId,
          );
          rootTabId = observed?.rootTabId;
        }
        if (rootTabId !== undefined && target?.successor === undefined)
          await herdr.renameTab(rootTabId, "plan");
      }
      if (checkout !== null) {
        await initializeCheckout(this.#root, checkout);
        const observedHead = await this.#deps.gitTip(checkout.path, "HEAD");
        if (observedHead !== checkout.baseCommit) {
          throw new Error(
            `Worktree ancestry conflict: expected ${checkout.baseCommit}, observed ${observedHead}`,
          );
        }
      }
      const model =
        assignment.role === "manager"
          ? (target?.managerModel?.model ?? resolveManagerModel().model)
          : modelForLaunch(assignment.role, target?.stage ?? null);
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
        this.#tuiArgv(reserved.value, seedPath, label, model),
        this.#tuiEnvironment(managedPath),
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
      if (!activated.ok) {
        if (activated.error.code === "runtime_unavailable") {
          this.#withRegistry((registry) => registry.setLaunchState(bindingId, "uncertain"));
        }
        return activated;
      }
      const initialized = await this.#initialize(activated.value, snapshot, target?.successor);
      if (!initialized.ok) return initialized;
      return ok({
        binding: initialized.value,
        expectedModel: model,
        readiness: "ready",
        execution: "brief_accepted",
        ...(launchStage === undefined
          ? {}
          : { stage: launchStage, mode: target?.mode ?? "direct" }),
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

  async #verifyAndActivateSuccessor(binding: Binding, owner: string): Promise<Result<Binding>> {
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(binding);
      await session.configure(modelForBinding(binding));
      const identity = await session.describe();
      if (!identity.ok) return identity;
      if (identity.value.extensionProtocol !== 2)
        return failure("runtime_unavailable", "Native host protocol is incompatible", {
          reason: "host_profile_mismatch",
        });
      return this.#withRegistry((registry) =>
        registry.activateSuccessorLaunch(binding.id, owner, identity.value),
      );
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

  async #verifyAndActivate(binding: Binding): Promise<Result<Binding>> {
    let session: NativeSession | undefined;
    try {
      session = await this.#deps.attachBinding(binding);
      if (binding.assignment.role !== "manager") await session.configure(modelForBinding(binding));
      const identity = await session.describe();
      if (!identity.ok) return identity;
      if (
        identity.value.extensionProtocol !== 2 &&
        binding.launchState === "provisioning" &&
        binding.initialization.state === "pending"
      ) {
        return failure("runtime_unavailable", "Native host protocol is incompatible", {
          reason: "host_profile_mismatch",
          missingCapabilities: ["olw_extension_protocol_2"],
          generation: null,
          sessions: { total: 0, worker: 0 },
          actualProfile: null,
          recovery: {
            automatic: false,
            argv: [
              join(this.#root, "node_modules/.bin/omo"),
              "host",
              "handoff",
              "--launch-spec",
              join(this.#root, "omo-host.json"),
              "--socket",
              binding.omoSocket,
            ],
            env: runtimeCacheEnvironment(this.#root),
          },
        });
      }
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

  #planPathForChild(
    assignment: Extract<Assignment, { readonly role: "child" }>,
    snapshot: ScopeSnapshot,
  ): Result<string> {
    const issue = snapshot.projects
      .find((entry) => entry.project.id === assignment.projectId)
      ?.issues.find((entry) => entry.id === assignment.issueId);
    return planPathForIssueKey(issue?.key);
  }

  async #initialize(
    binding: Binding,
    snapshot: ScopeSnapshot,
    successor?: { readonly planPath: string; readonly head: string },
  ): Promise<Result<Binding>> {
    const lineage =
      binding.assignment.role === "child"
        ? this.#withRegistry((registry) => registry.lineageFor(binding.id))
        : undefined;
    if (lineage !== undefined && !lineage.ok) return lineage;
    const latest = lineage?.value.stages.at(-1);
    const currentStage = latest?.bindingId === binding.id ? latest.stage : undefined;
    const predecessor =
      latest?.bindingId === binding.id && latest.ordinal > 0
        ? lineage?.value.stages.find((stage) => stage.ordinal === latest.ordinal - 1)
        : undefined;
    let planPath: string | undefined;
    let planHead: string | undefined;
    if (currentStage === "plan") {
      if (binding.assignment.role !== "child")
        return failure("invalid_input", "Planned issue key requires a child binding");
      const resolved = this.#planPathForChild(binding.assignment, snapshot);
      if (!resolved.ok) return resolved;
      planPath = resolved.value;
    } else if (currentStage === "execute") {
      if (successor !== undefined) {
        planPath = successor.planPath;
        planHead = successor.head;
      } else if (predecessor?.stage === "plan") {
        const predecessorRecord = this.#withRegistry((registry) =>
          registry.stageOf(predecessor.bindingId),
        );
        if (!predecessorRecord.ok) return predecessorRecord;
        if (
          predecessorRecord.value?.handoff === null ||
          predecessorRecord.value?.handoff === undefined
        )
          return failure("invalid_input", "Execute stage has no recorded plan handoff");
        planPath = predecessorRecord.value.handoff.planPath;
        planHead = predecessorRecord.value.handoff.head;
      } else {
        return failure("invalid_input", "Execute stage has no recorded plan handoff");
      }
    }
    const text =
      binding.initialization.text ??
      buildRoleBrief(binding, snapshot, {
        ...(binding.assignment.role === "child"
          ? {
              owner: this.#binding(binding.assignment.ownerBindingId),
              ...(currentStage === undefined ? {} : { stage: currentStage }),
            }
          : {}),
        ...(binding.assignment.role === "parent" ? { includeParentGuidance: true } : {}),
        ...(binding.assignment.role === "manager"
          ? {
              includeManagerGuidance: true,
              updateCheckLine: `update_check: ${this.#managerUpdateLine()}`,
              routingAdviceLine: `routing_advice: ${this.#managerRoutingLine()}`,
            }
          : {}),
        ...(planPath === undefined ? {} : { planPath }),
        ...(planHead === undefined ? {} : { planHead }),
      });
    const claim = this.#withRegistry((registry) => registry.beginInitialization(binding.id, text));
    if (!claim.ok) return claim;
    if (claim.value.disposition === "replay") return ok(claim.value.binding);
    const messageId = initializationMessageId(binding.id);
    try {
      if (claim.value.disposition === "in_progress") {
        if (
          binding.assignment.role === "supervisor" ||
          binding.assignment.role === "manager" ||
          binding.assignment.ownerBindingId === null
        ) {
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
      if (
        binding.assignment.role === "supervisor" ||
        binding.assignment.role === "manager" ||
        binding.assignment.ownerBindingId === null
      ) {
        await this.#deps.prompt(binding, text);
        return this.#finishInitialization(binding.id, "accepted");
      }
      const owner = this.#binding(binding.assignment.ownerBindingId);
      if (!owner.ok) return this.#finishInitialization(binding.id, "uncertain", owner.error);
      const context = await this.#context(owner.value);
      if (!context.ok) return this.#finishInitialization(binding.id, "uncertain", context.error);
      const delivery = await this.#deliver(owner.value, {
        version: 1,
        id: messageId,
        fromBindingId: owner.value.id,
        toBindingId: binding.id,
        designationId: owner.value.designationId,
        snapshotDigest: context.value.designation.snapshotDigest,
        kind: "instruction",
        ...this.#packetDeliverable(binding.id, "instruction"),
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
