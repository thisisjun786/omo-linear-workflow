import type { Binding, ChildStage, ScopeSnapshot } from "../core/contracts";
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
  readonly stage?: ChildStage;
  readonly planPath?: string;
  readonly planHead?: string;
  readonly updateCheckLine?: string;
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
      "role: manager",
      "scope: unbound",
      "ask_user_directly: true",
      ...(options.updateCheckLine === undefined ? [] : [options.updateCheckLine]),
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
