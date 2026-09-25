import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import { bindingSchema } from "../src/core/schema";
import { attach, idle } from "./qa-hierarchy";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const created = z.object({ binding: bindingSchema });
const toolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
function record(value: unknown) {
  const result = toolResult.parse(value);
  const text = result.content.find((part) => part.type === "text")?.text;
  assert.ok(text, "Real MCP result had no text");
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

async function main() {
  const installRoot = join(import.meta.dir, "..");
  const evidence = join(installRoot, ".omo/evidence/real-use-repairs/lina-143-live");
  const targets = z
    .object({
      project: z.object({
        id: z.string(),
        identifier: z.string(),
        url: z.string(),
        revision: z.string(),
      }),
      document: z.object({ id: z.string(), url: z.string(), revision: z.string() }),
      issue: z.object({ identifier: z.string(), id: z.string() }),
    })
    .parse(
      JSON.parse(
        await readFile(
          process.argv[2] ??
            join(installRoot, ".omo/evidence/real-use-repairs/lina-143-live-targets.json"),
          "utf8",
        ),
      ),
    );
  const writePlan =
    process.argv[3] === undefined
      ? undefined
      : z
          .object({
            projectId: z.string(),
            teamId: z.string(),
            nonce: z.string().uuid(),
            resumeJournal: z.string().optional(),
            createArguments: z.object({
              team: z.string(),
              project: z.string(),
              title: z.string(),
              description: z.string(),
              state: z.string(),
              assignee: z.null(),
              delegate: z.null(),
              priority: z.number(),
            }),
            update: z.object({ description: z.string() }),
            cleanup: z.object({
              state: z.string(),
              expectedStateType: z.string(),
              expectedStateName: z.string(),
            }),
          })
          .parse(JSON.parse(await readFile(process.argv[3], "utf8")));
  if (writePlan) {
    assert.equal(writePlan.projectId, targets.project.id);
    assert.equal(writePlan.createArguments.project, targets.project.id);
    assert.equal(writePlan.createArguments.team, writePlan.teamId);
  }
  const qa = await prepareQaWorld();
  const clients: RpcClient[] = [];
  const log: {
    result: string;
    root: string;
    roles: unknown[];
    externalWrites: number;
    write?: unknown;
    error?: string;
    cleanup?: string;
    cleanupError?: string;
  } = { result: "incomplete", root: qa.scratch, roles: [], externalWrites: 0 };
  let failure: unknown;
  const invoke = async (args: string[]) => {
    const result = await qa.cli(args);
    assert.equal(result.code, 0, JSON.stringify(result));
    return success.parse(JSON.parse(result.stdout)).value;
  };
  try {
    const builderPath = join(qa.controlRoot, "qa-profile-builder.ts");
    await cp(join(qa.installRoot, "src/host-profile.ts"), builderPath);
    const builder: typeof import("../src/host-profile") = await import(
      pathToFileURL(builderPath).href
    );
    const profilePath = await builder.createHostProfile(qa.controlRoot);
    const profile = z
      .object({ core: z.object({ extensions: z.array(z.string()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(await readFile(profilePath, "utf8")));
    const helper = join(qa.controlRoot, "qa-linear-extension.ts");
    await cp(join(qa.installRoot, "scripts/qa-linear-extension.ts"), helper);
    profile.core.extensions.push(helper);
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    await checkedQaCommand(
      [
        join(qa.controlRoot, "node_modules/.bin/omo"),
        "host",
        "ensure",
        "--launch-spec",
        profilePath,
        "--socket",
        join(qa.controlRoot, ".omo/state/omo.sock"),
        "--policy",
        "never",
      ],
      qa.controlRoot,
      { ...qa.environment, ...builder.runtimeCacheEnvironment(qa.controlRoot) },
    );
    const scope = {
      version: 1,
      source: "fixture",
      initiative: {
        id: "qa-linear-catalog",
        url: "linear://fixture/qa-linear-catalog",
        revision: "qa-r1",
      },
      projects: [
        {
          project: {
            id: targets.project.id,
            url: targets.project.url,
            revision: targets.project.revision,
          },
          issues: [
            {
              id: targets.issue.id,
              url: `https://linear.app/jun786/issue/${targets.issue.identifier}`,
              revision: "qa-r1",
            },
          ],
        },
      ],
      decisionRefs: [targets.document],
    };
    const path = join(qa.scratch, "scope.json");
    await writeFile(path, JSON.stringify(scope));
    const { digest } = z
      .object({ digest: z.string() })
      .parse(await invoke(["scope", "import", "--file", path, "--fixture"]));
    const supervisor = created.parse(
      await invoke([
        "supervisor",
        "create",
        "--initiative",
        "qa-linear-catalog",
        "--scope-digest",
        digest,
        "--designation",
        "live-linear-catalog-qa",
        "--execute",
        "--fixture",
      ]),
    ).binding;
    const parent = created.parse(
      await invoke([
        "parent",
        "create",
        "--supervisor",
        supervisor.id,
        "--project",
        targets.project.id,
        "--repo",
        qa.repository,
        "--base",
        "main",
      ]),
    ).binding;
    for (const binding of [supervisor, parent]) {
      const client = await attach(binding);
      clients.push(client);
      await idle(client);
      const dispositions: string[] = [];
      await client.prompt("/mcp status", {
        promptDisposition: (value) => dispositions.push(value),
      });
      assert.deepEqual(dispositions, ["handled"]);
      const tools = z.array(z.string()).parse(await client.requestExtension("oi.qa.linear.tools"));
      const before = z
        .array(z.string())
        .parse(await client.requestExtension("oi.qa.linear.active"));
      const wanted = ["mcp_linear_get_project", "mcp_linear_get_document", "mcp_linear_get_issue"];
      const searches: unknown[] = [];
      const reads: unknown[] = [];
      log.roles.push({ binding, before, tools, searches, reads });
      for (const name of wanted) {
        assert.ok(tools.includes(name));
        assert.ok(!before.includes(name));
      }
      for (const query of [
        { query: "mcp_linear_get_project" },
        { query: "Retrieve details of a specific project in Linear" },
        { query: "linear get project", source: "mcp" },
      ]) {
        const result = z
          .object({ details: z.object({ matched: z.array(z.string()) }) })
          .parse(await client.requestExtension("oi.qa.linear.search", query));
        assert.ok(
          result.details.matched.includes("mcp_linear_get_project"),
          JSON.stringify(result),
        );
        searches.push({ query, result });
      }
      assert.deepEqual(await client.requestExtension("oi.qa.linear.active"), before);
      const project = z
        .object({
          id: z.literal(targets.project.identifier),
          uuid: z.literal(targets.project.id),
          updatedAt: z.string(),
        })
        .passthrough()
        .parse(
          record(
            await client.requestExtension("oi.qa.linear.call", {
              tool: "mcp_linear_get_project",
              arguments: { query: targets.project.id, includeResources: true },
            }),
          ),
        );
      const document = z
        .object({
          id: z.literal(targets.document.id),
          content: z.string().min(1),
          updatedAt: z.string(),
        })
        .passthrough()
        .parse(
          record(
            await client.requestExtension("oi.qa.linear.call", {
              tool: "mcp_linear_get_document",
              arguments: { id: targets.document.id },
            }),
          ),
        );
      const evalResult = await client.requestExtension("oi.qa.linear.eval", {
        tool: "mcp_linear_get_issue",
        arguments: { id: targets.issue.identifier },
      });
      z.object({
        details: z.object({
          toolCallCount: z.literal(1),
          toolCalls: z
            .array(z.object({ name: z.literal("mcp_linear_get_issue"), ok: z.literal(true) }))
            .length(1),
          cells: z.array(z.object({ status: z.literal("complete") })).length(1),
        }),
      }).parse(evalResult);
      const issue = z
        .object({ id: z.literal(targets.issue.identifier), uuid: z.literal(targets.issue.id) })
        .passthrough()
        .parse(
          record(
            await client.requestExtension("oi.qa.linear.call", {
              tool: "mcp_linear_get_issue",
              arguments: { id: targets.issue.identifier },
            }),
          ),
        );
      const after = z.array(z.string()).parse(await client.requestExtension("oi.qa.linear.active"));
      const invocations = z
        .array(z.object({ name: z.string(), active: z.array(z.string()) }))
        .parse(await client.requestExtension("oi.qa.linear.invocations"));
      reads.push({ project, document, issue, evalResult, after, invocations });
      for (const name of wanted) {
        const calls = invocations.filter((call) => call.name === name);
        assert.ok(calls.length > 0, `No native invocation for ${name}`);
        for (const call of calls) assert.ok(call.active.includes(name), JSON.stringify(call));
      }
      assert.ok(!after.includes("mcp_linear_save_issue"));
      assert.notEqual((await client.reload()).cancelled, true);
      const reloaded = z
        .object({
          id: z.literal(targets.project.identifier),
          uuid: z.literal(targets.project.id),
          updatedAt: z.string(),
        })
        .parse(
          record(
            await client.requestExtension("oi.qa.linear.call", {
              tool: "mcp_linear_get_project",
              arguments: { query: targets.project.id },
            }),
          ),
        );
      reads.push({ reloaded });
      console.log(
        `QA_PHASE actual authenticated managed ${binding.assignment.role} readback succeeded`,
      );
      if (writePlan && binding.assignment.role === "parent") {
        assert.equal(issue["teamId"], writePlan.teamId);
        const search = z.object({ details: z.object({ matched: z.array(z.string()) }) }).parse(
          await client.requestExtension("oi.qa.linear.search", {
            query: "mcp_linear_save_issue",
            source: "mcp",
          }),
        );
        assert.ok(search.details.matched.includes("mcp_linear_save_issue"));
        const prior =
          writePlan.resumeJournal === undefined
            ? undefined
            : z
                .object({
                  nonce: z.literal(writePlan.nonce),
                  receipts: z.array(
                    z.object({
                      tool: z.string(),
                      args: z.record(z.string(), z.unknown()),
                      response: z.unknown().optional(),
                    }),
                  ),
                })
                .parse(JSON.parse(await readFile(writePlan.resumeJournal, "utf8")));
        if (prior) {
          assert.equal(prior.receipts[0]?.tool, "mcp_linear_save_issue");
          assert.deepEqual(prior.receipts[0]?.args, writePlan.createArguments);
          assert.ok(prior.receipts[0]?.response, "Cannot resume an unconfirmed create");
        }
        const journalPath = join(
          evidence,
          `write-${writePlan.nonce}${prior ? "-resume" : ""}.json`,
        );
        await mkdir(evidence, { recursive: true });
        const receipts: unknown[] = [];
        const writeEvidence = {
          binding,
          nonce: writePlan.nonce,
          search,
          priorJournal: writePlan.resumeJournal ?? null,
          receipts,
        };
        // A persisted nonce claim prevents an uncertain create from being replayed.
        await writeFile(journalPath, JSON.stringify(writeEvidence), { flag: "wx", mode: 0o600 });
        log.write = writeEvidence;
        const call = async (tool: string, args: Record<string, unknown>) => {
          const entry: { tool: string; args: Record<string, unknown>; response?: unknown } = {
            tool,
            args,
          };
          receipts.push(entry);
          await writeFile(journalPath, JSON.stringify(writeEvidence, null, 2));
          if (tool === "mcp_linear_save_issue") log.externalWrites += 1;
          entry.response = await client.requestExtension("oi.qa.linear.call", {
            tool,
            arguments: args,
          });
          await writeFile(journalPath, JSON.stringify(writeEvidence, null, 2));
          return record(entry.response);
        };
        const issueSchema = z.looseObject({
          id: z.string(),
          uuid: z.string().uuid(),
          projectId: z.literal(targets.project.id),
          teamId: z.literal(writePlan.teamId),
          title: z.literal(writePlan.createArguments.title),
          description: z.string(),
        });
        const saved = issueSchema.parse(
          prior
            ? record(prior.receipts[0]?.response)
            : await call("mcp_linear_save_issue", writePlan.createArguments),
        );
        assert.ok(saved.description.includes(writePlan.nonce));
        const ownedId = saved.uuid;
        try {
          const first = issueSchema.parse(await call("mcp_linear_get_issue", { id: ownedId }));
          assert.equal(first.uuid, ownedId);
          // Linear expands issue references in Markdown; read back its returned stored body.
          assert.equal(first.description, saved.description);
          await call("mcp_linear_save_issue", {
            id: ownedId,
            description: writePlan.update.description,
          });
          const updated = issueSchema.parse(await call("mcp_linear_get_issue", { id: ownedId }));
          assert.equal(updated.uuid, ownedId);
          assert.equal(updated.description, writePlan.update.description);
        } finally {
          const owned = issueSchema.parse(await call("mcp_linear_get_issue", { id: ownedId }));
          assert.equal(owned.uuid, ownedId);
          assert.ok(owned.description.includes(writePlan.nonce));
          await call("mcp_linear_save_issue", { id: ownedId, state: writePlan.cleanup.state });
          const canceled = z
            .object({
              uuid: z.literal(ownedId),
              status: z.literal(writePlan.cleanup.expectedStateName),
              statusType: z.literal(writePlan.cleanup.expectedStateType),
            })
            .parse(await call("mcp_linear_get_issue", { id: ownedId }));
          assert.equal(canceled.statusType, "canceled");
        }
        const writeCalls = z
          .array(z.object({ name: z.string(), active: z.array(z.string()) }))
          .parse(await client.requestExtension("oi.qa.linear.invocations"))
          .filter((entry) => entry.name === "mcp_linear_save_issue");
        assert.equal(writeCalls.length, prior ? 2 : 3);
        for (const entry of writeCalls) assert.ok(entry.active.includes(entry.name));
        reads.push({ writeCalls });
        console.log(
          `QA_PHASE authorized temporary issue ${ownedId} ${prior ? "reused" : "created"}, updated, read back and canceled`,
        );
      }
    }
    log.result = writePlan
      ? "write-pass"
      : "read-only-pass; allowed-write acceptance pending explicit permission";
  } catch (error) {
    failure = error;
    log.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log.result = "failed";
  } finally {
    for (const client of clients) await client.stop();
    try {
      await qa.close();
      log.cleanup = "owned roles, host, Herdr and fixture removed";
    } catch (error) {
      failure ??= error;
      log.cleanupError = String(error);
      log.result = "failed";
    }
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, writePlan ? "write-result.json" : "read-only.json"),
      `${JSON.stringify(log, null, 2)}\n`,
    );
  }
  if (failure) throw failure;
  console.log(
    writePlan
      ? "WRITE_PASS: actual managed parent create/update/readback/cancel; owned temporary issue and runtime cleaned"
      : "READ_ONLY_PASS: actual managed supervisor/parent MCP catalog, authentication and live reads; no external write",
  );
}

await main();
