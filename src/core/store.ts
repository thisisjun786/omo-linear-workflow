import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  Assignment,
  Binding,
  ClaimResult,
  DeliveryRecord,
  Designation,
  Envelope,
  InitializationClaim,
  NativeReceipt,
  Registry,
  ReserveInput,
  Result,
  RuntimeIdentity,
  ScopeSnapshot,
} from "./contracts";
import { initializationMessageId, matchesRuntime } from "./policy";
import {
  bindingSchema,
  deliveryRecordSchema,
  designationSchema,
  envelopeSchema,
  nativeReceiptSchema,
  reserveInputSchema,
  runtimeIdentitySchema,
  scopeSnapshotSchema,
} from "./schema";

interface JsonRow {
  readonly json: string;
}
interface DeliveryRow {
  readonly envelope_json: string;
  readonly state: string;
  readonly receipt_json: string | null;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function error<T>(code: string, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function encoded(value: unknown): string {
  return JSON.stringify(value);
}
function digestOf(snapshot: ScopeSnapshot): string {
  return createHash("sha256").update(encoded(snapshot)).digest("hex");
}
function parseJson(text: string): unknown {
  return JSON.parse(text);
}
function same(left: unknown, right: unknown): boolean {
  return encoded(left) === encoded(right);
}

function validateSnapshot(value: unknown): Result<ScopeSnapshot> {
  const parsed = scopeSnapshotSchema.safeParse(value);
  if (!parsed.success)
    return error("invalid_scope", "Scope snapshot is invalid", parsed.error.issues);
  const ids = new Set<string>();
  const refs = [parsed.data.initiative, ...parsed.data.decisionRefs];
  for (const project of parsed.data.projects) refs.push(project.project, ...project.issues);
  for (const ref of refs) {
    if (ids.has(ref.id)) return error("invalid_scope", `Duplicate scope ID: ${ref.id}`);
    ids.add(ref.id);
  }
  return ok(parsed.data);
}

function ownershipKey(assignment: Assignment): string {
  if (assignment.role === "supervisor") return `initiative:${assignment.initiativeId}`;
  if (assignment.role === "parent") return `project:${assignment.projectId}`;
  return `issue:${assignment.issueId}`;
}

function parseBinding(row: JsonRow | null): Result<Binding> {
  if (row === null) return error("not_found", "Binding was not found");
  const parsed = bindingSchema.safeParse(parseJson(row.json));
  return parsed.success
    ? ok(parsed.data)
    : error("storage_corrupt", "Stored binding is invalid", parsed.error.issues);
}

function parseDesignation(row: JsonRow | null): Result<Designation> {
  if (row === null) return error("not_found", "Designation was not found");
  const parsed = designationSchema.safeParse(parseJson(row.json));
  return parsed.success
    ? ok(parsed.data)
    : error("storage_corrupt", "Stored designation is invalid", parsed.error.issues);
}

function parseDelivery(row: DeliveryRow | null): Result<DeliveryRecord> {
  if (row === null) return error("not_found", "Delivery was not found");
  const parsed = deliveryRecordSchema.safeParse({
    envelope: parseJson(row.envelope_json),
    state: row.state,
    receipt: row.receipt_json === null ? null : parseJson(row.receipt_json),
  });
  return parsed.success
    ? ok(parsed.data)
    : error("storage_corrupt", "Stored delivery is invalid", parsed.error.issues);
}

function assignmentAllowed(snapshot: ScopeSnapshot, assignment: Assignment): Result<true> {
  if (assignment.initiativeId !== snapshot.initiative.id)
    return error("scope_violation", "Initiative is outside the designated snapshot");
  if (assignment.role === "supervisor") return ok(true);
  const project = snapshot.projects.find((entry) => entry.project.id === assignment.projectId);
  if (project === undefined)
    return error("scope_violation", "Project is outside the designated snapshot");
  if (
    assignment.role === "child" &&
    !project.issues.some((issue) => issue.id === assignment.issueId)
  ) {
    return error("scope_violation", "Issue is outside its designated project");
  }
  return ok(true);
}

export function openRegistry(path: string): Registry {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS scopes (digest TEXT PRIMARY KEY, json TEXT NOT NULL)");
  db.run(`CREATE TABLE IF NOT EXISTS designations (
    id TEXT PRIMARY KEY, scope_digest TEXT NOT NULL REFERENCES scopes(digest), json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bindings (
    id TEXT PRIMARY KEY,
    designation_id TEXT NOT NULL REFERENCES designations(id),
    durable_session_id TEXT NOT NULL UNIQUE,
    ownership_key TEXT NOT NULL,
    launch_state TEXT NOT NULL,
    json TEXT NOT NULL
  )`);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS bindings_live_owner ON bindings(ownership_key) WHERE launch_state <> 'closed'",
  );
  db.run(`CREATE TABLE IF NOT EXISTS deliveries (
    message_id TEXT PRIMARY KEY,
    envelope_json TEXT NOT NULL,
    state TEXT NOT NULL,
    receipt_json TEXT,
    uncertain_reason TEXT
  )`);

  const bindingById = db.query<JsonRow, [string]>("SELECT json FROM bindings WHERE id = ?");
  const bindingBySession = db.query<JsonRow, [string]>(
    "SELECT json FROM bindings WHERE durable_session_id = ?",
  );
  const designationById = db.query<JsonRow, [string]>("SELECT json FROM designations WHERE id = ?");
  const scopeByDigest = db.query<JsonRow, [string]>("SELECT json FROM scopes WHERE digest = ?");
  const deliveryById = db.query<DeliveryRow, [string]>(
    "SELECT envelope_json, state, receipt_json FROM deliveries WHERE message_id = ?",
  );

  function transaction<T>(operation: () => Result<T>): Result<T> {
    try {
      db.run("BEGIN IMMEDIATE");
      const result = operation();
      db.run(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (cause) {
      try {
        db.run("ROLLBACK");
      } catch (rollbackCause) {
        return error("storage_error", "Registry transaction and rollback failed", {
          operation: messageOf(cause),
          rollback: messageOf(rollbackCause),
        });
      }
      return error("storage_error", "Registry transaction failed", messageOf(cause));
    }
  }

  function importScope(snapshotValue: ScopeSnapshot): Result<{ readonly digest: string }> {
    const valid = validateSnapshot(snapshotValue);
    if (!valid.ok) return valid;
    const digest = digestOf(valid.value);
    try {
      const existing = scopeByDigest.get(digest);
      if (existing !== null && existing.json !== encoded(valid.value))
        return error("digest_conflict", "Scope digest has different content");
      db.query("INSERT OR IGNORE INTO scopes (digest, json) VALUES (?, ?)").run(
        digest,
        encoded(valid.value),
      );
      return ok({ digest });
    } catch (cause) {
      return error("storage_error", "Could not import scope", messageOf(cause));
    }
  }

  function get(id: string): Result<Binding> {
    return parseBinding(bindingById.get(id));
  }
  function bySession(id: string): Result<Binding> {
    return parseBinding(bindingBySession.get(id));
  }
  function designationFor(id: string): Result<Designation> {
    return parseDesignation(designationById.get(id));
  }

  function reserve(inputValue: ReserveInput): Result<Binding> {
    const parsed = reserveInputSchema.safeParse(inputValue);
    if (!parsed.success)
      return error("invalid_input", "Reservation input is invalid", parsed.error.issues);
    const validScope = validateSnapshot(parsed.data.snapshot);
    if (!validScope.ok) return validScope;
    const input = parsed.data;
    const digest = digestOf(validScope.value);
    if (input.designation.snapshotDigest !== digest)
      return error("digest_mismatch", "Designation does not match the snapshot");
    const membership = assignmentAllowed(validScope.value, input.assignment);
    if (!membership.ok) return membership;
    if (input.assignment.role !== "supervisor" && !input.designation.create) {
      return error("create_denied", "Designation does not permit role creation");
    }
    return transaction(() => {
      const existingScope = scopeByDigest.get(digest);
      if (existingScope === null)
        db.query("INSERT INTO scopes (digest, json) VALUES (?, ?)").run(
          digest,
          encoded(validScope.value),
        );
      else if (existingScope.json !== encoded(validScope.value))
        return error("digest_conflict", "Scope digest has different content");

      const priorDesignation = designationById.get(input.designation.id);
      if (priorDesignation === null) {
        db.query("INSERT INTO designations (id, scope_digest, json) VALUES (?, ?, ?)").run(
          input.designation.id,
          digest,
          encoded(input.designation),
        );
      } else {
        const prior = parseDesignation(priorDesignation);
        if (!prior.ok) return prior;
        if (!same(prior.value, input.designation))
          return error("designation_conflict", "Designation ID is immutable");
      }

      if (input.assignment.role !== "supervisor") {
        const owner = get(input.assignment.ownerBindingId);
        if (!owner.ok) return error("owner_mismatch", "Owner binding does not exist");
        if (
          owner.value.launchState === "closing" ||
          owner.value.launchState === "closed" ||
          owner.value.contactState === "cancelled"
        ) {
          return error("owner_unavailable", "Owner is closing or cancelled");
        }
        const expectedRole = input.assignment.role === "parent" ? "supervisor" : "parent";
        if (
          owner.value.assignment.role !== expectedRole ||
          owner.value.designationId !== input.designation.id ||
          owner.value.assignment.initiativeId !== input.assignment.initiativeId ||
          (input.assignment.role === "child" &&
            owner.value.assignment.role === "parent" &&
            owner.value.assignment.projectId !== input.assignment.projectId)
        ) {
          return error("owner_mismatch", "Owner edge does not match the assignment");
        }
      }
      const owner = db
        .query<{ readonly id: string }, [string]>(
          "SELECT id FROM bindings WHERE ownership_key = ? AND launch_state <> 'closed'",
        )
        .get(ownershipKey(input.assignment));
      if (owner !== null)
        return error("ownership_conflict", "Scope already has a live owner", {
          bindingId: owner.id,
        });
      if (bindingById.get(input.bindingId) !== null)
        return error("binding_conflict", "Binding ID already exists");
      if (bindingBySession.get(input.durableSessionId) !== null)
        return error("session_conflict", "Durable session already belongs to a binding");
      const binding: Binding = {
        id: input.bindingId,
        designationId: input.designation.id,
        assignment: input.assignment,
        durableSessionId: input.durableSessionId,
        cwd: input.cwd,
        checkout: input.checkout,
        herdrSocket: input.herdrSocket,
        omoSocket: input.omoSocket,
        workspaceId: null,
        paneId: null,
        sessionPath: null,
        launchState: "reserved",
        contactState: "active",
        initialization: { state: "pending", text: null },
      };
      db.query(
        "INSERT INTO bindings (id, designation_id, durable_session_id, ownership_key, launch_state, json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        binding.id,
        binding.designationId,
        binding.durableSessionId,
        ownershipKey(binding.assignment),
        binding.launchState,
        encoded(binding),
      );
      return ok(binding);
    });
  }

  function saveBinding(binding: Binding): Result<Binding> {
    try {
      db.query("UPDATE bindings SET launch_state = ?, json = ? WHERE id = ?").run(
        binding.launchState,
        encoded(binding),
        binding.id,
      );
      return ok(binding);
    } catch (cause) {
      return error("storage_error", "Could not update binding", messageOf(cause));
    }
  }

  function provision(id: string, workspaceId: string, paneId: string): Result<Binding> {
    if (workspaceId.length === 0 || paneId.length === 0)
      return error("invalid_input", "Workspace and pane IDs are required");
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (binding.value.launchState !== "reserved")
        return error("invalid_transition", "Only a reserved binding can be provisioned");
      return saveBinding({ ...binding.value, workspaceId, paneId, launchState: "provisioning" });
    });
  }

  function observeSession(id: string, sessionPath: string): Result<Binding> {
    if (sessionPath.length === 0) return error("invalid_input", "Session path is required");
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (binding.value.launchState !== "provisioning")
        return error("invalid_transition", "Session observation requires provisioning");
      if (binding.value.sessionPath !== null && binding.value.sessionPath !== sessionPath)
        return error("identity_conflict", "Observed session path is immutable");
      return saveBinding({ ...binding.value, sessionPath });
    });
  }

  function activate(id: string, identityValue: RuntimeIdentity): Result<Binding> {
    const identity = runtimeIdentitySchema.safeParse(identityValue);
    if (!identity.success)
      return error("invalid_input", "Runtime identity is invalid", identity.error.issues);
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (
        binding.value.launchState !== "provisioning" ||
        binding.value.sessionPath === null ||
        binding.value.workspaceId === null ||
        binding.value.paneId === null
      ) {
        return error("invalid_transition", "Activation requires an observed provisioning session");
      }
      if (!matchesRuntime(binding.value, identity.data)) {
        return error("identity_mismatch", "Runtime identity does not match the reserved role");
      }
      return saveBinding({
        ...binding.value,
        launchState: binding.value.initialization.state === "accepted" ? "ready" : "initializing",
      });
    });
  }

  function setLaunchState(id: string, state: Binding["launchState"]): Result<Binding> {
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (
        state === "ready" ||
        state === "initializing" ||
        state === "closing" ||
        state === "closed"
      )
        return error("invalid_transition", "Use the verified activation or close operation");
      if (binding.value.launchState === "closed" || binding.value.launchState === "closing")
        return error("invalid_transition", "A closing binding cannot be reopened");
      return saveBinding({ ...binding.value, launchState: state });
    });
  }

  function setContactState(id: string, state: Binding["contactState"]): Result<Binding> {
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (binding.value.contactState === "cancelled" && state !== "cancelled")
        return error("invalid_transition", "Cancelled contact cannot be restored");
      return saveBinding({ ...binding.value, contactState: state });
    });
  }

  function beginClose(id: string): Result<Binding> {
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok || binding.value.launchState === "closed") return binding;
      const child = db
        .query<{ readonly id: string }, [string]>(
          "SELECT id FROM bindings WHERE json_extract(json, '$.assignment.ownerBindingId') = ? AND launch_state <> 'closed' LIMIT 1",
        )
        .get(id);
      if (child !== null)
        return error("children_active", "Close child owners first", { bindingId: child.id });
      return saveBinding({ ...binding.value, launchState: "closing", contactState: "cancelled" });
    });
  }

  function finishClose(id: string): Result<Binding> {
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok || binding.value.launchState === "closed") return binding;
      if (binding.value.launchState !== "closing")
        return error("invalid_transition", "Closure was not started");
      return saveBinding({ ...binding.value, launchState: "closed" });
    });
  }

  function beginInitialization(id: string, text: string): Result<InitializationClaim> {
    if (text.length === 0) return error("invalid_input", "Initial instruction is empty");
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (binding.value.launchState !== "initializing" && binding.value.launchState !== "ready") {
        return error("invalid_transition", "Initialization requires verified runtime identity");
      }
      const initial = binding.value.initialization;
      if (initial.text !== null && initial.text !== text)
        return error("initialization_conflict", "Initial instruction is immutable");
      if (initial.state === "accepted")
        return ok({ disposition: "replay", binding: binding.value });
      if (initial.state === "rejected")
        return error(
          "brief_rejected",
          "Initial instruction was rejected; close this role before replacement",
        );
      if (initial.state !== "pending")
        return ok({ disposition: "in_progress", binding: binding.value });
      if (binding.value.contactState !== "active")
        return error("contact_paused", "Role is not accepting initialization");
      const saved = saveBinding({ ...binding.value, initialization: { state: "sending", text } });
      return saved.ok ? ok({ disposition: "new", binding: saved.value }) : saved;
    });
  }

  function finishInitialization(
    id: string,
    state: "accepted" | "rejected" | "uncertain",
  ): Result<Binding> {
    return transaction(() => {
      const binding = get(id);
      if (!binding.ok) return binding;
      if (binding.value.launchState === "closed" || binding.value.launchState === "closing") {
        return error("invalid_transition", "Closing roles cannot finish initialization");
      }
      const initial = binding.value.initialization;
      if (initial.state === "accepted") return binding;
      if (initial.state !== "sending" && initial.state !== "uncertain")
        return error("invalid_transition", "Initialization was not claimed");
      return saveBinding({
        ...binding.value,
        initialization: { state, text: initial.text },
        launchState:
          state === "accepted" && binding.value.launchState === "initializing"
            ? "ready"
            : binding.value.launchState,
      });
    });
  }

  function authorize(senderSessionId: string, envelopeValue: Envelope): Result<Binding> {
    const parsed = envelopeSchema.safeParse(envelopeValue);
    if (!parsed.success)
      return error("invalid_envelope", "Envelope is invalid", parsed.error.issues);
    const envelope = parsed.data;
    const sender = bySession(senderSessionId);
    if (!sender.ok) return error("sender_unknown", "Sender session is not bound");
    if (sender.value.id !== envelope.fromBindingId)
      return error("sender_forged", "Envelope sender does not match runtime identity");
    const target = get(envelope.toBindingId);
    if (!target.ok) return error("target_unknown", "Target binding was not found");
    const initializing =
      target.value.launchState === "initializing" &&
      target.value.initialization.state === "sending" &&
      envelope.kind === "instruction" &&
      envelope.id === initializationMessageId(target.value.id) &&
      envelope.text === target.value.initialization.text;
    if (
      sender.value.launchState !== "ready" ||
      (target.value.launchState !== "ready" && !initializing)
    )
      return error("not_ready", "Both route endpoints must be ready");
    if (sender.value.contactState !== "active" || target.value.contactState !== "active")
      return error("contact_paused", "A route endpoint is not accepting contact");
    if (
      sender.value.designationId !== target.value.designationId ||
      envelope.designationId !== sender.value.designationId
    ) {
      return error("foreign_designation", "Route crosses designation boundaries");
    }
    const designation = designationFor(sender.value.designationId);
    if (!designation.ok) return designation;
    if (envelope.snapshotDigest !== designation.value.snapshotDigest)
      return error("digest_mismatch", "Envelope snapshot is not designated");
    if (!designation.value.contact)
      return error("contact_denied", "Designation does not permit contact");
    if (envelope.kind === "instruction" && !designation.value.execute)
      return error("execute_denied", "Designation does not permit execution");
    if (sender.value.omoSocket !== target.value.omoSocket)
      return error("host_mismatch", "Bindings do not share the native host");
    if (envelope.kind === "report" && envelope.outcome === null)
      return error("invalid_envelope", "Reports require an outcome");
    if (envelope.kind !== "report" && envelope.outcome !== null)
      return error("invalid_envelope", "Only reports may carry an outcome");

    const from = sender.value.assignment;
    const to = target.value.assignment;
    const instruction =
      envelope.kind === "instruction" &&
      ((from.role === "supervisor" &&
        to.role === "parent" &&
        to.ownerBindingId === sender.value.id) ||
        (from.role === "parent" && to.role === "child" && to.ownerBindingId === sender.value.id));
    const report =
      envelope.kind === "report" &&
      ((from.role === "child" && to.role === "parent" && from.ownerBindingId === target.value.id) ||
        (from.role === "parent" &&
          to.role === "supervisor" &&
          from.ownerBindingId === target.value.id));
    const coordination =
      envelope.kind === "coordination" &&
      from.role === "parent" &&
      to.role === "parent" &&
      sender.value.id !== target.value.id &&
      from.initiativeId === to.initiativeId;
    if (!instruction && !report && !coordination)
      return error("route_denied", "Role route is not authorized");
    return ok(target.value);
  }

  function claim(senderSessionId: string, envelopeValue: Envelope): Result<ClaimResult> {
    return transaction(() => {
      const target = authorize(senderSessionId, envelopeValue);
      if (!target.ok) return target;
      const parsed = envelopeSchema.parse(envelopeValue);
      const existingRow = deliveryById.get(parsed.id);
      if (existingRow !== null) {
        const existing = parseDelivery(existingRow);
        if (!existing.ok) return existing;
        if (!same(existing.value.envelope, parsed))
          return error("message_conflict", "Message ID is bound to a different immutable payload");
        const disposition =
          existing.value.state === "accepted" || existing.value.state === "rejected"
            ? "replay"
            : "in_progress";
        return ok({ disposition, record: existing.value, target: target.value });
      }
      const record: DeliveryRecord = { envelope: parsed, state: "sending", receipt: null };
      db.query(
        "INSERT INTO deliveries (message_id, envelope_json, state, receipt_json) VALUES (?, ?, ?, NULL)",
      ).run(parsed.id, encoded(parsed), record.state);
      return ok({ disposition: "new", record, target: target.value });
    });
  }

  function finish(messageId: string, receiptValue: NativeReceipt): Result<DeliveryRecord> {
    const receipt = nativeReceiptSchema.safeParse(receiptValue);
    if (!receipt.success)
      return error("invalid_receipt", "Native receipt is invalid", receipt.error.issues);
    return transaction(() => {
      const current = parseDelivery(deliveryById.get(messageId));
      if (!current.ok) return current;
      if (current.value.state !== "sending") {
        if (current.value.receipt !== null && same(current.value.receipt, receipt.data))
          return current;
        return error("invalid_transition", "Only a sending delivery can be finished");
      }
      if (receipt.data.kind === "ok") {
        const target = get(current.value.envelope.toBindingId);
        if (!target.ok) return target;
        if (receipt.data.thread_id !== target.value.durableSessionId)
          return error("receipt_target_mismatch", "Receipt targets a different session");
      }
      const state = receipt.data.kind === "ok" ? "accepted" : "rejected";
      db.query("UPDATE deliveries SET state = ?, receipt_json = ? WHERE message_id = ?").run(
        state,
        encoded(receipt.data),
        messageId,
      );
      return ok({ envelope: current.value.envelope, state, receipt: receipt.data });
    });
  }

  function uncertain(messageId: string, reason: string): Result<DeliveryRecord> {
    if (reason.length === 0) return error("invalid_input", "Uncertainty reason is required");
    return transaction(() => {
      const current = parseDelivery(deliveryById.get(messageId));
      if (!current.ok) return current;
      if (current.value.state === "uncertain") return current;
      if (current.value.state !== "sending")
        return error("invalid_transition", "Only a sending delivery can become uncertain");
      db.query(
        "UPDATE deliveries SET state = 'uncertain', uncertain_reason = ? WHERE message_id = ?",
      ).run(reason, messageId);
      return ok({ ...current.value, state: "uncertain" });
    });
  }

  return {
    importScope,
    scope(digest: string): Result<ScopeSnapshot> {
      const row = scopeByDigest.get(digest);
      if (row === null) return error("not_found", "Scope was not found");
      return validateSnapshot(parseJson(row.json));
    },
    reserve,
    get,
    bySession,
    designation: designationFor,
    list(): Result<Binding[]> {
      try {
        const rows = db.query<JsonRow, []>("SELECT json FROM bindings ORDER BY id").all();
        const values: Binding[] = [];
        for (const row of rows) {
          const binding = parseBinding(row);
          if (!binding.ok) return binding;
          values.push(binding.value);
        }
        return ok(values);
      } catch (cause) {
        return error("storage_error", "Could not list bindings", messageOf(cause));
      }
    },
    provision,
    observeSession,
    activate,
    setLaunchState,
    setContactState,
    beginClose,
    finishClose,
    beginInitialization,
    finishInitialization,
    authorize,
    claim,
    finish,
    uncertain,
    delivery(messageId: string): Result<DeliveryRecord> {
      return parseDelivery(deliveryById.get(messageId));
    },
    close(): void {
      db.close();
    },
  };
}
