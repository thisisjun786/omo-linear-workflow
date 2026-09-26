import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMirror,
  fetchMirror,
  listMirrors,
  MirrorError,
  mirrorPath,
} from "../../src/repo/mirror";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["/bin/true"]);
  await child.exited;
  return child.pid;
}

async function fixture(): Promise<{ root: string; remote: string; seed: string }> {
  const root = await mkdtemp(join(tmpdir(), "olw-mirror-"));
  roots.push(root);
  const remote = join(root, "target.git");
  const seed = join(root, "seed");
  await git(root, "init", "--bare", remote);
  await git(root, "clone", remote, seed);
  await git(seed, "config", "user.name", "OLW Test");
  await git(seed, "config", "user.email", "olw@example.test");
  await writeFile(join(seed, "README.md"), "first\n");
  await git(seed, "add", "README.md");
  await git(seed, "commit", "-m", "first");
  await git(seed, "push", "origin", "HEAD:main");
  return { root, remote: `file://${remote}`, seed };
}

describe("fetch-only repository mirrors", () => {
  test("first fetch clones and a second fetch receives a new commit", async () => {
    const world = await fixture();
    const first = await fetchMirror(world.root, world.remote);
    expect(first.path).toBe(mirrorPath(world.root, world.remote));
    expect(await git(first.path, "rev-parse", "refs/heads/main")).toHaveLength(40);

    await writeFile(join(world.seed, "README.md"), "second\n");
    await git(world.seed, "commit", "-am", "second");
    const next = await git(world.seed, "rev-parse", "HEAD");
    await git(world.seed, "push", "origin", "HEAD:main");
    const second = await fetchMirror(world.root, world.remote);
    expect(await git(second.path, "rev-parse", "refs/heads/main")).toBe(next);
    expect((await listMirrors(world.root))[0]).toMatchObject({
      path: first.path,
      remote: world.remote,
      lastError: null,
    });
  });

  test("two concurrent first fetches serialize before clone and publish one valid mirror", async () => {
    const world = await fixture();
    const path = mirrorPath(world.root, world.remote);
    await mkdir(join(world.root, ".omo/repos"), { recursive: true });
    await mkdir(`${path}.lock`);
    await writeFile(
      join(`${path}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "a".repeat(24) }),
    );
    let releaseWaiters = (): void => {};
    const bothWaiting = new Promise<void>((resolve) => {
      releaseWaiters = resolve;
    });
    let waits = 0;
    const onLockWait = () => {
      waits += 1;
      if (waits === 2) releaseWaiters();
    };
    const first = fetchMirror(world.root, world.remote, { onLockWait });
    const second = fetchMirror(world.root, world.remote, { onLockWait });
    await bounded(bothWaiting, "concurrent fetches did not both wait for the lifecycle lock");
    await rm(`${path}.lock`, { recursive: true });
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.path)).toEqual([path, path]);
    expect(await git(path, "fsck", "--full")).toBe("");
    expect(
      (await readdir(join(world.root, ".omo/repos"))).filter((entry) => entry.includes(".tmp-")),
    ).toEqual([]);
  });

  test("a clone killed with its process group leaves no final mirror and one retry recovers", async () => {
    const world = await fixture();
    const path = mirrorPath(world.root, world.remote);
    const harness = join(world.root, "harness");
    const bin = join(harness, "bin");
    const socketPath = join(harness, "upload.sock");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(harness, "barrier.ts"),
      `import { createConnection } from "node:net";\nconst socket = createConnection(process.env.BARRIER_SOCKET ?? "");\nawait new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });\nsocket.write("upload");\nawait new Promise<void>((resolve) => socket.once("data", () => resolve()));\n`,
    );
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = clone ]; then\n  shift\n  exec /usr/bin/git clone --upload-pack="$BUN_EXE $BARRIER_SCRIPT" "$@"\nfi\nexec /usr/bin/git "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    let signalUpload = (): void => {};
    const uploadStarted = new Promise<void>((resolve) => {
      signalUpload = resolve;
    });
    const server = createServer((socket) => {
      socket.once("data", () => signalUpload());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fetch-process.ts"), world.root, world.remote],
      {
        detached: true,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          BUN_EXE: process.execPath,
          BARRIER_SCRIPT: join(harness, "barrier.ts"),
          BARRIER_SOCKET: socketPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await bounded(uploadStarted, "clone did not reach upload-pack barrier");
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await readdir(join(world.root, ".omo/repos", ".tmp"))).not.toEqual([]);
      process.kill(-child.pid, "SIGKILL");
      await child.exited;
    } finally {
      server.close();
    }
    expect(await Bun.file(path).exists()).toBe(false);
    const recovered = await fetchMirror(world.root, world.remote);
    expect(recovered.path).toBe(path);
    expect(await git(path, "fsck", "--full")).toBe("");
    expect(await readdir(join(world.root, ".omo/repos/.tmp"))).toEqual([]);
  });

  test("cleanup cannot confuse a crafted final mirror with another mirror's temporary clone", async () => {
    const world = await fixture();
    const first = await fetchMirror(world.root, world.remote);
    const owner = await deadPid();
    const hash = first.path.match(/-([a-f0-9]{12})\.git$/)?.[1];
    if (hash === undefined) throw new Error("mirror hash is missing");
    const source = world.remote.slice("file://".length).replace(/\.git$/, "");
    const craftedRemotePath = `${source}-${hash}.git.tmp-${owner}`;
    await git(world.root, "init", "--bare", craftedRemotePath);
    const crafted = await fetchMirror(world.root, `file://${craftedRemotePath}`);
    await ensureMirror(world.root, world.remote);
    expect(await Bun.file(join(crafted.path, "olw-mirror.json")).exists()).toBe(true);
    expect(await git(crafted.path, "fsck", "--full")).toBe("");
    expect((await listMirrors(world.root)).map((mirror) => mirror.path)).toContain(crafted.path);
  });

  test("concurrent stale-lock reclaimers never overlap or release a successor's lock", async () => {
    const world = await fixture();
    const mirror = await fetchMirror(world.root, world.remote);
    const lockPath = `${mirror.path}.lock`;
    const staleToken = "d".repeat(24);
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: await deadPid(), timestamp: 0, token: staleToken }),
    );
    await mkdir(`${lockPath}.stale-${staleToken}`);
    await mkdir(`${lockPath}.released-${staleToken}`);

    const harness = join(world.root, "reclaim-harness");
    const socketPath = join(harness, "fetch.sock");
    await mkdir(harness, { recursive: true });
    await writeFile(
      join(harness, "barrier.ts"),
      `import { createConnection } from "node:net";\nconst socket = createConnection(process.env.BARRIER_SOCKET ?? "");\nawait new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });\nsocket.write(String(process.pid));\nawait new Promise<void>((resolve) => socket.once("data", () => resolve()));\n`,
    );
    await writeFile(
      join(harness, "upload-pack"),
      `#!/bin/sh\nBARRIER_SOCKET='${socketPath}' '${process.execPath}' '${join(harness, "barrier.ts")}'\nexec /usr/bin/git-upload-pack "$@"\n`,
    );
    await chmod(join(harness, "upload-pack"), 0o700);
    await git(mirror.path, "config", "remote.origin.uploadpack", join(harness, "upload-pack"));
    const sockets: import("node:net").Socket[] = [];
    let signalFirstFetch = (): void => {};
    const firstFetch = new Promise<void>((resolve) => {
      signalFirstFetch = resolve;
    });
    let signalSecondFetch = (): void => {};
    const secondFetch = new Promise<void>((resolve) => {
      signalSecondFetch = resolve;
    });
    const server = createServer((socket) => {
      sockets.push(socket);
      if (sockets.length === 1) signalFirstFetch();
      if (sockets.length === 2) signalSecondFetch();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    let waits = 0;
    let signalBothWaiting = (): void => {};
    const bothWaiting = new Promise<void>((resolve) => {
      signalBothWaiting = resolve;
    });
    const onLockWait = () => {
      waits += 1;
      if (waits === 2) signalBothWaiting();
    };
    const first = fetchMirror(world.root, world.remote, { onLockWait });
    const second = fetchMirror(world.root, world.remote, { onLockWait });
    try {
      await bounded(bothWaiting, "reclaimers did not both observe the stale generation");
      await rm(`${lockPath}.stale-${staleToken}`, { recursive: true });
      await rm(`${lockPath}.released-${staleToken}`, { recursive: true });
      await bounded(firstFetch, "first reclaimer did not enter fetch");
      expect(sockets).toHaveLength(1);
      const firstOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        token: string;
      };
      sockets[0]?.end("continue");
      await bounded(secondFetch, "successor did not enter fetch after the first released");
      expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))).not.toMatchObject({
        token: firstOwner.token,
      });
      sockets[1]?.end("continue");
      await Promise.all([first, second]);
      expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  }, 15_000);

  test("an existing live lock causes bounded contention", async () => {
    const world = await fixture();
    const mirror = await ensureMirror(world.root, world.remote);
    await mkdir(`${mirror.path}.lock`);
    await writeFile(
      join(`${mirror.path}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "b".repeat(24) }),
    );
    expect(fetchMirror(world.root, world.remote, { lockTimeoutMs: 0 })).rejects.toMatchObject({
      code: "mirror_locked",
    });
  });

  test("reclaims a dead-pid lock", async () => {
    const world = await fixture();
    const mirror = await ensureMirror(world.root, world.remote);
    await mkdir(`${mirror.path}.lock`);
    await writeFile(
      join(`${mirror.path}.lock`, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, timestamp: 0, token: "c".repeat(24) }),
    );
    await fetchMirror(world.root, world.remote, { lockTimeoutMs: 0 });
    expect(await Bun.file(`${mirror.path}.lock`).exists()).toBe(false);
  });

  test("rejects credentials without putting them in an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-mirror-secret-"));
    roots.push(root);
    const secret = "super-secret";
    try {
      await ensureMirror(root, `https://user:${secret}@example.test/repo.git`);
      throw new Error("expected credential rejection");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MirrorError);
      expect(String(cause)).not.toContain(secret);
      expect(cause).toMatchObject({ code: "invalid_remote" });
    }
  });

  test("lists metadata without fetching", async () => {
    const world = await fixture();
    const mirror = await ensureMirror(world.root, world.remote);
    const before = await readFile(join(mirror.path, "olw-mirror.json"), "utf8");
    expect(await listMirrors(world.root)).toEqual([
      expect.objectContaining({ path: mirror.path, remote: world.remote, lastFetchTime: null }),
    ]);
    expect(await readFile(join(mirror.path, "olw-mirror.json"), "utf8")).toBe(before);
  });
});
