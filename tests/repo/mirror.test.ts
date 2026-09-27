import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function holdFlock(path: string): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
  const child = Bun.spawn(
    [
      "flock",
      "--no-fork",
      "--exclusive",
      path,
      process.execPath,
      "-e",
      `process.stdout.write("1"); await new Response(Bun.stdin.stream()).text(); const {dlopen,FFIType}=await import("bun:ffi"); dlopen("libc.so.6",{close:{args:[FFIType.i32],returns:FFIType.i32}}).symbols.close(3); await Bun.write(${JSON.stringify(`${path}.released`)}, "");`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done || new TextDecoder().decode(ready.value) !== "1")
    throw new Error(await new Response(child.stderr).text());
  return child;
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

  test("a real process waits for the advisory lock and acquires after release", async () => {
    const world = await fixture();
    const path = mirrorPath(world.root, world.remote);
    await mkdir(join(world.root, ".omo/repos"), { recursive: true });
    const holder = await holdFlock(`${path}.lock`);
    const waiting = Promise.withResolvers<void>();
    const fetch = fetchMirror(world.root, world.remote, { onLockWait: waiting.resolve });
    await bounded(waiting.promise, "fetch did not contend on the advisory lock");
    holder.stdin.end();
    expect(await holder.exited).toBe(0);
    expect((await fetch).path).toBe(path);
    expect(await git(path, "fsck", "--full")).toBe("");
  });

  test("two production fetches serialize their git children", async () => {
    const world = await fixture();
    const mirror = await fetchMirror(world.root, world.remote);
    const harness = join(world.root, "fetch-serialization");
    const socketPath = join(harness, "upload.sock");
    await mkdir(harness);
    await writeFile(
      join(harness, "barrier.ts"),
      `import {createConnection} from "node:net"; const socket=createConnection(process.env.BARRIER_SOCKET ?? ""); await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject)}); socket.write("entered"); await new Promise<void>((resolve)=>socket.once("data",resolve));`,
    );
    await writeFile(
      join(harness, "upload-pack"),
      `#!/bin/sh\nBARRIER_SOCKET='${socketPath}' '${process.execPath}' '${join(harness, "barrier.ts")}'\nexec /usr/bin/git-upload-pack "$@"\n`,
      { mode: 0o700 },
    );
    await git(mirror.path, "config", "remote.origin.uploadpack", join(harness, "upload-pack"));
    const sockets: import("node:net").Socket[] = [];
    const firstEntry = Promise.withResolvers<void>();
    const secondEntry = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      sockets.push(socket);
      if (sockets.length === 1) firstEntry.resolve();
      if (sockets.length === 2) secondEntry.resolve();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const waiting = Promise.withResolvers<void>();
    const first = fetchMirror(world.root, world.remote);
    await bounded(firstEntry.promise, "first fetch did not enter git");
    const second = fetchMirror(world.root, world.remote, { onLockWait: waiting.resolve });
    await bounded(waiting.promise, "second production fetch did not wait");
    expect(sockets).toHaveLength(1);
    sockets[0]?.end("release");
    await bounded(secondEntry.promise, "second fetch did not enter after first completed");
    sockets[1]?.end("release");
    await Promise.all([first, second]);
    server.close();
  });

  test("two production first-clone contenders publish one valid mirror", async () => {
    const world = await fixture();
    const path = mirrorPath(world.root, world.remote);
    const harness = join(world.root, "clone-serialization");
    const bin = join(harness, "bin");
    const socketPath = join(harness, "upload.sock");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(harness, "barrier.ts"),
      `import { createConnection } from "node:net";\nconst socket = createConnection(process.env.BARRIER_SOCKET ?? "");\nawait new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });\nsocket.write("upload");\nawait new Promise<void>((resolve) => socket.once("data", () => resolve()));\n`,
    );
    await writeFile(
      join(harness, "upload-pack"),
      `#!/bin/sh\nBARRIER_SOCKET='${socketPath}' '${process.execPath}' '${join(harness, "barrier.ts")}'\nexec /usr/bin/git-upload-pack "$@"\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = -c ]; then shift 4; fi\nif [ "$1" = clone ]; then shift; exec /usr/bin/git clone --upload-pack='${join(harness, "upload-pack")}' "$@"; fi\nexec /usr/bin/git "$@"\n`,
      { mode: 0o700 },
    );
    const sockets: import("node:net").Socket[] = [];
    const firstEntry = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      sockets.push(socket);
      if (sockets.length === 1) firstEntry.resolve();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      BUN_EXE: process.execPath,
      BARRIER_SCRIPT: join(harness, "barrier.ts"),
      BARRIER_SOCKET: socketPath,
    };
    const first = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fetch-process.ts"), world.root, world.remote],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    await bounded(firstEntry.promise, "first clone did not enter git");
    const second = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fetch-process.ts"), world.root, world.remote],
      { env: { ...env, REPORT_WAIT: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    const waiting = await second.stderr.getReader().read();
    expect(new TextDecoder().decode(waiting.value)).toContain("WAITING");
    expect(sockets).toHaveLength(1);
    sockets[0]?.end("release");
    const [firstCode, secondCode, firstOut, secondOut] = await Promise.all([
      first.exited,
      second.exited,
      new Response(first.stdout).text(),
      new Response(second.stdout).text(),
    ]);
    expect({ firstCode, secondCode, firstOut, secondOut }).toMatchObject({
      firstCode: 0,
      secondCode: 0,
    });
    expect([JSON.parse(firstOut), JSON.parse(secondOut)]).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(sockets).toHaveLength(1);
    expect(await git(path, "fsck", "--full")).toBe("");
    server.close();
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
      `#!/bin/sh\nif [ "$1" = -c ]; then shift 4; fi\nif [ "$1" = clone ]; then\n  shift\n  exec /usr/bin/git clone --upload-pack="$BUN_EXE $BARRIER_SCRIPT" "$@"\nfi\nexec /usr/bin/git "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    let signalUpload = (): void => {};
    const uploadStarted = new Promise<void>((resolve) => {
      signalUpload = resolve;
    });
    let uploadSocket: import("node:net").Socket | undefined;
    const server = createServer((socket) => {
      uploadSocket = socket;
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
      uploadSocket?.end("release");
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

  test("a held advisory lock times out immediately when timeout is zero", async () => {
    const world = await fixture();
    const lockPath = `${mirrorPath(world.root, world.remote)}.lock`;
    await mkdir(join(world.root, ".omo/repos"), { recursive: true });
    const holder = await holdFlock(lockPath);
    try {
      await expect(
        bounded(
          fetchMirror(world.root, world.remote, { lockTimeoutMs: 0 }),
          "zero-timeout advisory lock did not return promptly",
        ),
      ).rejects.toMatchObject({ name: "MirrorError", code: "mirror_locked" });
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  });

  test("a held advisory lock respects a positive timeout", async () => {
    const world = await fixture();
    const lockPath = `${mirrorPath(world.root, world.remote)}.lock`;
    await mkdir(join(world.root, ".omo/repos"), { recursive: true });
    const holder = await holdFlock(lockPath);
    let waits = 0;
    try {
      await expect(
        fetchMirror(world.root, world.remote, {
          lockTimeoutMs: 20,
          onLockWait: () => {
            waits += 1;
          },
        }),
      ).rejects.toMatchObject({ name: "MirrorError", code: "mirror_locked" });
      expect(waits).toBe(1);
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  });

  test("SIGKILL releases the advisory lock and leaves no stale ownership", async () => {
    const world = await fixture();
    const path = mirrorPath(world.root, world.remote);
    await mkdir(join(world.root, ".omo/repos"), { recursive: true });
    const holder = await holdFlock(`${path}.lock`);
    const waiting = Promise.withResolvers<void>();
    const fetch = fetchMirror(world.root, world.remote, { onLockWait: waiting.resolve });
    await bounded(waiting.promise, "fetch did not wait for killed advisory holder");
    holder.kill("SIGKILL");
    await holder.exited;
    await writeFile(`${path}.lock.released`, "released\n");
    expect((await fetch).path).toBe(path);
    expect((await lstat(`${path}.lock`)).isFile()).toBe(true);
  });

  test("git retains the lock after worker and wrapper are killed", async () => {
    const world = await fixture();
    const mirror = await fetchMirror(world.root, world.remote);
    const harness = join(world.root, "worker-death");
    const socketPath = join(harness, "upload.sock");
    await mkdir(harness);
    await writeFile(
      join(harness, "barrier.ts"),
      `import {createConnection} from "node:net"; const socket=createConnection(process.env.BARRIER_SOCKET ?? ""); await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject)}); socket.write("entered"); await new Promise<void>((resolve)=>socket.once("data",resolve));`,
    );
    await writeFile(
      join(harness, "upload-pack"),
      `#!/bin/sh\nBARRIER_SOCKET='${socketPath}' '${process.execPath}' '${join(harness, "barrier.ts")}'\nexec /usr/bin/git-upload-pack "$@"\n`,
      { mode: 0o700 },
    );
    await git(mirror.path, "config", "remote.origin.uploadpack", join(harness, "upload-pack"));
    const sockets: import("node:net").Socket[] = [];
    const firstEntry = Promise.withResolvers<void>();
    const secondEntry = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      sockets.push(socket);
      if (sockets.length === 1) firstEntry.resolve();
      if (sockets.length === 2) secondEntry.resolve();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const worker = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fetch-process.ts"), world.root, world.remote],
      {
        env: { ...process.env, BARRIER_SOCKET: socketPath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await bounded(firstEntry.promise, "worker git child did not enter fetch");
    const children = await Bun.file(`/proc/${worker.pid}/task/${worker.pid}/children`).text();
    const wrapperPid = children.trim().split(/\s+/u).filter(Boolean).map(Number)[0];
    if (wrapperPid === undefined) throw new Error("Git wrapper process not found");
    process.kill(worker.pid, "SIGKILL");
    process.kill(wrapperPid, "SIGKILL");
    await worker.exited;
    const waiting = Promise.withResolvers<void>();
    const second = fetchMirror(world.root, world.remote, { onLockWait: waiting.resolve });
    await bounded(waiting.promise, "second contender did not observe inherited lock");
    expect(sockets).toHaveLength(1);
    sockets[0]?.end("release");
    await bounded(secondEntry.promise, "second git did not enter after inherited holder exited");
    sockets[1]?.end("release");
    await bounded(second, "second contender did not complete");
    server.close();
    for (const socket of sockets) socket.destroy();
  });

  test("missing advisory-lock capability returns a typed error", async () => {
    const world = await fixture();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fetch-process.ts"), world.root, world.remote],
      {
        env: { ...process.env, OLW_LIBC_PATH: join(world.root, "missing-libc.so") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      code: "mirror_lock_unreadable",
    });
  });

  test("legacy lock directories are preserved, ignored for acquisition, and reported", async () => {
    const world = await fixture();
    const path = mirrorPath(world.root, world.remote);
    const legacy = `${path}.lock`;
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "owner.json"), "legacy\n");
    expect((await fetchMirror(world.root, world.remote)).path).toBe(path);
    expect(await readFile(join(legacy, "owner.json"), "utf8")).toBe("legacy\n");
    await expect(listMirrors(world.root)).rejects.toMatchObject({
      name: "MirrorError",
      code: "mirror_legacy_lock",
      details: { path: legacy },
    });
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
