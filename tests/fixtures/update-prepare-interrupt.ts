// Child process for the SIGINT tests in tests/update-prepare.test.ts. Fake remote git/gh.
// mode "install": the install step announces READY and blocks until prepare aborts it.
// mode "add": real `git worktree add` registers the worktree, then announces READY and blocks until
// aborted, returning 143 like a git killed by SIGTERM; worktree list/remove/prune run real git.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type PrepareRunner, prepareUpdate } from "../../src/update/prepare";

const [root = "", branch = "", mode = "install"] = process.argv.slice(2);
const realGit = async (argv: readonly string[], cwd: string) => {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};
const blockUntilAbort = async (signal: AbortSignal | undefined) => {
  if (signal === undefined) throw new Error("prepare did not pass an abort signal");
  const aborted = new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  process.stdout.write(`READY ${branch}\n`);
  await aborted;
};
const run: PrepareRunner = async (argv, options) => {
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  if (argv[1] === "pr" && argv[2] === "list") return ok("[]");
  if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url")
    return ok("https://github.com/thisisjun786/omo-linear-workflow.git\n");
  if (mode === "add" && argv[0] === "git") {
    if (argv[1] === "rev-parse") return realGit(["git", "rev-parse", "HEAD"], options.cwd);
    if (argv[1] === "worktree" && argv[2] === "add") {
      const added = await realGit(argv, options.cwd);
      if (added.code !== 0) return added;
      await blockUntilAbort(options.signal);
      return { code: 143, stdout: "", stderr: "killed by SIGTERM" };
    }
    if (argv[1] === "worktree") {
      const result = await realGit(argv, options.cwd);
      if (argv[2] === "remove" && result.code === 0)
        process.stdout.write(`REMOVED ${argv.at(-1)}\n`);
      return result;
    }
    return ok();
  }
  if (argv[1] === "rev-parse") return ok("abc123\n");
  if (argv[1] === "worktree" && argv[2] === "add") {
    const path = argv.at(-2) ?? "";
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify(
        {
          dependencies: { "@code-yeongyu/senpi": "2026.9.22-4", "omo-ai": "5.0.0-0.beta.84" },
        },
        null,
        2,
      ),
    );
  }
  if (argv[1] === "worktree" && argv[2] === "remove") {
    await rm(argv.at(-1) ?? "", { recursive: true, force: true });
    process.stdout.write(`REMOVED ${argv.at(-1)}\n`);
  }
  if (argv[0] === "pnpm") {
    await blockUntilAbort(options.signal);
    return { code: 130, stdout: "", stderr: "killed" };
  }
  return ok();
};
const result = await prepareUpdate(root, { run, ghBin: "gh" });
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
process.exitCode = !result.ok && result.error.code === "interrupted" ? 130 : 1;
