#!/usr/bin/env bun
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Result } from "./core/contracts";
import { resolveHerdrArtifact } from "./herdr/artifact";
import { Orchestrator } from "./orchestrator";

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
]);
const booleanFlags = new Set(["json", "fixture", "execute", "help", "confirm-absent"]);

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
    if (key === "evidence") {
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
  if (result.error.code.includes("uncertain")) return 4;
  if (result.error.code === "runtime_unavailable") return 3;
  return 2;
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

async function doctor(root: string, herdrSocket?: string): Promise<Result<unknown>> {
  const paths = new Orchestrator(root, herdrSocket).paths();
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

export async function runCli(argv: readonly string[]): Promise<number> {
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
          usage: "oi [--root PATH] [--herdr-socket PATH] COMMAND [OPTIONS] [--json]",
          commands: [
            "doctor",
            "scope import",
            "supervisor create",
            "parent create",
            "child create",
            "send",
            "report",
            "status",
            "pause",
            "resume",
            "close",
            "reconcile",
          ],
          options: {
            "scope import": "--file PATH [--fixture]",
            "supervisor create":
              "--initiative ID --scope-digest DIGEST --designation ID --execute [--fixture]",
            "parent create": "--supervisor BINDING --project ID --repo PATH --base REF",
            "child create": "--parent BINDING --issue ID",
            send: "--from BINDING --to BINDING --id ID --kind instruction|coordination --text-file PATH",
            report:
              "--from BINDING --id ID --outcome completed|blocked|failed --text-file PATH [--evidence REF]",
            status: "[--initiative ID]",
            pause: "--binding ID",
            resume: "--binding ID",
            close: "--binding ID [--confirm-absent]",
            reconcile: "--initiative ID",
          },
        },
      },
      has(options, "json"),
    );
    return 0;
  }
  const root = resolve(stringOption(options, "root") ?? join(import.meta.dir, ".."));
  const orchestrator = new Orchestrator(root, stringOption(options, "herdr-socket"));
  let result: Result<unknown>;
  const command = words.join(" ");
  try {
    if (command === "doctor") {
      result = await doctor(root, stringOption(options, "herdr-socket"));
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
      const values = requireOptions(options, ["supervisor", "project", "repo", "base"]);
      result = values.ok
        ? await orchestrator.createParent({
            supervisorId: values.value["supervisor"] ?? "",
            projectId: values.value["project"] ?? "",
            repo: values.value["repo"] ?? "",
            base: values.value["base"] ?? "",
          })
        : values;
    } else if (command === "child create") {
      const values = requireOptions(options, ["parent", "issue"]);
      result = values.ok
        ? await orchestrator.createChild({
            parentId: values.value["parent"] ?? "",
            issueId: values.value["issue"] ?? "",
          })
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
      result =
        values.ok && outcome?.success && body.ok
          ? await orchestrator.report({
              fromId: values.value["from"] ?? "",
              messageId: values.value["id"] ?? "",
              outcome: outcome.data,
              evidence: evidence(options),
              text: body.value,
            })
          : !values.ok
            ? values
            : !body.ok
              ? body
              : invalid("--outcome must be completed, blocked, or failed");
    } else if (command === "status") {
      result = orchestrator.status(stringOption(options, "initiative"));
    } else if (command === "pause" || command === "resume" || command === "close") {
      const values = requireOptions(options, ["binding"]);
      result = values.ok
        ? command === "close"
          ? await orchestrator.close(values.value["binding"] ?? "", has(options, "confirm-absent"))
          : orchestrator.setPaused(values.value["binding"] ?? "", command === "pause")
        : values;
    } else if (command === "reconcile") {
      const values = requireOptions(options, ["initiative"]);
      result = values.ok ? await orchestrator.reconcile(values.value["initiative"] ?? "") : values;
    } else {
      result = invalid(
        "Command must be doctor, scope import, supervisor/parent/child create, send, report, status, pause, resume, close, or reconcile",
      );
    }
  } catch (cause) {
    result = {
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
  print(result, has(options, "json"));
  return exitCode(result);
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
