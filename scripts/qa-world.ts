import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@code-yeongyu/senpi";
import { scopeSnapshotSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { createHerdrClient } from "../src/herdr";
import { loadHerdrBuild, resolveHerdrArtifact } from "../src/herdr/artifact";
import { qaTempFiles, reapQaDaemons } from "./qa-cleanup";
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
  await mkdir(controlRoot);
  await cp(join(installRoot, "herdr-release.json"), join(controlRoot, "herdr-release.json"));
  const fixtureBuild = await loadHerdrBuild(controlRoot);
  await cp(artifact.artifactDir, fixtureBuild.artifactDir, { recursive: true });
  const fixtureArtifact = await resolveHerdrArtifact(controlRoot);
  const environment = {
    ...process.env,
    QA_HERDR_BINARY: fixtureArtifact.binaryPath,
    HERDR_SESSION: sessionName,
    HERDR_SOCKET_PATH: undefined,
    HERDR_CLIENT_SOCKET_PATH: undefined,
    OMO_CODING_AGENT_SESSION_DIR: join(scratch, "omo-sessions"),
    // Bun caches the temporary runtime-shim path; isolate CLI and host caches.
    // The host strips BUN_* but retains XDG_CACHE_HOME.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scratch, "bun-cache"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    TMPDIR: join(scratch, "tmp"),
  };
  await mkdir(environment.TMPDIR);
  const cleanup = {
    daemons: [] as Awaited<ReturnType<typeof reapQaDaemons>>,
    tempFiles: [] as string[],
    tempFilesRemoved: false,
  };
  await mkdir(repository);
  await cp(join(installRoot, "dist"), join(controlRoot, "dist"), { recursive: true });
  await cp(join(installRoot, "skills"), join(controlRoot, "skills"), { recursive: true });
  await cp(join(installRoot, "package.json"), join(controlRoot, "package.json"));
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
  async function startServer() {
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
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return { herdr, herdrSocket, output, stderrTask };
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer();
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  let upstreamHerdrSocket = server.herdrSocket;
  const herdrTraffic: unknown[] = [];
  const herdrTrafficListeners = new Set<(request: unknown) => void>();
  const tapPath = join(scratch, "herdr-tap.sock");
  const tap = createServer((downstream) => {
    const upstream = createConnection(upstreamHerdrSocket);
    let buffer = "";
    downstream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const request: unknown = JSON.parse(line);
          herdrTraffic.push(request);
          for (const listener of herdrTrafficListeners) listener(request);
        } catch {
          herdrTraffic.push({ invalidJson: line });
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => downstream.write(chunk));
    downstream.on("end", () => upstream.end());
    upstream.on("end", () => downstream.end());
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    tap.once("error", reject);
    tap.listen(tapPath, () => {
      tap.off("error", reject);
      resolve();
    });
  });
  const herdrSocket = tapPath;
  const worktrees: string[] = [];
  const workspaces: string[] = [];
  let repositoryMapping: Promise<{ readonly remote: string; readonly defaultBranch: "main" }>;
  const ownedRepositoryMapping = () => {
    repositoryMapping ??= (async () => {
      const remotePath = join(scratch, "fixture-remote.git");
      await checkedQaCommand(
        ["git", "clone", "--bare", repository, remotePath],
        scratch,
        environment,
      );
      return { remote: pathToFileURL(remotePath).href, defaultBranch: "main" as const };
    })();
    return repositoryMapping;
  };
  return {
    installRoot,
    scratch,
    controlRoot,
    repository,
    herdrSocket,
    environment,
    cleanup,
    herdrTraffic,
    onHerdrRequest(listener: (request: unknown) => void): () => void {
      herdrTrafficListeners.add(listener);
      return () => herdrTrafficListeners.delete(listener);
    },
    worktrees,
    workspaces,
    async writeOwnedScopeFixture(path: string, input?: unknown): Promise<void> {
      const source =
        input ?? JSON.parse(await Bun.file(join(installRoot, "tests/fixtures/scope.json")).text());
      const fixture = scopeSnapshotSchema.parse(source);
      const repository = await ownedRepositoryMapping();
      await writeFile(
        path,
        JSON.stringify({
          ...fixture,
          projects: fixture.projects.map((project) => ({ ...project, repository })),
        }),
      );
    },
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
    async restartHerdr(): Promise<void> {
      await checkedQaCommand(
        ["herdr", "--session", sessionName, "session", "stop", sessionName, "--json"],
        repository,
        environment,
      );
      await Promise.all([server.herdr.exited, server.stderrTask, server.output]);
      server = await startServer();
      upstreamHerdrSocket = server.herdrSocket;
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
            const ownedClone =
              binding.checkout?.kind === "owned-clone" &&
              binding.cwd.startsWith(`${controlRoot}/.omo/checkouts/`);
            const linkedWorktree =
              binding.cwd.startsWith(`${controlRoot}/.omo/worktrees/`) &&
              (binding.checkout?.originalRepoRoot === repository ||
                binding.checkout?.originalRepoRoot.startsWith(`${controlRoot}/.omo/checkouts/`));
            if (binding.checkout !== null && !ownedClone && !linkedWorktree) {
              throw new QaError(
                `Refusing to remove a worktree outside the QA fixture: ${binding.cwd}`,
              );
            }
            const ledger = binding.checkout === null || ownedClone ? workspaces : worktrees;
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
      const client = hostExists ? new RpcClient({ socketPath }) : undefined;
      const cleanupAttachments: string[] = [];
      try {
        if (client) {
          await client.start();
          for (const session of await client.listSessions()) {
            const owned =
              (session.durableSessionId !== undefined &&
                ownedSessions.has(session.durableSessionId)) ||
              session.cwd === controlRoot ||
              session.cwd.startsWith(`${controlRoot}/.omo/worktrees/`) ||
              session.cwd.startsWith(`${controlRoot}/.omo/checkouts/`);
            if (session.status !== "open" || !owned || !session.sessionPath) continue;
            // Hold our attachment while Herdr closes the frontend; never reopen a deleted cwd.
            const opened = await client.openSession({
              sessionPath: session.sessionPath,
              cwd: session.cwd,
              retain_on_disconnect: false,
            });
            cleanupAttachments.push(opened.sessionId);
          }
        }
        const observer = createHerdrClient(herdrSocket);
        const activeWorkspaces = new Set<string>();
        try {
          for (const workspace of (await observer.snapshot()).workspaces) {
            activeWorkspaces.add(workspace.workspaceId);
          }
        } finally {
          observer.close();
        }
        const removalOrder = worktrees.toReversed();
        for (const workspace of removalOrder) {
          if (activeWorkspaces.has(workspace))
            await run([
              "worktree",
              "remove",
              "--workspace",
              workspace,
              "--trust-repository",
              "--force",
            ]);
        }
        for (const workspace of workspaces.toReversed()) {
          if (activeWorkspaces.has(workspace)) await run(["workspace", "close", workspace]);
        }
        await run(["session", "stop", sessionName, "--json"]);
        await server.herdr.exited;
        await server.stderrTask;
        await server.output;
        if (client) {
          for (const sessionId of cleanupAttachments) {
            await client.closeSession(sessionId);
          }
        }
      } finally {
        await client?.stop();
      }
      if (hostExists) {
        const stopped = await runQaCommand(
          [
            join(controlRoot, "node_modules/.bin/omo"),
            "host",
            "stop",
            "--force",
            "--socket",
            socketPath,
          ],
          controlRoot,
          environment,
        );
        if (stopped.code !== 0) failures.push(`OMO host stop: ${stopped.stdout} ${stopped.stderr}`);
      }
      await run(["session", "delete", sessionName, "--json"]);
      await new Promise<void>((resolve) => tap.close(() => resolve()));
      cleanup.daemons = await reapQaDaemons(scratch);
      cleanup.tempFiles = await qaTempFiles(environment.TMPDIR);
      if (failures.length) {
        throw new QaError(
          `Cleanup failures; fixture retained at ${scratch}:\n${failures.join("\n")}`,
        );
      }
      await rm(scratch, { recursive: true, force: true });
      cleanup.tempFilesRemoved = true;
      console.log("CLEANUP: QA worktrees, workspaces, Herdr server, OMO host and fixture removed");
    },
  };
}
