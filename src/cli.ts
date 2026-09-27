#!/usr/bin/env bun
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Result, ScopeFilter } from "./core/contracts";
import { canRetryDelivery } from "./core/policy";
import {
  answerFieldsSchema,
  deliverableSchema,
  deliveryRecordSchema,
  questionPayloadSchema,
} from "./core/schema";
import { openRegistry } from "./core/store";
import { resolveHerdrArtifact } from "./herdr/artifact";
import { Orchestrator, type OrchestratorDependencies } from "./orchestrator";
import { readChainReport } from "./proxy/chain-check";
import { fetchMirror, listMirrors, MirrorError } from "./repo/mirror";

type Options = Readonly<Record<string, string | true | readonly string[]>>;
const valueFlags = new Set([
  "root",
  "herdr-socket",
  "file",
  "initiative",
  "scope-digest",
  "designation",
  "supervisor",
  "project",
  "repo",
  "base",
  "parent",
  "issue",
  "from",
  "to",
  "id",
  "kind",
  "text-file",
  "outcome",
  "evidence",
  "binding",
  "mode",
  "question",
  "questions-file",
  "answers-file",
  "plan",
  "head",
  "stage",
  "tag",
  "remote",
  "deliverable",
  "deliverable-path",
  "pr",
  "title",
  "body-file",
]);
const booleanFlags = new Set([
  "json",
  "fixture",
  "execute",
  "help",
  "confirm-absent",
  "to-user",
  "as-user",
  "no-manager",
  "here",
  "draft",
  "discard",
]);

function parseArguments(
  argv: readonly string[],
): Result<{ readonly words: string[]; readonly options: Options }> {
  const words: string[] = [];
  const mutable: Record<string, string | true | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      mutable[key] = true;
      continue;
    }
    if (!valueFlags.has(key))
      return {
        ok: false,
        error: { code: "invalid_arguments", message: `Unknown option --${key}` },
      };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return {
        ok: false,
        error: { code: "invalid_arguments", message: `Option --${key} requires a value` },
      };
    index += 1;
    if (key === "evidence" || key === "tag") {
      const current = mutable[key];
      mutable[key] = Array.isArray(current) ? [...current, value] : [value];
    } else mutable[key] = value;
  }
  return { ok: true, value: { words, options: mutable } };
}

function stringOption(options: Options, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}
function has(options: Options, key: string): boolean {
  return options[key] === true;
}
function evidence(options: Options): readonly string[] {
  const value = options["evidence"];
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}
async function jsonFile<T>(
  path: string | undefined,
  schema: z.ZodType<T>,
  flag: string,
): Promise<Result<T | undefined>> {
  if (path === undefined) return { ok: true, value: undefined };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    return invalid(
      `Could not read ${flag}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : invalid(`${flag} is invalid`, parsed.error.issues);
}
function invalid(message: string, details?: unknown): Result<never> {
  return details === undefined
    ? { ok: false, error: { code: "invalid_arguments", message } }
    : { ok: false, error: { code: "invalid_arguments", message, details } };
}
async function text(path: string | undefined): Promise<Result<string>> {
  if (path === undefined) return invalid("--text-file is required");
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch (cause) {
    return invalid(
      `Could not read --text-file: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
function exitCode(result: Result<unknown>): number {
  if (result.ok) return 0;
  if (result.error.code.includes("uncertain") || result.error.code === "delivery_in_progress")
    return 4;
  if (result.error.code === "runtime_unavailable") return 3;
  if (result.error.code === "interrupted") return 130;
  return 2;
}
function deliveryOutcome(result: Result<unknown>): Result<unknown> {
  if (!result.ok && result.error.code !== "delivery_in_progress") return result;
  const parsed = deliveryRecordSchema.safeParse(result.ok ? result.value : result.error.details);
  if (!parsed.success || parsed.data.state === "accepted" || parsed.data.state === "posted")
    return result;
  const delivery = parsed.data;
  const rejected = delivery.state === "rejected";
  const retryable = canRetryDelivery(delivery);
  return {
    ok: false,
    error: {
      code: result.ok ? (rejected ? "delivery_rejected" : "delivery_uncertain") : result.error.code,
      message: rejected
        ? "Command processed, but native delivery returned a rejection; the instruction is not confirmed accepted."
        : "Native delivery is pending or uncertain; the instruction is not confirmed accepted.",
      details: {
        delivery,
        recovery: retryable ? "retry_same_id" : "inspect_before_retry",
        next_action: retryable
          ? "Native delivery was rejected before invoking the target. Repeat the identical command with the same --id and payload to recheck current authorization and allocate one successor attempt. Earlier keys and receipts remain in delivery.attempts."
          : "Run olw status to resolve the target binding to its durableSessionId, then inspect that native session's transcript, pending queue, and delivery receipts. " +
            (rejected
              ? "Repeating this command with the same --id only replays the stored rejection. "
              : "Do not resend while acceptance is unresolved. ") +
            "Do not use a new --id unless authoritative reconciliation proves non-acceptance. Legacy turn_conflict receipts can also follow a lost acknowledgement, so that code alone is not proof of non-delivery.",
      },
    },
  };
}

function print(result: Result<unknown>, json: boolean): void {
  if (json || !result.ok) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
}

const required = z.string().min(1);
function requireOptions(options: Options, keys: readonly string[]): Result<Record<string, string>> {
  const collected: Record<string, string> = {};
  for (const key of keys) {
    const parsed = required.safeParse(stringOption(options, key));
    if (!parsed.success) return invalid(`--${key} is required`, parsed.error.issues);
    collected[key] = parsed.data;
  }
  return { ok: true, value: collected };
}

function scopeFilter(options: Options, required: boolean): Result<ScopeFilter> {
  const initiativeId = stringOption(options, "initiative");
  const projectId = stringOption(options, "project");
  if (initiativeId !== undefined && projectId !== undefined)
    return invalid("Choose --initiative or --project, not both");
  if (projectId !== undefined) return { ok: true, value: { projectId } };
  if (initiativeId !== undefined) return { ok: true, value: { initiativeId } };
  return required ? invalid("--initiative or --project is required") : { ok: true, value: {} };
}

async function doctor(
  root: string,
  herdrSocket?: string,
): Promise<Result<{ sideEffects: false; paths: unknown; checks: unknown }>> {
  const paths = new Orchestrator(root, herdrSocket).paths();
  const database = join(root, ".omo/state/registry.sqlite");
  if (await Bun.file(database).exists()) {
    const registry = openRegistry(database, { readonly: true });
    try {
      const bindings = registry.list();
      if (!bindings.ok) return bindings;
      const legacyParents = bindings.value
        .filter(
          (binding) =>
            binding.assignment.role === "parent" &&
            binding.launchState !== "closed" &&
            binding.checkout?.kind !== "owned-clone",
        )
        .map((binding) => ({
          bindingId: binding.id,
          projectId: binding.assignment.role === "parent" ? binding.assignment.projectId : null,
          cwd: binding.cwd,
          workspaceId: binding.workspaceId,
          checkoutKind: binding.checkout?.kind ?? "legacy",
        }));
      if (legacyParents.length > 0)
        return {
          ok: false,
          error: {
            code: "legacy_parents_remaining",
            message:
              "Official Herdr switch blocked: legacy parents remain. Resolve the listed linked-worktree parents with user approval before switching servers.",
            details: { legacyParents },
          },
        };
    } finally {
      registry.close();
    }
  }
  const herdr = await resolveHerdrArtifact(root);
  const checks = {
    bun: process.execPath,
    omo: Bun.which(join(root, "node_modules/.bin/omo")),
    herdr: herdr.binaryPath,
    git: Bun.which("git"),
    extension: join(root, "dist/extension/index.js"),
  };
  try {
    await access(checks.extension);
  } catch {
    return {
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: "Built extension is missing; run bun run build",
        details: { paths, checks },
      },
    };
  }
  if (checks.omo === null || checks.git === null) {
    return {
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: "Required executable is unavailable",
        details: { paths, checks },
      },
    };
  }
  return { ok: true, value: { sideEffects: false, paths, checks } };
}

async function doctorWithChains(root: string, herdrSocket?: string): Promise<Result<unknown>> {
  const repositories = await listMirrors(root);
  const result = await doctor(root, herdrSocket);
  if (!result.ok) return result;
  const home = process.env["HOME"] ?? homedir();
  const value = { ...result.value, repositories, chains: {} as unknown };
  try {
    const chains = await readChainReport({
      configPath: join(home, ".omo/omo.jsonc"),
      catalogPath: join(home, ".omo/agent/models.json"),
      stateDir: join(home, ".omo/proxy-routing"),
    });
    value.chains = chains;
    return { ok: true, value };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: `OMO model chains are unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
        details: value,
      },
    };
  }
}

export async function runCli(
  argv: readonly string[],
  dependencies?: OrchestratorDependencies,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    print(parsed, true);
    return 2;
  }
  const { words, options } = parsed.value;
  if (has(options, "help") || words.join(" ") === "help") {
    print(
      {
        ok: true,
        value: {
          usage: "olw [--root PATH] [--herdr-socket PATH] COMMAND [OPTIONS] [--json]",
          commands: [
            "doctor",
            "manage",
            "update check",
            "update prepare",
            "scope import",
            "repo list",
            "repo fetch",
            "supervisor create",
            "parent create",
            "parent link",
            "parent unlink",
            "child create",
            "pr open",
            "pr merge",
            "stage complete",
            "stage start",
            "send",
            "report",
            "reports",
            "ask",
            "answer",
            "questions",
            "notices",
            "status",
            "pause",
            "resume",
            "close",
            "reconcile",
          ],
          deprecatedOptions: { "parent create": ["--repo"] },
          options: {
            manage: "[--here] [--json] (bare olw runs here; requires Herdr)",
            "update check": "[--tag omo-ai=beta] [--tag @code-yeongyu/senpi=latest] [--json]",
            "update prepare":
              "[--remote NAME|URL] [--json] (PR to dev for the latest check's versions; OLW_GH_BIN overrides gh)",
            "scope import": "--file PATH [--fixture]",
            "repo list": "[--json]",
            "repo fetch": "--remote URL [--json]",
            "supervisor create":
              "--initiative ID --scope-digest DIGEST --designation ID --execute [--fixture]",
            "parent create":
              "(--supervisor BINDING | --scope-digest DIGEST --designation ID --execute [--fixture] [--no-manager]) --project ID [--repo PATH (deprecated; rejected with legacy_parent_unsupported)] [--base REF] (mapped projects use an owned clone; standalone parents link to the ready manager unless --no-manager)",
            "parent link": "--parent BINDING --supervisor BINDING (supervisor or manager)",
            "parent unlink": "--parent BINDING",
            "child create":
              "--parent BINDING --issue ID [--mode direct|planned|research] [--deliverable pr|report|document]",
            "pr open":
              "--from BINDING [--title T] --body-file F [--draft] [--base DEFAULT_BRANCH (parent only; body optional)] [--json]",
            "pr merge": "--from PARENT --pr URL|NUMBER [--json]",
            "stage complete":
              "--from PLAN_BINDING --plan ABS_PATH --head SHA --id MESSAGE_ID --text-file PATH",
            "stage start":
              "--from PLAN_BINDING --parent PARENT_BINDING --stage execute --id MESSAGE_ID",
            send: "--from BINDING --to BINDING --id ID --kind instruction|coordination --text-file PATH",
            report:
              "--from BINDING --id ID --outcome completed|blocked|failed --text-file PATH [--evidence REF] [--pr URL --head SHA | --deliverable-path PATH_OR_URL] [--to-user]",
            reports:
              "[--initiative ID | --project ID] (read-only user inbox and manager reports; posted is not native acceptance)",
            ask: "--from BINDING --id ID --text-file PATH [--questions-file JSON] [--to-user]",
            answer:
              "(--from BINDING | --as-user) --question QUESTION_ID --text-file PATH [--answers-file JSON]",
            questions: "[--initiative ID | --project ID] (read-only; never wakes a role)",
            notices:
              "[--initiative ID | --project ID] (read-only operational telemetry; not completion reports)",
            status: "[--initiative ID | --project ID]",
            pause: "--binding ID",
            resume: "--binding ID",
            close: "--binding ID [--confirm-absent] [--discard]",
            reconcile: "--initiative ID | --project ID",
          },
        },
      },
      has(options, "json"),
    );
    return 0;
  }
  const root = resolve(stringOption(options, "root") ?? join(import.meta.dir, ".."));
  const orchestrator = new Orchestrator(root, stringOption(options, "herdr-socket"), dependencies);
  let result: Result<unknown> | undefined;
  const command = words.join(" ");
  try {
    if (command === "update check") {
      const tags: Record<string, string> = {};
      const rawTags = options["tag"];
      for (const raw of Array.isArray(rawTags)
        ? rawTags
        : typeof rawTags === "string"
          ? [rawTags]
          : []) {
        const split = raw.indexOf("=");
        const tagValue = split < 0 ? "" : raw.slice(split + 1);
        if (
          split < 1 ||
          split !== raw.lastIndexOf("=") ||
          split === raw.length - 1 ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tagValue)
        ) {
          result = invalid("--tag must be PACKAGE=TAG with a valid dist-tag");
          break;
        }
        const name = raw.slice(0, split);
        if (name !== "omo-ai" && name !== "@code-yeongyu/senpi") {
          result = invalid(`Unsupported package tag ${name}`);
          break;
        }
        tags[name] = raw.slice(split + 1);
      }
      if (result === undefined) result = await orchestrator.updateCheck(tags);
    } else if (command === "update prepare") {
      const remote = stringOption(options, "remote");
      result = await orchestrator.updatePrepare(remote === undefined ? {} : { remote });
    } else if (command === "doctor") {
      result = await doctorWithChains(root, stringOption(options, "herdr-socket"));
    } else if (command === "repo list") {
      result = { ok: true, value: await listMirrors(root) };
    } else if (command === "repo fetch") {
      const values = requireOptions(options, ["remote"]);
      result = values.ok
        ? { ok: true, value: await fetchMirror(root, values.value["remote"] ?? "") }
        : values;
    } else if (command === "manage" || command === "") {
      const managed = await orchestrator.manage({ here: command === "" || has(options, "here") });
      if (managed.ok && managed.value.tuiExited !== undefined) return await managed.value.tuiExited;
      result = managed;
    } else if (command === "scope import") {
      const values = requireOptions(options, ["file"]);
      result = values.ok
        ? await orchestrator.importScope(values.value["file"] ?? "", has(options, "fixture"))
        : values;
    } else if (command === "supervisor create") {
      const values = requireOptions(options, ["initiative", "scope-digest", "designation"]);
      result = values.ok
        ? await orchestrator.createSupervisor({
            initiativeId: values.value["initiative"] ?? "",
            scopeDigest: values.value["scope-digest"] ?? "",
            designationId: values.value["designation"] ?? "",
            execute: has(options, "execute"),
            fixture: has(options, "fixture"),
          })
        : values;
    } else if (command === "parent create") {
      const supervisorId = stringOption(options, "supervisor");
      const standaloneFlags = [
        "scope-digest",
        "designation",
        "execute",
        "fixture",
        "no-manager",
      ].some((key) => options[key] !== undefined);
      const values = requireOptions(options, [
        "project",
        ...(supervisorId === undefined ? ["scope-digest", "designation"] : []),
      ]);
      if (supervisorId !== undefined && standaloneFlags)
        result = invalid("--supervisor cannot be combined with standalone approval flags");
      else if (!values.ok) result = values;
      else {
        const location = {
          projectId: values.value["project"] ?? "",
          ...(stringOption(options, "repo") === undefined
            ? {}
            : { repo: stringOption(options, "repo") }),
          ...(stringOption(options, "base") === undefined
            ? {}
            : { base: stringOption(options, "base") }),
        };
        result = await orchestrator.createParent(
          supervisorId !== undefined
            ? { ...location, supervisorId }
            : {
                ...location,
                scopeDigest: values.value["scope-digest"] ?? "",
                designationId: values.value["designation"] ?? "",
                execute: has(options, "execute"),
                fixture: has(options, "fixture"),
                ...(has(options, "no-manager") ? { noManager: true } : {}),
              },
        );
      }
    } else if (command === "parent link" || command === "parent unlink") {
      const values = requireOptions(
        options,
        command === "parent link" ? ["parent", "supervisor"] : ["parent"],
      );
      result = values.ok
        ? command === "parent link"
          ? orchestrator.linkParent(values.value["parent"] ?? "", values.value["supervisor"] ?? "")
          : orchestrator.unlinkParent(values.value["parent"] ?? "")
        : values;
    } else if (command === "pr open") {
      const values = requireOptions(options, ["from"]);
      result = values.ok
        ? await orchestrator.prOpen({
            fromId: values.value["from"] ?? "",
            title: stringOption(options, "title"),
            bodyFile: stringOption(options, "body-file"),
            base: stringOption(options, "base"),
            draft: has(options, "draft"),
          })
        : values;
    } else if (command === "pr merge") {
      const values = requireOptions(options, ["from", "pr"]);
      result = values.ok
        ? await orchestrator.prMerge(values.value["from"] ?? "", values.value["pr"] ?? "")
        : values;
    } else if (command === "child create") {
      const values = requireOptions(options, ["parent", "issue"]);
      const mode = values.ok
        ? z
            .enum(["direct", "planned", "research"])
            .default("direct")
            .safeParse(stringOption(options, "mode"))
        : undefined;
      const deliverable = deliverableSchema
        .optional()
        .safeParse(stringOption(options, "deliverable"));
      result = !deliverable.success
        ? invalid("--deliverable must be pr, report, or document")
        : values.ok && mode?.success
          ? await orchestrator.createChild({
              parentId: values.value["parent"] ?? "",
              issueId: values.value["issue"] ?? "",
              mode: mode.data,
              deliverable: deliverable.data,
            })
          : !values.ok
            ? values
            : invalid("--mode must be direct, planned, or research");
    } else if (command === "stage complete") {
      const values = requireOptions(options, ["from", "plan", "head", "id", "text-file"]);
      const body = values.ok
        ? await text(values.value["text-file"])
        : invalid("--text-file is required");
      result =
        values.ok && body.ok
          ? await orchestrator.stageComplete({
              fromId: values.value["from"] ?? "",
              planPath: values.value["plan"] ?? "",
              head: values.value["head"] ?? "",
              messageId: values.value["id"] ?? "",
              text: body.value,
            })
          : values.ok
            ? body
            : values;
    } else if (command === "stage start") {
      const values = requireOptions(options, ["from", "parent", "stage", "id"]);
      result =
        values.ok && values.value["stage"] === "execute"
          ? await orchestrator.stageStart({
              fromId: values.value["from"] ?? "",
              stage: "execute",
              parentId: values.value["parent"] ?? "",
              messageId: values.value["id"] ?? "",
            })
          : values.ok
            ? invalid("--stage must be execute")
            : values;
    } else if (command === "send") {
      const values = requireOptions(options, ["from", "to", "id", "kind", "text-file"]);
      const kind = values.ok
        ? z.enum(["instruction", "coordination"]).safeParse(values.value["kind"])
        : undefined;
      const body = values.ok
        ? await text(values.value["text-file"])
        : invalid("--text-file is required");
      result =
        values.ok && kind?.success && body.ok
          ? await orchestrator.send({
              fromId: values.value["from"] ?? "",
              toId: values.value["to"] ?? "",
              messageId: values.value["id"] ?? "",
              kind: kind.data,
              text: body.value,
            })
          : !values.ok
            ? values
            : !body.ok
              ? body
              : invalid("--kind must be instruction or coordination");
    } else if (command === "report") {
      const values = requireOptions(options, ["from", "id", "outcome", "text-file"]);
      const outcome = values.ok
        ? z.enum(["completed", "blocked", "failed"]).safeParse(values.value["outcome"])
        : undefined;
      const body = values.ok
        ? await text(values.value["text-file"])
        : invalid("--text-file is required");
      const pr = stringOption(options, "pr");
      const head = stringOption(options, "head");
      const path = stringOption(options, "deliverable-path");
      const source = values.ok ? orchestrator.status() : undefined;
      const from = stringOption(options, "from");
      const binding = source?.ok ? source.value.find((b) => b.id === from) : undefined;
      const kind = binding?.deliverable;
      result =
        (pr === undefined) !== (head === undefined) || (path !== undefined && pr !== undefined)
          ? invalid("Use --pr URL with --head SHA, or --deliverable-path PATH")
          : path !== undefined && kind !== "report" && kind !== "document"
            ? invalid("--deliverable-path requires a report/document binding")
            : values.ok && outcome?.success && body.ok
              ? await orchestrator.report({
                  fromId: values.value["from"] ?? "",
                  messageId: values.value["id"] ?? "",
                  outcome: outcome.data,
                  toUser: has(options, "to-user"),
                  evidence: evidence(options),
                  text: body.value,
                  ...(pr !== undefined && head !== undefined
                    ? { delivery: { kind: "pr", url: pr, head } as const }
                    : path !== undefined && (kind === "report" || kind === "document")
                      ? { delivery: { kind, path } }
                      : {}),
                })
              : !values.ok
                ? values
                : !body.ok
                  ? body
                  : invalid("--outcome must be completed, blocked, or failed");
    } else if (command === "ask") {
      const values = requireOptions(options, ["from", "id", "text-file"]);
      const body = values.ok ? await text(values.value["text-file"]) : invalid("");
      const questions = await jsonFile(
        stringOption(options, "questions-file"),
        questionPayloadSchema,
        "--questions-file",
      );
      result =
        values.ok && body.ok && questions.ok
          ? await orchestrator.ask({
              fromId: values.value["from"] ?? "",
              messageId: values.value["id"] ?? "",
              text: body.value,
              toUser: has(options, "to-user"),
              questions: questions.value,
            })
          : !values.ok
            ? values
            : !body.ok
              ? body
              : questions;
    } else if (command === "answer") {
      const values = requireOptions(options, ["question", "text-file"]);
      const body = values.ok ? await text(values.value["text-file"]) : invalid("");
      const answers = await jsonFile(
        stringOption(options, "answers-file"),
        answerFieldsSchema,
        "--answers-file",
      );
      const fromId = stringOption(options, "from");
      const asUser = has(options, "as-user");
      const fields =
        answers.ok && answers.value !== undefined
          ? { answers: answers.value.answers, unanswered: answers.value.unanswered }
          : {};
      result = !values.ok
        ? values
        : !body.ok
          ? body
          : !answers.ok
            ? answers
            : asUser && fromId !== undefined
              ? invalid("--as-user cannot be combined with --from")
              : asUser
                ? await orchestrator.answerAsUser({
                    questionId: values.value["question"] ?? "",
                    text: body.value,
                    ...fields,
                  })
                : fromId === undefined
                  ? invalid("--from or --as-user is required")
                  : await orchestrator.answer({
                      fromId,
                      questionId: values.value["question"] ?? "",
                      text: body.value,
                      ...fields,
                    });
    } else if (
      command === "status" ||
      command === "reports" ||
      command === "notices" ||
      command === "questions"
    ) {
      const filter = scopeFilter(options, false);
      result = filter.ok
        ? command === "reports"
          ? orchestrator.reports(filter.value)
          : command === "notices"
            ? orchestrator.notices(filter.value)
            : command === "questions"
              ? orchestrator.questions(filter.value)
              : orchestrator.status(filter.value)
        : filter;
    } else if (command === "pause" || command === "resume" || command === "close") {
      const values = requireOptions(options, ["binding"]);
      result = values.ok
        ? command === "close"
          ? await orchestrator.close(
              values.value["binding"] ?? "",
              has(options, "confirm-absent"),
              has(options, "discard"),
            )
          : orchestrator.setPaused(values.value["binding"] ?? "", command === "pause")
        : values;
    } else if (command === "reconcile") {
      const filter = scopeFilter(options, true);
      result = filter.ok ? await orchestrator.reconcile(filter.value) : filter;
    } else {
      result = invalid(
        "Command must be doctor, manage, update check/prepare, scope import, repo list/fetch, supervisor/parent/child create, parent link/unlink, stage complete/start, send, report, reports, ask, answer, questions, notices, status, pause, resume, close, or reconcile",
      );
    }
  } catch (cause) {
    result = {
      ok: false,
      error: {
        code: cause instanceof MirrorError ? cause.code : "runtime_unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof MirrorError && cause.details !== undefined
          ? { details: cause.details }
          : {}),
      },
    };
  }
  const finalResult = result ?? invalid("Invalid update check tag");
  if (["send", "report", "stage complete", "ask", "answer"].includes(command))
    result = deliveryOutcome(finalResult);
  const completed = result ?? finalResult;
  print(completed, has(options, "json"));
  return exitCode(completed);
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
