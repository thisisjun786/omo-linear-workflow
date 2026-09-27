import { dlopen, FFIType, read } from "bun:ffi";
import { writeFile } from "node:fs/promises";

const O_RDWR = 2;
const O_CREAT = 64;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;

interface LockFunctions {
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly flock: (fd: number, operation: number) => number;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
}

function lockFunctions(): LockFunctions {
  const libc = dlopen(process.env["OLW_LIBC_PATH"] ?? "libc.so.6", {
    open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  return {
    open: libc.symbols.open,
    flock: libc.symbols.flock,
    close: libc.symbols.close,
    errno: () => {
      const pointer = libc.symbols.__errno_location();
      if (pointer === null) throw new Error("Could not read libc errno");
      return read.i32(pointer, 0);
    },
  };
}

const blockingFlockWorker = `
import { dlopen, FFIType } from "bun:ffi";
self.onmessage = (event) => {
  try {
    const libc = dlopen(event.data.libcPath, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    postMessage({ ok: libc.symbols.flock(event.data.fd, 2) === 0 });
  } catch (cause) {
    postMessage({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
`;

function waitForLock(fd: number): Promise<void> {
  const worker = new Worker(URL.createObjectURL(new Blob([blockingFlockWorker])), { smol: true });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ readonly ok: boolean; readonly error?: string }>) => {
      worker.terminate();
      if (event.data.ok) resolve();
      else reject(new Error(event.data.error ?? "Could not acquire host handoff lock"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
    worker.postMessage({ fd, libcPath: process.env["OLW_LIBC_PATH"] ?? "libc.so.6" });
  });
}

export async function withHostHandoffLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const flock = lockFunctions();
  const fd = flock.open(new TextEncoder().encode(`${path}\0`), O_RDWR | O_CREAT, 0o600);
  if (fd < 0) throw new Error(`Could not open host handoff lock (errno ${flock.errno()})`);
  let acquired = false;
  try {
    acquired = flock.flock(fd, LOCK_EX | LOCK_NB) === 0;
    if (!acquired) {
      if (flock.errno() !== EWOULDBLOCK)
        throw new Error(`Could not lock host handoff lock (errno ${flock.errno()})`);
      await waitForLock(fd);
      acquired = true;
    }
    await writeFile(`/proc/self/fd/${fd}`, `${process.pid}\n`);
    const outcome = await operation().then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    const releaseErrors: Error[] = [];
    if (flock.flock(fd, LOCK_UN) !== 0)
      releaseErrors.push(new Error(`Could not unlock host handoff lock (errno ${flock.errno()})`));
    acquired = false;
    if (flock.close(fd) !== 0)
      releaseErrors.push(new Error(`Could not close host handoff lock (errno ${flock.errno()})`));
    if (!outcome.ok) {
      if (releaseErrors.length > 0)
        throw new AggregateError(
          [outcome.cause, ...releaseErrors],
          "Host handoff and lock release failed",
        );
      throw outcome.cause;
    }
    if (releaseErrors.length > 0)
      throw new AggregateError(releaseErrors, "Host handoff lock release failed");
    return outcome.value;
  } finally {
    if (acquired) {
      flock.flock(fd, LOCK_UN);
      flock.close(fd);
    }
  }
}
