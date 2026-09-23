import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RpcClient } from "@code-yeongyu/senpi";
import { openRegistry } from "../src/core/store";
import { createHerdrClient } from "../src/herdr";
import { loadHerdrBuild, resolveHerdrArtifact } from "../src/herdr/artifact";
import { QaError } from "./qa-rpc";

export async function runQaCommand(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const [command, ...args] = argv;
  if (command === undefined) throw new QaError("QA command must not be empty");
  const executable =
    command === "herdr"
      ? (env["QA_HERDR_BINARY"] ??
        (await resolveHerdrArtifact(resolve(import.meta.dir, ".."))).binaryPath)
      : command;
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export async function checkedQaCommand(
  argv: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const result = await runQaCommand(argv, cwd, env);
  if (result.code !== 0) {
    throw new QaError(
      `${argv.join(" ")} exited ${result.code}: ${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

export async function prepareQaWorld() {
  if (process.env["HERDR_ENV"] !== "1") throw new QaError("Herdr QA requires HERDR_ENV=1");
  const installRoot = resolve(import.meta.dir, "..");
  const artifact = await resolveHerdrArtifact(installRoot);
  const scratch = await mkdtemp(join(installRoot, ".omo/evidence/qa-world-"));
  const controlRoot = join(scratch, "control");
  const repository = join(scratch, "fixture-repo");
  const sessionName = `olw-qa-${crypto.randomUUID().slice(0, 12)}`;
  const environment = {
    ...process.env,
    QA_HERDR_BINARY: process.env["QA_HERDR_BINARY"] ?? artifact.binaryPath,
    HERDR_SESSION: sessionName,
    HERDR_SOCKET_PATH: undefined,
    HERDR_CLIENT_SOCKET_PATH: undefined,
    OMO_CODING_AGENT_SESSION_DIR: join(scratch, "omo-sessions"),
  };
  await mkdir(controlRoot);
  await mkdir(repository);
  await cp(join(installRoot, "dist"), join(controlRoot, "dist"), { recursive: true });
  await cp(join(installRoot, "skills"), join(controlRoot, "skills"), { recursive: true });
  await cp(join(installRoot, "package.json"), join(controlRoot, "package.json"));
  await cp(join(installRoot, "vendor/herdr"), join(controlRoot, "vendor/herdr"), {
    recursive: true,
  });
  await mkdir(join(controlRoot, "patches"), { recursive: true });
  await cp(artifact.patchPath, join(controlRoot, artifact.manifest.patch));
  const fixtureBuild = await loadHerdrBuild(controlRoot);
  await cp(artifact.artifactDir, fixtureBuild.artifactDir, { recursive: true });
  await checkedQaCommand(
    [
      "/usr/bin/cp",
      "-al",
      "--",
      join(installRoot, "node_modules"),
      join(controlRoot, "node_modules"),
    ],
    installRoot,
  );
  await writeFile(join(repository, "README.md"), "# Isolated OMO initiative QA fixture\n");
  await writeFile(join(repository, ".gitignore"), ".omo/thread-tools/\n");
  await checkedQaCommand(["git", "init", "-b", "main"], repository);
  await checkedQaCommand(["git", "add", "README.md", ".gitignore"], repository);
  await checkedQaCommand(
    [
      "git",
      "-c",
      "user.name=OMO QA",
      "-c",
      "user.email=omo-qa@localhost",
      "commit",
      "-m",
      "test: initialize isolated fixture",
    ],
    repository,
  );
  const herdr = Bun.spawn([environment.QA_HERDR_BINARY, "--session", sessionName, "server"], {
    cwd: repository,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const ready = Promise.withResolvers<string>();
  const timer = setTimeout(
    () => ready.reject(new QaError("Herdr server readiness timeout")),
    30000,
  );
  const output = new Response(herdr.stdout).text();
  let log = "";
  const stderrTask = (async () => {
    let buffer = "";
    for await (const bytes of herdr.stderr) {
      const part = new TextDecoder().decode(bytes);
      log += part;
      buffer += part;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const match = /^api socket: (.+)$/.exec(line);
        if (match?.[1]) ready.resolve(match[1]);
        newline = buffer.indexOf("\n");
      }
    }
    ready.reject(new QaError(`Herdr exited before readiness: ${log}`));
  })();
  let herdrSocket: string;
  try {
    herdrSocket = await ready.promise;
  } catch (error) {
    herdr.kill("SIGTERM");
    await herdr.exited;
    await stderrTask;
    await output;
    await rm(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const worktrees: string[] = [];
  const workspaces: string[] = [];
  return {
    installRoot,
    scratch,
    controlRoot,
    repository,
    herdrSocket,
    environment,
    worktrees,
    workspaces,
    async cli(args: readonly string[]) {
      return runQaCommand(
        [
          "bun",
          join(controlRoot, "dist/cli.js"),
          "--root",
          controlRoot,
          "--herdr-socket",
          herdrSocket,
          ...args,
          "--json",
        ],
        controlRoot,
        { ...environment, HERDR_SOCKET_PATH: herdrSocket },
      );
    },
    async close(): Promise<void> {
      const failures: string[] = [];
      const dbPath = join(controlRoot, ".omo/state/registry.sqlite");
      const ownedSessions = new Set<string>();
      if (await Bun.file(dbPath).exists()) {
        const registry = openRegistry(dbPath);
        try {
          const bindings = registry.list();
          if (!bindings.ok) throw new QaError(bindings.error.message);
          for (const binding of bindings.value) {
            ownedSessions.add(binding.durableSessionId);
            if (binding.workspaceId === null) continue;
            const ledger = binding.checkout === null ? workspaces : worktrees;
            if (!ledger.includes(binding.workspaceId)) ledger.push(binding.workspaceId);
          }
        } finally {
          registry.close();
        }
      }
      const run = async (args: readonly string[]) => {
        const result = await runQaCommand(
          ["herdr", "--session", sessionName, ...args],
          repository,
          environment,
        );
        if (result.code !== 0) failures.push(`${args.join(" ")}: ${result.stderr}`);
      };
      const socketPath = join(controlRoot, ".omo/state/omo.sock");
      const hostExists = await lstat(socketPath).then(
        (stat) => stat.isSocket(),
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (hostExists) {
        const client = new RpcClient({ socketPath });
        try {
          await client.start();
          for (const session of await client.listSessions()) {
            if (session.durableSessionId && ownedSessions.has(session.durableSessionId)) {
              if (session.sessionPath) {
                const opened = await client.openSession({
                  sessionPath: session.sessionPath,
                  cwd: session.cwd,
                  retain_on_disconnect: false,
                });
                await client.closeSession(opened.sessionId);
              }
            }
          }
        } finally {
          await client.stop();
        }
      }
      const observer = createHerdrClient(herdrSocket);
      const activeWorkspaces = new Set<string>();
      try {
        for (const workspace of (await observer.snapshot()).workspaces)
          activeWorkspaces.add(workspace.workspaceId);
      } finally {
        observer.close();
      }
      for (const workspace of worktrees.toReversed()) {
        if (activeWorkspaces.has(workspace))
          await run(["worktree", "remove", "--workspace", workspace, "--trust-repository"]);
      }
      for (const workspace of workspaces.toReversed()) {
        if (activeWorkspaces.has(workspace)) await run(["workspace", "close", workspace]);
      }
      await run(["session", "stop", sessionName, "--json"]);
      await herdr.exited;
      await stderrTask;
      await output;
      if (hostExists) {
        const remaining = new RpcClient({ socketPath });
        try {
          await remaining.start();
          for (const session of await remaining.listSessions()) {
            if (
              session.cwd === controlRoot ||
              session.cwd.startsWith(`${controlRoot}/.omo/worktrees/`)
            ) {
              if (session.sessionPath) {
                const opened = await remaining.openSession({
                  sessionPath: session.sessionPath,
                  cwd: session.cwd,
                  retain_on_disconnect: false,
                });
                await remaining.closeSession(opened.sessionId);
              }
            }
          }
        } finally {
          await remaining.stop();
        }
        const stopped = await runQaCommand(
          [join(controlRoot, "node_modules/.bin/omo"), "host", "stop", "--socket", socketPath],
          controlRoot,
          environment,
        );
        if (stopped.code !== 0) failures.push(`OMO host stop: ${stopped.stdout} ${stopped.stderr}`);
      }
      await run(["session", "delete", sessionName, "--json"]);
      if (failures.length) {
        throw new QaError(
          `Cleanup failures; fixture retained at ${scratch}:\n${failures.join("\n")}`,
        );
      }
      await rm(scratch, { recursive: true, force: true });
      console.log("CLEANUP: QA worktrees, workspaces, Herdr server, OMO host and fixture removed");
    },
  };
}
