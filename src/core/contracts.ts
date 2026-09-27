export type Deliverable = "pr" | "report" | "document";
export type IssueDelivery =
  | { readonly kind: "pr"; readonly url: string; readonly head: string }
  | { readonly kind: "report" | "document"; readonly path: string };

export type ChildStage = "direct" | "plan" | "execute" | "research";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

export interface Ref {
  readonly id: string;
  readonly url: string;
  readonly revision: string;
  /** Human-readable Linear identifier such as P-ENG-12 or I-3; display only. */
  readonly key?: string | undefined;
}
export interface ScopeSnapshot {
  readonly version: 1;
  readonly source: "linear-export" | "fixture";
  readonly initiative: Ref | null;
  readonly projects: Array<{
    readonly project: Ref;
    readonly issues: Ref[];
    readonly repository?:
      | {
          readonly remote: string;
          readonly defaultBranch: string;
          readonly base?: string | undefined;
        }
      | undefined;
  }>;
  readonly decisionRefs: Ref[];
}
export interface Designation {
  readonly id: string;
  readonly snapshotDigest: string;
  readonly designatedBy: string;
  readonly designatedAt: string;
  readonly execute: boolean;
  readonly create: boolean;
  readonly contact: boolean;
}
export type Assignment =
  | { readonly role: "manager" }
  | { readonly role: "supervisor"; readonly initiativeId: string }
  | {
      readonly role: "parent";
      readonly initiativeId: string | null;
      readonly projectId: string;
      // Optional management link, not the source of this parent's approval.
      readonly ownerBindingId: string | null;
    }
  | {
      readonly role: "child";
      readonly initiativeId: string | null;
      readonly projectId: string;
      readonly issueId: string;
      readonly ownerBindingId: string;
    };
export interface StageHandoff {
  readonly planPath: string;
  readonly planSha256: string;
  readonly head: string;
  readonly completedAt: string;
}
export interface StageRecord {
  readonly bindingId: string;
  readonly issueId: string;
  readonly stage: ChildStage;
  readonly ordinal: number;
  readonly previousBindingId: string | null;
  readonly handoff: StageHandoff | null;
}
export interface StageLineage {
  readonly issueId: string;
  readonly mode: ChildStage | "planned";
  readonly stages: ReadonlyArray<{
    readonly bindingId: string;
    readonly stage: ChildStage;
    readonly ordinal: number;
    readonly launchState: Binding["launchState"];
  }>;
}
export interface Checkout {
  /** Missing on legacy callers; persisted rows decode as linked-worktree. */
  readonly kind?: "linked-worktree" | "owned-clone";
  readonly remote?: string | undefined;
  readonly receiptPath?: string | undefined;
  /** User repository for legacy bindings; owned clone root for new mapped bindings. */
  readonly originalRepoRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
}
export interface Binding {
  readonly id: string;
  readonly designationId: string;
  readonly deliverable?: Deliverable | undefined;
  readonly assignment: Assignment;
  readonly durableSessionId: string;
  readonly cwd: string;
  readonly checkout: Checkout | null;
  readonly herdrSocket: string;
  readonly omoSocket: string;
  readonly workspaceId: string | null;
  readonly paneId: string | null;
  readonly sessionPath: string | null;
  readonly launchState:
    | "reserved"
    | "provisioning"
    | "initializing"
    | "ready"
    | "failed"
    | "uncertain"
    | "closing"
    | "closed";
  readonly contactState: "active" | "paused" | "cancelled";
  readonly initialization:
    | { readonly state: "pending"; readonly text: null }
    | { readonly state: "sending" | "accepted" | "rejected" | "uncertain"; readonly text: string };
}
export type ReattachClaim =
  | { readonly claimed: false; readonly binding: Binding }
  /** `token` fences this caller: every later step compares it, so an expired owner cannot act. */
  | { readonly claimed: true; readonly binding: Binding; readonly token: string };
export type SuccessorLaunchIntentState = "claimed" | "dispatching" | "ready" | "uncertain";
export interface SuccessorLaunchIntent {
  readonly attemptId: string;
  readonly state: SuccessorLaunchIntentState;
}
export type SuccessorLaunchClaim =
  | {
      readonly claimed: false;
      readonly binding: Binding;
      readonly state: SuccessorLaunchIntentState;
    }
  /** `token` fences every execute-stage launch mutation and side effect for this caller. */
  | { readonly claimed: true; readonly binding: Binding; readonly token: string };
export interface InitializationClaim {
  readonly disposition: "new" | "replay" | "in_progress";
  readonly binding: Binding;
}
export interface RuntimeFailure {
  readonly source: "turn_end";
  readonly sessionEntryId: string;
  readonly durableSessionId: string;
  readonly sessionPath: string;
  readonly cwd: string;
  readonly provider: string;
  readonly modelId: string;
  readonly timestamp: number;
  readonly stopReason: "error";
  readonly errorMessage: string | null;
}
export interface RuntimeFailureClaim {
  readonly version: 1;
  readonly kind: "runtime_failure";
  readonly failure: RuntimeFailure;
}
export interface OperationalNotice {
  readonly failure: RuntimeFailure;
  readonly binding: Binding;
  readonly ownerBindingId: string | null;
  // Why no native contact was attempted; never a claim of non-acceptance after a send.
  readonly localReason: string | null;
}
export interface Envelope {
  readonly version: 1;
  readonly id: string;
  readonly fromBindingId: string | null;
  // null addresses the local user inbox; it is never a native binding.
  readonly toBindingId: string | null;
  readonly designationId: string;
  readonly snapshotDigest: string;
  readonly kind:
    | "instruction"
    | "coordination"
    | "report"
    | "operational_notice"
    | "question"
    | "answer";
  readonly text: string;
  readonly outcome: "completed" | "blocked" | "failed" | null;
  readonly evidence: string[];
  readonly deliverable?: Deliverable | undefined;
  readonly delivery?: IssueDelivery | undefined;
  readonly operational?: OperationalNotice | undefined;
  readonly question?:
    | {
        readonly questions: ReadonlyArray<{
          readonly id: string;
          readonly question: string;
          readonly options: ReadonlyArray<{
            readonly label: string;
            readonly description?: string | undefined;
          }>;
          readonly multiSelect: boolean;
        }>;
        readonly escalates: string | null;
      }
    | undefined;
  readonly answer?:
    | {
        readonly questionId: string;
        readonly answers: Readonly<
          Record<string, { readonly selected: string[]; readonly text?: string | undefined }>
        >;
        readonly unanswered: string[];
      }
    | undefined;
}
export type NativeReceipt =
  | {
      readonly kind: "ok";
      readonly thread_id: string;
      readonly message_seq: number;
      readonly deduplicated: boolean;
      readonly delivery:
        | { readonly kind: "started" | "steered"; readonly turn_id: string }
        | { readonly kind: "queued"; readonly queue_position: number };
    }
  | {
      readonly kind: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly next_action: string;
        readonly details?: unknown;
      };
    };
export interface DeliveryAttempt {
  readonly number: number;
  readonly nativeKey: string;
  readonly state: "sending" | "accepted" | "rejected" | "uncertain";
  readonly receipt: NativeReceipt | null;
  readonly uncertaintyReason: string | null;
}
export interface DeliveryRecord {
  readonly envelope: Envelope;
  readonly state: "sending" | "accepted" | "rejected" | "uncertain" | "posted";
  readonly receipt: NativeReceipt | null;
  readonly attempts?: readonly DeliveryAttempt[] | undefined;
}
export interface RuntimeIdentity {
  readonly durableSessionId: string;
  readonly sessionPath: string;
  readonly cwd: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: string;
  readonly extensionProtocol: 1 | 2;
}
export interface ClaimResult {
  readonly disposition: "new" | "replay" | "in_progress";
  readonly record: DeliveryRecord;
  readonly target: Binding | null;
  readonly nativeKey?: string | undefined;
}
export interface ReserveInput {
  readonly bindingId: string;
  readonly durableSessionId: string;
  readonly deliverable?: Deliverable | undefined;
  readonly designation: Designation;
  readonly snapshot: ScopeSnapshot;
  readonly assignment: Assignment;
  readonly cwd: string;
  readonly checkout: Checkout | null;
  readonly herdrSocket: string;
  readonly omoSocket: string;
}
export interface ScopeFilter {
  readonly initiativeId?: string;
  readonly projectId?: string;
}
export interface Registry {
  importScope(snapshot: ScopeSnapshot): Result<{ readonly digest: string }>;
  scope(digest: string): Result<ScopeSnapshot>;
  designation(id: string): Result<Designation>;
  reserve(input: ReserveInput): Result<Binding>;
  recordStage(
    bindingId: string,
    issueId: string,
    stage: ChildStage,
    ordinal: number,
    previousBindingId: string | null,
  ): Result<StageRecord>;
  stageOf(bindingId: string): Result<StageRecord | null>;
  stageChain(issueId: string): Result<StageRecord[]>;
  lineageFor(bindingId: string): Result<StageLineage>;
  recordHandoff(bindingId: string, handoff: StageHandoff): Result<StageRecord>;
  successorReservation(
    previousBindingId: string,
    input: ReserveInput,
    nextStage: ChildStage,
  ): Result<Binding>;
  get(id: string): Result<Binding>;
  bySession(id: string): Result<Binding>;
  list(): Result<Binding[]>;
  provision(id: string, workspaceId: string, paneId: string): Result<Binding>;
  observeSession(id: string, sessionPath: string): Result<Binding>;
  /** Claim the single manager TUI reattachment if the binding still records `expectedPaneId`. */
  beginReattach(
    id: string,
    expectedPaneId: string | null,
    claimedAt: string,
    staleBefore: string,
  ): Result<ReattachClaim>;
  /** True only while `token` still owns the binding's reattachment claim. */
  ownsReattach(id: string, token: string): Result<boolean>;
  /** Point the claimed manager at the pane its TUI is launched into; a retry reuses it. */
  recordReattachPane(id: string, token: string, paneId: string): Result<Binding>;
  /** True while a reattachment is claimed or was interrupted before its TUI was verified. */
  reattachPending(id: string): Result<boolean>;
  /** Give up the claim after a failure; the reattachment stays pending for the next caller. */
  releaseReattach(id: string, token: string): Result<boolean>;
  /** Clear the claim once its TUI is verified; false if `token` no longer owns it. */
  finishReattach(id: string, token: string): Result<boolean>;
  /** Claim exclusive ownership of execute-stage recovery before any launch side effect. */
  beginSuccessorLaunch(
    id: string,
    expectedPaneId: string | null,
    claimedAt: string,
    staleBefore: string,
  ): Result<SuccessorLaunchClaim>;
  ownsSuccessorLaunch(id: string, token: string): Result<boolean>;
  /** Token-fenced pane provisioning and launch-state mutation for a claimed recovery. */
  provisionSuccessorLaunch(
    id: string,
    token: string,
    workspaceId: string,
    paneId: string,
  ): Result<Binding>;
  prepareSuccessorLaunch(id: string, token: string): Result<Binding>;
  observeSuccessorSession(id: string, token: string, sessionPath: string): Result<Binding>;
  activateSuccessorLaunch(id: string, token: string, identity: RuntimeIdentity): Result<Binding>;
  /** Record dispatch before herdr.run; dispatching can never be taken over by elapsed time. */
  dispatchSuccessorLaunch(id: string, token: string): Result<Binding>;
  successorLaunchIntent(id: string): Result<SuccessorLaunchIntent | null>;
  /** Settle only the exact attempt/state whose native session the caller observed. */
  reconcileSuccessorLaunch(
    id: string,
    attemptId: string,
    expectedState: "claimed" | "uncertain",
    identity: RuntimeIdentity,
  ): Result<Binding>;
  /** Settle a failed owner: claimed is deleted; dispatching becomes uncertain. */
  failSuccessorLaunch(id: string, token: string): Result<Binding>;
  /** Only a proven pre-dispatch failure may return the intent to none. */
  releaseSuccessorLaunch(id: string, token: string): Result<boolean>;
  /** Settle a claimed/dispatching attempt without deleting its durable result. */
  finishSuccessorLaunch(id: string, token: string, state: "ready" | "uncertain"): Result<Binding>;
  activate(id: string, identity: RuntimeIdentity): Result<Binding>;
  setLaunchState(id: string, state: Binding["launchState"]): Result<Binding>;
  setContactState(id: string, state: Binding["contactState"]): Result<Binding>;
  setOwner(parentId: string, supervisorId: string | null): Result<Binding>;
  beginClose(id: string): Result<Binding>;
  finishClose(id: string): Result<Binding>;
  beginInitialization(id: string, text: string): Result<InitializationClaim>;
  finishInitialization(id: string, state: "accepted" | "rejected" | "uncertain"): Result<Binding>;
  authorize(senderSessionId: string, envelope: Envelope): Result<Binding>;
  claim(senderSessionId: string, envelope: Envelope | RuntimeFailureClaim): Result<ClaimResult>;
  finish(messageId: string, receipt: NativeReceipt, nativeKey?: string): Result<DeliveryRecord>;
  uncertain(messageId: string, reason: string, nativeKey?: string): Result<DeliveryRecord>;
  delivery(messageId: string): Result<DeliveryRecord>;
  childReports(parentId: string): Result<DeliveryRecord[]>;
  post(senderSessionId: string, envelope: Envelope): Result<DeliveryRecord>;
  postedReports(filter: ScopeFilter): Result<DeliveryRecord[]>;
  postedQuestions(
    filter: ScopeFilter,
  ): Result<Array<{ readonly record: DeliveryRecord; readonly answered: boolean }>>;
  questions(filter: ScopeFilter): Result<
    Array<{
      readonly record: DeliveryRecord;
      readonly answered: boolean;
      readonly answer: DeliveryRecord | null;
    }>
  >;
  answerFromUser(questionId: string, envelope: Envelope): Result<ClaimResult>;
  releaseUserAnswer(messageId: string, recipientSessionId: string): Result<ClaimResult>;
  operationalNotices(filter: ScopeFilter): Result<DeliveryRecord[]>;
  close(): void;
}
export type WorkerRequest =
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "lookup-session";
      readonly input: { readonly durableSessionId: string };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "authorize";
      readonly input: { readonly senderSessionId: string; readonly envelope: Envelope };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "claim";
      readonly input: {
        readonly senderSessionId: string;
        readonly envelope: Envelope | RuntimeFailureClaim;
      };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "finish";
      readonly input: {
        readonly messageId: string;
        readonly receipt: NativeReceipt;
        readonly nativeKey?: string | undefined;
      };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "uncertain";
      readonly input: {
        readonly messageId: string;
        readonly reason: string;
        readonly nativeKey?: string | undefined;
      };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "release-user-answer";
      readonly input: {
        readonly messageId: string;
        readonly recipientSessionId: string;
      };
    };
