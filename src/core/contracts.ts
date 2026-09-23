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
}
export interface ScopeSnapshot {
  readonly version: 1;
  readonly source: "linear-export" | "fixture";
  readonly initiative: Ref;
  readonly projects: Array<{ readonly project: Ref; readonly issues: Ref[] }>;
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
  | { readonly role: "supervisor"; readonly initiativeId: string }
  | {
      readonly role: "parent";
      readonly initiativeId: string;
      readonly projectId: string;
      readonly ownerBindingId: string;
    }
  | {
      readonly role: "child";
      readonly initiativeId: string;
      readonly projectId: string;
      readonly issueId: string;
      readonly ownerBindingId: string;
    };
export interface Checkout {
  readonly originalRepoRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
}
export interface Binding {
  readonly id: string;
  readonly designationId: string;
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
export interface InitializationClaim {
  readonly disposition: "new" | "replay" | "in_progress";
  readonly binding: Binding;
}
export interface Envelope {
  readonly version: 1;
  readonly id: string;
  readonly fromBindingId: string;
  readonly toBindingId: string;
  readonly designationId: string;
  readonly snapshotDigest: string;
  readonly kind: "instruction" | "coordination" | "report";
  readonly text: string;
  readonly outcome: "completed" | "blocked" | "failed" | null;
  readonly evidence: string[];
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
export interface DeliveryRecord {
  readonly envelope: Envelope;
  readonly state: "sending" | "accepted" | "rejected" | "uncertain";
  readonly receipt: NativeReceipt | null;
}
export interface RuntimeIdentity {
  readonly durableSessionId: string;
  readonly sessionPath: string;
  readonly cwd: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: string;
  readonly extensionProtocol: 1;
}
export interface ClaimResult {
  readonly disposition: "new" | "replay" | "in_progress";
  readonly record: DeliveryRecord;
  readonly target: Binding;
}
export interface ReserveInput {
  readonly bindingId: string;
  readonly durableSessionId: string;
  readonly designation: Designation;
  readonly snapshot: ScopeSnapshot;
  readonly assignment: Assignment;
  readonly cwd: string;
  readonly checkout: Checkout | null;
  readonly herdrSocket: string;
  readonly omoSocket: string;
}
export interface Registry {
  importScope(snapshot: ScopeSnapshot): Result<{ readonly digest: string }>;
  scope(digest: string): Result<ScopeSnapshot>;
  designation(id: string): Result<Designation>;
  reserve(input: ReserveInput): Result<Binding>;
  get(id: string): Result<Binding>;
  bySession(id: string): Result<Binding>;
  list(): Result<Binding[]>;
  provision(id: string, workspaceId: string, paneId: string): Result<Binding>;
  observeSession(id: string, sessionPath: string): Result<Binding>;
  activate(id: string, identity: RuntimeIdentity): Result<Binding>;
  setLaunchState(id: string, state: Binding["launchState"]): Result<Binding>;
  setContactState(id: string, state: Binding["contactState"]): Result<Binding>;
  beginClose(id: string): Result<Binding>;
  finishClose(id: string): Result<Binding>;
  beginInitialization(id: string, text: string): Result<InitializationClaim>;
  finishInitialization(id: string, state: "accepted" | "rejected" | "uncertain"): Result<Binding>;
  authorize(senderSessionId: string, envelope: Envelope): Result<Binding>;
  claim(senderSessionId: string, envelope: Envelope): Result<ClaimResult>;
  finish(messageId: string, receipt: NativeReceipt): Result<DeliveryRecord>;
  uncertain(messageId: string, reason: string): Result<DeliveryRecord>;
  delivery(messageId: string): Result<DeliveryRecord>;
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
      readonly action: "authorize" | "claim";
      readonly input: { readonly senderSessionId: string; readonly envelope: Envelope };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "finish";
      readonly input: { readonly messageId: string; readonly receipt: NativeReceipt };
    }
  | {
      readonly version: 1;
      readonly dbPath: string;
      readonly action: "uncertain";
      readonly input: { readonly messageId: string; readonly reason: string };
    };
