import type { Binding, ChildStage, Result, ScopeSnapshot } from "../core/contracts";
import { digestOf } from "./scope";

function scopeRefs(binding: Binding, snapshot: ScopeSnapshot): string {
  const lines: string[] = [];
  lines.push(`  initiative_id: ${snapshot.initiative?.id ?? "null"}`);

  const assignment = binding.assignment;
  if (assignment.role === "supervisor") {
    lines.push(
      `  projects: ${JSON.stringify(snapshot.projects.map((entry) => ({ project_id: entry.project.id, issue_ids: entry.issues.map((issue) => issue.id) })))}`,
    );
  } else if (assignment.role === "parent") {
    const entry = snapshot.projects.find((p) => p.project.id === assignment.projectId);
    if (entry !== undefined) {
      lines.push(`  project_id: ${entry.project.id}`);
      lines.push(`  issue_ids: ${JSON.stringify(entry.issues.map((issue) => issue.id))}`);
    }
  } else if (assignment.role === "child") {
    const entry = snapshot.projects.find((p) => p.project.id === assignment.projectId);
    const issue = entry?.issues.find((i) => i.id === assignment.issueId);
    if (entry !== undefined) {
      lines.push(`  project_id: ${entry.project.id}`);
    }
    if (issue !== undefined) {
      lines.push(`  issue_id: ${issue.id}`);
    }
  }

  return lines.join("\n");
}

function roleBehavior(role: Binding["assignment"]["role"]): string {
  const lines: string[] = [];
  lines.push("behavior:");
  if (role === "manager") {
    lines.push("  applies_when: handling an OLW message; otherwise act as a normal assistant");
    lines.push("  scope: unbound");
    lines.push("  ask_user_directly: true");
    lines.push("  manage_linked_parents: true");
  } else if (role === "supervisor") {
    lines.push("  scope: one explicitly designated initiative");
    lines.push("  instruct_parents: true");
    lines.push("  accept_reports_from_parents: true");
    lines.push("  do_not_implement_directly: true");
  } else if (role === "parent") {
    lines.push("  scope: one designated project");
    lines.push("  instruct_children: true");
    lines.push("  report_route: current_manager_or_user_inbox");
    lines.push("  user_report_command: report --to-user");
    lines.push("  user_inbox_command: reports --project");
    lines.push("  recheck_management_link_in_status: true");
    lines.push("  management_link_changes_approval: false");
    lines.push("  peer_coordination: true");
  } else {
    lines.push("  scope: one designated issue");
    lines.push("  report_to_parent: true");
    lines.push("  implement_only_this_issue: true");
    lines.push("  execution_mode: mass-ulw");
    lines.push("  execution_trigger: explicit_issue_packet");
    lines.push("  execution_skills: [olw-run, mass-ulw]");
    lines.push("  internal_workers: native_workflow_nodes_not_roles");
    lines.push("  issue_goal: packet_bound");
    lines.push("  verify_artifacts_before_report: true");
  }
  lines.push("  wait_for_explicit_instruction: true");
  if (role !== "child") lines.push("  no_autonomous_goal_loop: true");
  return lines.join("\n");
}

export interface RoleBriefOptions {
  readonly owner?: Result<Binding>;
  readonly stage?: ChildStage;
  readonly planPath?: string;
  readonly planHead?: string;
  readonly updateCheckLine?: string;
  readonly routingAdviceLine?: string;
  readonly includeParentGuidance?: boolean;
  readonly includeManagerGuidance?: boolean;
}

export function buildRoleBrief(
  binding: Binding,
  snapshot: ScopeSnapshot,
  options: RoleBriefOptions = {},
): string {
  const qaStandby = snapshot.source === "fixture";
  const stage = binding.assignment.role === "child" ? options.stage : undefined;
  const parts: string[] = [
    `source: ${snapshot.source}`,
    `binding_id: ${binding.id}`,
    `designation_id: ${binding.designationId}`,
    `snapshot_digest: ${digestOf(snapshot)}`,
    `durable_session_id: ${binding.durableSessionId}`,
    `role: ${binding.assignment.role}`,
    ...(stage === undefined ? [] : [`stage: ${stage}`]),
    "scope_refs:",
    scopeRefs(binding, snapshot),
    roleBehavior(binding.assignment.role),
  ];

  if (binding.assignment.role === "parent") {
    parts.push(
      `initial_manager_binding_id: ${binding.assignment.ownerBindingId ?? "null"}`,
      "user_contact: direct_prompt_in_this_session",
      "user_report_state: posted_not_native_acceptance",
    );
  }

  if (stage !== undefined) {
    parts.push(
      "your_user: parent",
      "questions: olw_ask only (batch up to 4 per call with options and a recommended default); prose in the pane reaches nobody",
      "answer_delivery: Answers arrive as native deliveries; end your turn while waiting. Never act on answers read through olw questions; that view is inspection only.",
      "mode_mismatch: report blocked without work",
    );
    if (stage === "plan") {
      parts.push(
        "execution_skills: [olw-run, ulw-plan]",
        "plan_review: plan-reviewer rounds as ulw-plan requires",
        `plan_path: ${options.planPath ?? ".omo/plans/<issue-key>.md"}`,
        ...(options.planHead === undefined ? [] : [`plan_head: ${options.planHead}`]),
        "approval: ask the parent with olw_ask; never wait for a user",
        "on_approval: olw stage complete",
        "no_plan_needed: report blocked with reason no_plan_needed; the parent recreates the child with --mode direct",
      );
    } else if (stage === "execute") {
      parts.push(
        "execution_skills: [olw-run, ulw-execute, mass-ulw]",
        `plan_path: ${options.planPath ?? ".omo/plans/<issue-key>.md"}`,
        ...(options.planHead === undefined ? [] : [`plan_head: ${options.planHead}`]),
        "report_once: report:<packet-id>",
      );
    } else if (stage === "direct") {
      parts.push(
        "execution_mode: mass-ulw",
        "execution_trigger: explicit_issue_packet",
        "execution_skills: [olw-run, mass-ulw]",
        "internal_workers: native_workflow_nodes_not_roles",
        "issue_goal: packet_bound",
        "verify_artifacts_before_report: true",
      );
    } else {
      parts.push("execution_skills: [olw-run, ulw-research, mass-ulw]");
    }
  } else if (binding.assignment.role === "parent" && options.includeParentGuidance === true) {
    parts.push(
      "child_modes: direct|planned|research (chosen at child create)",
      "answer_child_questions: olw answer, one answer per question",
      "approve_child_plans: true",
      "start_execute_stage: olw stage start after approval",
      "escalate_to: manager via olw ask (inbox when no ready manager)",
    );
  } else if (binding.assignment.role === "manager" && options.includeManagerGuidance === true) {
    parts.push(
      "scope: unbound",
      "ask_user_directly: true",
      "olw_messages: Read details with olw reports or olw questions --project ID; use the envelope ID for correlation.",
      "olw_answers: Answer a parent with olw answer --from BINDING --question ID --text-file PATH.",
      "olw_approval: Review evidence against approved scope before accepting work; a management link never grants execution approval.",
      "olw_escalation: Ask the user directly when a decision exceeds existing approval; do not expand scope on their behalf.",
      ...(options.updateCheckLine === undefined ? [] : [options.updateCheckLine]),
      ...(options.routingAdviceLine === undefined ? [] : [options.routingAdviceLine]),
    );
  }

  const ownedParent =
    binding.assignment.role === "parent"
      ? binding.checkout?.kind === "owned-clone"
      : options.owner?.ok && options.owner.value.checkout?.kind === "owned-clone";
  // Calls without stage metadata retain the byte-identical legacy brief.
  if (binding.assignment.role === "child" && (stage !== undefined || ownedParent)) {
    const deliverable = binding.deliverable ?? (stage === "research" ? "report" : "pr");
    parts.push(`deliverable: ${deliverable}`);
    if (stage === "plan")
      parts.push(
        "delivery_policy: Hand off the approved plan with olw stage complete; never push or open a PR in the plan stage. The execute stage delivers the issue.",
      );
    else if (deliverable !== "pr")
      parts.push(
        "delivery_policy: No push and no PR. Return an explicit evidence file path or Linear document URL with report --deliverable-path PATH.",
        "code_changes: If needed, propose a new direct issue to the parent; do not implement it here.",
      );
    else if (ownedParent)
      parts.push(
        `integration_branch: ${binding.checkout?.baseBranch}`,
        "delivery_policy: One issue = one PR. After the execute/direct stage, push the child branch to origin and open a PR into the parent integration branch with olw pr open --from BINDING --body-file FILE.",
        "pr_body: Include the issue key, verbatim acceptance criteria, and evidence. Respect packet delivery limits; report blocked if publication is forbidden.",
        "final_report: Report once with report --pr URL --head SHA and criterion evidence. Never merge or modify the parent branch. A plan stage hands off its plan instead of opening a PR.",
      );
    else
      parts.push(
        "delivery_policy: Deprecated legacy flow - return the local head and evidence for the parent to merge locally; no PR helper.",
      );
  } else if (
    binding.assignment.role === "parent" &&
    (ownedParent || options.includeParentGuidance === true)
  ) {
    parts.push(
      ownedParent
        ? "integration_policy: Review each child PR at its reported head against verbatim criteria and evidence, then olw pr merge --from PARENT --pr URL. This uses a merge commit, fetches and fast-forwards the integration branch, and pushes without force. Do not merge child branches locally."
        : "integration_policy: Deprecated legacy flow - review the child's head and evidence and merge the child branch locally into the integration worktree.",
    );
    if (ownedParent)
      parts.push(
        "project_finish: olw pr open --from PARENT --base DEFAULT_BRANCH; report its URL and stop for the user. Never merge the project PR.",
      );
  }

  if (qaStandby) {
    parts.push(
      "qa_standby: true",
      "respond_only_to_explicit_messages: true",
      "never_fetch_live_linear: true",
      binding.assignment.role === "child"
        ? "never_create_additional_olw_roles: true"
        : "never_create_additional_sessions: true",
      "never_implement_repository_work_autonomously: true",
    );
  }

  return parts.join("\n");
}
