import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Binding, Registry, Result } from "../core/contracts";
import { checkoutGit } from "./checkout";

export interface OpenPrInput {
  readonly fromId: string;
  readonly title?: string | undefined;
  readonly bodyFile?: string | undefined;
  readonly base?: string | undefined;
  readonly draft?: boolean | undefined;
}
const prSchema = z.object({
  number: z.number().int().positive(),
  url: z.url({ protocol: /^https$/ }),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isCrossRepository: z.boolean(),
});
const fields = "number,url,headRefName,baseRefName,headRefOid,state,isCrossRepository";
class PrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new PrError(result.error.code, result.error.message);
  return result.value;
}
async function gh(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn([process.env["OLW_GH_BIN"] ?? "gh", "pr", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // The binding's origin, not an inherited GH_REPO, selects the repository.
    env: { ...process.env, GH_REPO: undefined },
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new PrError("pr_command_failed", `gh pr failed (${code}): ${err.trim()}`);
  return out.trim();
}
function parentOf(registry: Registry, binding: Binding): Binding {
  const parent =
    binding.assignment.role === "child"
      ? value(registry.get(binding.assignment.ownerBindingId))
      : binding;
  if (parent.assignment.role !== "parent" || parent.checkout?.kind !== "owned-clone")
    throw new PrError(
      "pr_not_allowed",
      "PR helpers require an owned-clone parent; legacy bindings use local merges",
    );
  return parent;
}
function available(registry: Registry, binding: Binding): void {
  const approval = value(registry.designation(binding.designationId));
  if (binding.launchState !== "ready" || binding.contactState !== "active" || !approval.execute)
    throw new PrError(
      "pr_not_allowed",
      "PR operations require an active ready binding and execution approval",
    );
}
async function branchReady(binding: Binding): Promise<void> {
  if (
    !binding.checkout ||
    (await checkoutGit(binding.cwd, ["branch", "--show-current"])) !== binding.checkout.branch
  )
    throw new PrError("branch_mismatch", "Checkout is not on the binding branch");
  if ((await checkoutGit(binding.cwd, ["status", "--porcelain", "--untracked-files=no"])) !== "")
    throw new PrError("dirty_checkout", "Commit or restore tracked changes before PR operations");
  const origin = await checkoutGit(binding.cwd, ["remote", "get-url", "origin"]);
  if (origin !== binding.checkout.remote)
    throw new PrError("remote_mismatch", "Checkout origin differs from the binding remote");
}
async function push(binding: Binding): Promise<void> {
  const branch = binding.checkout?.branch;
  if (!branch) throw new PrError("pr_not_allowed", "Binding has no checkout");
  await checkoutGit(binding.cwd, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
}
async function attempt<T>(action: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: cause instanceof PrError ? cause.code : "pr_command_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

export function openPr(
  registry: Registry,
  input: OpenPrInput,
): Promise<Result<{ url: string; head: string }>> {
  return attempt(async () => {
    const binding = value(registry.get(input.fromId));
    const parent = parentOf(registry, binding);
    available(registry, binding);
    available(registry, parent);
    const child = binding.assignment.role === "child";
    if (child && (binding.deliverable ?? "pr") !== "pr")
      throw new PrError("pr_not_allowed", "Report/document children must not push or open PRs");
    if (child && value(registry.stageOf(binding.id))?.stage === "plan")
      throw new PrError(
        "pr_not_allowed",
        "The execute stage delivers the issue PR, not the plan stage",
      );
    const approval = value(registry.designation(binding.designationId));
    const snapshot = value(registry.scope(approval.snapshotDigest));
    const assignment = binding.assignment;
    const project = snapshot.projects.find(
      (p) =>
        assignment.role !== "manager" &&
        assignment.role !== "supervisor" &&
        p.project.id === assignment.projectId,
    );
    const base = child ? parent.checkout?.branch : project?.repository?.defaultBranch;
    if (!base || (input.base !== undefined && input.base !== base))
      throw new PrError(
        "base_mismatch",
        "PR base must be the parent integration branch or the project's default branch",
      );
    if (child && !input.bodyFile)
      throw new PrError(
        "invalid_arguments",
        "Child PR requires --body-file with issue key, verbatim criteria and evidence",
      );
    const body = input.bodyFile
      ? await readFile(input.bodyFile, "utf8")
      : `Project ${project?.project.key ?? project?.project.id}: integration ready for user review. Never automatically merge this project PR.`;
    const issue =
      assignment.role === "child"
        ? project?.issues.find((i) => i.id === assignment.issueId)
        : undefined;
    if (child && !body.includes(issue?.key ?? issue?.id ?? binding.id))
      throw new PrError(
        "invalid_arguments",
        "PR body must contain the issue key (or stable ID when no key is recorded)",
      );
    await branchReady(binding);
    if (child) {
      await branchReady(parent);
      await push(parent);
    }
    await push(binding);
    const head = await checkoutGit(binding.cwd, [
      "rev-parse",
      `refs/heads/${binding.checkout?.branch}`,
    ]);
    const branch = binding.checkout?.branch ?? "";
    const existing = z
      .array(prSchema)
      .parse(
        JSON.parse(
          await gh(binding.cwd, ["list", "--state", "open", "--head", branch, "--json", fields]),
        ),
      );
    if (existing.length > 1)
      throw new PrError("pr_conflict", "Multiple open PRs claim this branch");
    const pr = existing[0];
    if (pr) {
      if (pr.baseRefName !== base || pr.isCrossRepository || pr.headRefOid !== head)
        throw new PrError(
          "pr_conflict",
          "Existing PR does not match the expected base and pushed head",
        );
      return { url: pr.url, head };
    }
    const url = await gh(binding.cwd, [
      "create",
      "--base",
      base,
      "--head",
      branch,
      "--title",
      input.title ??
        `${issue?.key ?? issue?.id ?? project?.project.key ?? project?.project.id}: delivery`,
      "--body",
      body,
      ...(input.draft ? ["--draft"] : []),
    ]);
    return { url: z.url({ protocol: /^https$/ }).parse(url), head };
  });
}

export function mergePr(
  registry: Registry,
  parentId: string,
  reference: string,
): Promise<Result<{ url: string; head: string }>> {
  return attempt(async () => {
    const parent = value(registry.get(parentId));
    if (parent.assignment.role !== "parent")
      throw new PrError("pr_not_allowed", "Only the parent integrates child PRs");
    parentOf(registry, parent);
    available(registry, parent);
    await branchReady(parent);
    const number = /^\d+$/.test(reference) ? reference : /\/pull\/(\d+)$/.exec(reference)?.[1];
    if (!number) throw new PrError("invalid_arguments", "--pr must be a PR URL or number");
    const pr = prSchema.parse(JSON.parse(await gh(parent.cwd, ["view", number, "--json", fields])));
    if (reference !== number && reference !== pr.url)
      throw new PrError("pr_conflict", "PR URL does not belong to the binding's origin repository");
    if (pr.baseRefName !== parent.checkout?.branch || pr.isCrossRepository)
      throw new PrError(
        "base_mismatch",
        "PR must target this parent's integration branch from the same repository",
      );
    const children = value(registry.list()).filter(
      (b) =>
        b.assignment.role === "child" &&
        b.assignment.ownerBindingId === parent.id &&
        b.checkout?.branch === pr.headRefName &&
        (b.deliverable ?? "pr") === "pr",
    );
    const report = value(registry.childReports(parent.id)).find(
      (record) =>
        children.some((child) => child.id === record.envelope.fromBindingId) &&
        record.envelope.delivery?.kind === "pr" &&
        record.envelope.delivery.url === pr.url,
    );
    const delivery = report?.envelope.delivery;
    if (
      report?.envelope.outcome !== "completed" ||
      delivery?.kind !== "pr" ||
      delivery.url !== pr.url
    )
      throw new PrError("report_missing", "No accepted completed child report for this PR");
    if (delivery.head !== pr.headRefOid)
      throw new PrError(
        "head_mismatch",
        "PR head differs from the child's reported head; review and request a new report",
      );
    // Publish any parent work first. A diverged integration branch fails before remote merge.
    // A retry after remote merge must fetch first, not attempt a stale non-fast-forward push.
    if (pr.state === "OPEN") {
      await push(parent);
      await gh(parent.cwd, ["merge", number, "--merge", "--match-head-commit", delivery.head]);
      const merged = prSchema.parse(
        JSON.parse(await gh(parent.cwd, ["view", number, "--json", fields])),
      );
      if (merged.state !== "MERGED")
        throw new PrError(
          "merge_pending",
          "GitHub has not merged the PR (it may be queued); integration has not been claimed complete",
        );
    } else if (pr.state !== "MERGED")
      throw new PrError("pr_closed", "PR is closed without merging");
    await checkoutGit(parent.cwd, ["fetch", "--prune", "origin"]);
    await checkoutGit(parent.cwd, [
      "merge",
      "--ff-only",
      `refs/remotes/origin/${parent.checkout?.branch}`,
    ]);
    await push(parent);
    return { url: pr.url, head: await checkoutGit(parent.cwd, ["rev-parse", "HEAD"]) };
  });
}
